// Build-output/listing-file path derivation and dialect detection — plain "where do things live
// on disk" helpers shared by task construction (taskProvider.ts), the debug adapter, and the
// status bar, none of the latter two otherwise touching VS Code's Task API at all.
import * as path from 'path';
import * as vscode from 'vscode';
import { fasmConfig } from './config';
import { detectDialect } from './dialect';
import { Dialect } from './types';

function defaultOutputFor(sourceFsPath: string): string {
  const { dir, name } = path.parse(sourceFsPath);
  return path.join(dir, name);
}

/** fasm2Studio.buildOutputPath, resolved against the source file's own directory (as documented),
 * not the workspace root — so e.g. "../bin/cc" from a source file in "src/" lands in "<root>/bin/",
 * letting build/debug output be redirected somewhere already covered by a project's .gitignore
 * instead of sitting next to the source it was built from. */
function configuredOutputFor(sourceFsPath: string): string | undefined {
  const configured = fasmConfig().get<string>('buildOutputPath', '').trim();
  if (!configured) return undefined;
  return path.isAbsolute(configured) ? configured : path.resolve(path.dirname(sourceFsPath), configured);
}

export function getDefaultOutputPath(sourceFsPath: string): string {
  return configuredOutputFor(sourceFsPath) ?? defaultOutputFor(sourceFsPath);
}

export function getListingPath(outputFsPath: string): string {
  return `${outputFsPath}.lst`;
}

export async function dialectFor(sourceFsPath: string, override?: Dialect): Promise<Dialect> {
  if (override) return override;
  const fallback = fasmConfig().get<Dialect>('defaultDialect', 'fasm2');
  try {
    const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(sourceFsPath));
    return detectDialect(Buffer.from(bytes).toString('utf8'), fallback);
  } catch {
    return fallback;
  }
}
