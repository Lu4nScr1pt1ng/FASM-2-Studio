// "FASM: Clean" — removes what Build wrote.
//
// A build drops its binary next to the source (or wherever fasm2Studio.buildOutputPath points),
// and a debug build drops a .lst listing beside that. Neither has an extension on most platforms,
// so they are easy to leave behind and easy to mistake for source when they show up in a diff.
// Nothing in the extension removed them, which is a strange gap for a toolchain integration.
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

export async function cleanBuildOutput(entryFile: string): Promise<void> {
  const candidates = buildArtifacts(entryFile).map((fsPath) => vscode.Uri.file(fsPath));
  const present: vscode.Uri[] = [];
  for (const uri of candidates) {
    if (await exists(uri)) present.push(uri);
  }

  if (present.length === 0) {
    void vscode.window.showInformationMessage(`${MESSAGE_PREFIX}nothing to clean — no build output for this file.`);
    return;
  }

  const removed: string[] = [];
  for (const uri of present) {
    try {
      await remove(uri);
      removed.push(vscode.workspace.asRelativePath(uri, false));
    } catch (err) {
      void vscode.window.showErrorMessage(`${MESSAGE_PREFIX}could not delete ${uri.fsPath}: ${(err as Error).message}`);
      return;
    }
  }

  void vscode.window.showInformationMessage(`${MESSAGE_PREFIX}removed ${removed.join(', ')}.`);
}
