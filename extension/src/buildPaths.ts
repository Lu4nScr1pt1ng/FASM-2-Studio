// Build-output/listing-file path derivation and dialect detection — plain "where do things live
// on disk" helpers shared by task construction (taskProvider.ts), the debug adapter, and the
// status bar, none of the latter two otherwise touching VS Code's Task API at all.
import * as path from 'path';
import * as vscode from 'vscode';
import { fasmConfig } from './config';
import { detectDialect } from './dialect';
import { Dialect } from './types';

/** On Windows, a program with no file extension at all cannot be launched by name-and-full-path
 * the way Run and Debug both need to: cmd.exe's PATHEXT search only appends an extension to a bare
 * command name typed without a path, never to an already-fully-qualified one, so even
 * `spawn('C:\...\prog', ..., { shell: true })` answers "'C:\...\prog' is not recognized as an
 * internal or external command" for a real, existing, perfectly valid PE — confirmed directly, the
 * same way as every other Windows-specific fix in this codebase. gdb is unaffected (it launches the
 * process itself via the Win32 debugging API, not through cmd.exe), which is why this only ever
 * showed up as "Run" silently doing nothing, never as a debug launch failing to start. */
function defaultOutputFor(sourceFsPath: string): string {
  const { dir, name } = path.parse(sourceFsPath);
  const stem = path.join(dir, name);
  return process.platform === 'win32' ? `${stem}.exe` : stem;
}

/** fasm2Studio.buildOutputPath, resolved against the source file's own directory (as documented),
 * not the workspace root — so e.g. "../bin/cc" from a source file in "src/" lands in "<root>/bin/",
 * letting build/debug output be redirected somewhere already covered by a project's .gitignore
 * instead of sitting next to the source it was built from. */
function configuredOutputFor(sourceFsPath: string): string | undefined {
  const configured = fasmConfig(vscode.Uri.file(sourceFsPath)).get<string>('buildOutputPath', '').trim();
  if (!configured) return undefined;
  return path.isAbsolute(configured) ? configured : path.resolve(path.dirname(sourceFsPath), configured);
}

export function getDefaultOutputPath(sourceFsPath: string): string {
  return configuredOutputFor(sourceFsPath) ?? defaultOutputFor(sourceFsPath);
}

/**
 * Where fasm2's own bundled listing macro actually writes: `virtual as 'lst'` *replaces* the
 * output's extension rather than appending to it, so "hello.exe" produces "hello.lst", not
 * "hello.exe.lst" — confirmed against a real build, not just read out of listing.inc. Simply
 * appending happened to still land on the right file as long as the output itself had no
 * extension (replacing and appending coincide when there is nothing to replace), which was true
 * of every output path this function was ever called with — until getDefaultOutputPath started
 * adding ".exe" on Windows, at which point "the expected listing file was not found" started
 * showing up for every Windows debug launch even though the build had just written one, one
 * extension short of where this was looking.
 */
export function getListingPath(outputFsPath: string): string {
  const { dir, name } = path.parse(outputFsPath);
  return path.join(dir, `${name}.lst`);
}

export async function dialectFor(sourceFsPath: string, override?: Dialect): Promise<Dialect> {
  if (override) return override;
  const uri = vscode.Uri.file(sourceFsPath);
  const fallback = fasmConfig(uri).get<Dialect>('defaultDialect', 'fasm2');
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    return detectDialect(Buffer.from(bytes).toString('utf8'), fallback);
  } catch {
    return fallback;
  }
}

/**
 * The same detection against a document's *live* buffer rather than what is last saved to disk.
 * Used by the status bar, which would otherwise keep reporting the old dialect until save for the
 * one edit that changes the answer — typing an `end macro`/`namespace`/`iterate` into a file that
 * had no fasm2 marker before is precisely when the reported dialect flips.
 */
export function dialectForDocument(document: vscode.TextDocument): Dialect {
  const fallback = fasmConfig(document.uri).get<Dialect>('defaultDialect', 'fasm2');
  return detectDialect(document.getText(), fallback);
}
