// Drives the server's workspace-wide index (see server/src/workspace.ts) so find-references,
// rename and workspace-symbol-search cover the whole project, not just open editors. File
// discovery is delegated to vscode.workspace.findFiles rather than re-implemented here: it's
// VS Code's own optimized, excludes-aware search (honors files.exclude/search.exclude), so
// reusing it avoids duplicating that traversal — and worse, duplicating it *badly*.
import * as vscode from 'vscode';
import { LanguageClient } from 'vscode-languageclient/node';
import packageJson from '../package.json';

// Built from package.json's own "fasm" language contribution rather than a second hardcoded
// list, so the two can't silently drift apart when a file extension is added/removed there.
const FASM_EXTENSIONS = packageJson.contributes.languages[0].extensions.map((ext) => ext.replace(/^\./, ''));
export const FASM_FILE_GLOB = `**/*.{${FASM_EXTENSIONS.join(',')}}`;

export function createFasmFileWatcher(): vscode.FileSystemWatcher {
  return vscode.workspace.createFileSystemWatcher(FASM_FILE_GLOB);
}

export async function indexWorkspace(client: LanguageClient): Promise<void> {
  const files = await vscode.workspace.findFiles(FASM_FILE_GLOB);
  await client.sendNotification('fasm2Studio/indexWorkspaceFiles', {
    uris: files.map((f) => f.toString()),
  });
}
