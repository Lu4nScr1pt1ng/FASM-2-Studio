// "FASM: Clean" — removes what Build wrote.
//
// A build drops its binary next to the source (or wherever fasm2Studio.buildOutputPath points),
// and a debug build drops a .lst listing beside that. The default output has no extension on most
// platforms (Windows is the exception — see getDefaultOutputPath), so both are easy to leave
// behind and easy to mistake for source when they show up in a diff. Nothing in the extension
// removed them, which is a strange gap for a toolchain integration.
//
// Deletion goes through the trash rather than being permanent: these are derived files, but the
// output path is user-configurable, and a mistyped fasm2Studio.buildOutputPath pointing at
// something that matters should be recoverable.

import * as vscode from 'vscode';
import { getDefaultOutputPath, getListingPath } from './buildPaths';
import { MESSAGE_PREFIX } from './config';

async function exists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

/** The artifacts a build of `entryFile` produces: the output binary, and the listing a debug build
 * writes alongside it. */
export function buildArtifacts(entryFile: string): string[] {
  const output = getDefaultOutputPath(entryFile);
  return [output, getListingPath(output)];
}

async function remove(uri: vscode.Uri): Promise<void> {
  try {
    await vscode.workspace.fs.delete(uri, { useTrash: true });
  } catch {
    // Not every filesystem has a trash (remote workspaces and some Linux mounts don't) — VS Code
    // reports that as a failed delete rather than falling back on its own.
    await vscode.workspace.fs.delete(uri, { useTrash: false });
  }
}

/**
 * Removes one entry point's artifacts, returning the workspace-relative paths actually removed.
 *
 * Reports its own deletion failures (the one thing the caller cannot phrase better) but says
 * nothing about success — cleaning a multi-file explorer selection is one gesture, and it should
 * produce one message rather than a popup per file. See cleanBuildOutputs.
 */
export async function cleanBuildOutput(entryFile: string): Promise<string[]> {
  const candidates = buildArtifacts(entryFile).map((fsPath) => vscode.Uri.file(fsPath));
  const present: vscode.Uri[] = [];
  for (const uri of candidates) {
    if (await exists(uri)) present.push(uri);
  }

  const removed: string[] = [];
  for (const uri of present) {
    try {
      await remove(uri);
      removed.push(vscode.workspace.asRelativePath(uri, false));
    } catch (err) {
      void vscode.window.showErrorMessage(`${MESSAGE_PREFIX}could not delete ${uri.fsPath}: ${(err as Error).message}`);
      return removed;
    }
  }

  return removed;
}

/** Cleans every given entry point and reports the whole gesture's outcome once. */
export async function cleanBuildOutputs(entryFiles: readonly string[]): Promise<void> {
  if (entryFiles.length === 0) return;

  const removed: string[] = [];
  for (const entryFile of entryFiles) {
    removed.push(...(await cleanBuildOutput(entryFile)));
  }

  if (removed.length === 0) {
    // Phrased for the number of files asked about, since "no build output for this file" reads as
    // a mistake when the user selected six of them.
    const subject = entryFiles.length === 1 ? 'this file' : 'the selected files';
    void vscode.window.showInformationMessage(`${MESSAGE_PREFIX}nothing to clean — no build output for ${subject}.`);
    return;
  }

  void vscode.window.showInformationMessage(`${MESSAGE_PREFIX}removed ${removed.join(', ')}.`);
}
