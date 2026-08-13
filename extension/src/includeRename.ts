// Renaming or moving a file in the explorer, and having every `include` that named it follow.
//
// This hooks onWillRenameFiles rather than onDidRenameFiles, for two reasons that both come down to
// asking the question while it still has an answer. The include graph the server holds describes
// where the files are *now*: after the rename, the watcher has already begun retracting the old
// path, and "who includes this file?" starts coming back empty for the very file being moved. And
// an edit returned from here is applied before the rename happens, so a file that is both moved and
// edited — a fragment carrying its own relative includes into a new directory — is edited where it
// still is and then moved with the correction already in it.
//
// No workspace-trust gate: this only reads the index and writes text into the user's own files.
// Nothing here spawns the assembler, which is the thing trust exists to withhold.

import * as path from 'path';
import * as vscode from 'vscode';
import { LanguageClient, WorkspaceEdit as LspWorkspaceEdit } from 'vscode-languageclient/node';
import { fasmConfig, MESSAGE_PREFIX } from './config';
import { updatePromptMessage } from './includeRenamePrompt';
import { FASM_FILE_GLOB } from './workspaceIndexer';

/** fasm2Studio.updateIncludesOnFileMove. */
export type UpdateIncludesMode = 'prompt' | 'always' | 'never';

const SETTING = 'updateIncludesOnFileMove';

interface FileRename {
  oldUri: string;
  newUri: string;
}

/**
 * Expands a rename of a *directory* into the fasm files inside it.
 *
 * VS Code reports a moved folder as one rename of the folder itself, and no `include` resolves to
 * a directory — so without this, the single most sweeping way to break a project's include paths
 * (drag a folder somewhere else) would be the one case that went unhandled. The old path still
 * exists at this point, which is what makes both the stat and the scan possible at all.
 */
async function expandDirectoryRename(rename: FileRename): Promise<FileRename[]> {
  const oldUri = vscode.Uri.parse(rename.oldUri);
  let isDirectory: boolean;
  try {
    isDirectory = (await vscode.workspace.fs.stat(oldUri)).type === vscode.FileType.Directory;
  } catch {
    return [rename];
  }
  if (!isDirectory) return [rename];

  const newUri = vscode.Uri.parse(rename.newUri);
  const contained = await vscode.workspace.findFiles(new vscode.RelativePattern(oldUri, FASM_FILE_GLOB));
  return contained.map((file) => ({
    oldUri: file.toString(),
    newUri: vscode.Uri.joinPath(newUri, path.relative(oldUri.fsPath, file.fsPath).split(path.sep).join('/')).toString(),
  }));
}

/** Whether to go ahead, asking only when the setting says to — and offering the two answers that
 * mean "stop asking", since a prompt on every rename is its own kind of nuisance. */
async function confirm(mode: UpdateIncludesMode, fileCount: number, editCount: number): Promise<boolean> {
  if (mode !== 'prompt') return mode === 'always';

  const update = 'Update';
  const skip = 'Skip';
  const always = 'Always update';
  const never = 'Never update';
  const choice = await vscode.window.showInformationMessage(
    `${MESSAGE_PREFIX}${updatePromptMessage(fileCount, editCount)}`,
    update,
    skip,
    always,
    never,
  );

  // Global on purpose: whether one wants renames to fix up includes is a habit, not a property of
  // a project — the same reasoning the compiler paths are written globally under.
  if (choice === always || choice === never) {
    await fasmConfig().update(SETTING, choice === always ? 'always' : 'never', vscode.ConfigurationTarget.Global);
  }
  return choice === update || choice === always;
}

async function includeEditsFor(
  client: LanguageClient,
  files: readonly { oldUri: vscode.Uri; newUri: vscode.Uri }[],
): Promise<vscode.WorkspaceEdit | undefined> {
  const mode = fasmConfig().get<UpdateIncludesMode>(SETTING, 'prompt');
  if (mode === 'never') return undefined;

  const expanded = (
    await Promise.all(
      files.map((file) => expandDirectoryRename({ oldUri: file.oldUri.toString(), newUri: file.newUri.toString() })),
    )
  ).flat();
  if (expanded.length === 0) return undefined;

  const edit = await client.sendRequest<Required<Pick<LspWorkspaceEdit, 'changes'>>>('fasm2Studio/includeRenameEdits', {
    renames: expanded,
  });

  const fileCount = Object.keys(edit.changes).length;
  if (fileCount === 0) return undefined;
  const editCount = Object.values(edit.changes).reduce((total, edits) => total + edits.length, 0);

  if (!(await confirm(mode, fileCount, editCount))) return undefined;
  return client.protocol2CodeConverter.asWorkspaceEdit(edit);
}

export function registerIncludeRename(context: vscode.ExtensionContext, getClient: () => LanguageClient | undefined): void {
  context.subscriptions.push(
    vscode.workspace.onWillRenameFiles((event) => {
      const client = getClient();
      if (!client) return;
      // waitUntil holds the rename open until this resolves, so every failure path has to end in a
      // resolved promise: a rejection here would leave VS Code reporting that the rename itself
      // failed, over a feature that is only ever an assist to it.
      event.waitUntil(
        includeEditsFor(client, event.files).catch((err: unknown) => {
          client.outputChannel.appendLine(
            `${MESSAGE_PREFIX}could not work out the include updates for this rename: ${err instanceof Error ? err.message : String(err)}`,
          );
          return undefined;
        }),
      );
    }),
  );
}
