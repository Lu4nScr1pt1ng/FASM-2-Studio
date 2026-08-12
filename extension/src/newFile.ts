// "FASM: New File" — writes a program that already builds and runs.
//
// The walkthrough's third step says to open a .asm file and press the play button, which assumes
// the user has one. Someone installing this extension to learn fasm has neither the file nor the
// boilerplate: which `format` line their OS needs, that ELF wants `segment` while PE wants
// `section`, and how to exit without faulting are all things you only know once you have already
// written a program. The snippets cover the same ground, but they can only be reached from inside
// a file that already exists and is already recognized as FASM.

import * as path from 'path';
import * as vscode from 'vscode';
import { MESSAGE_PREFIX } from './config';
import { templatesFor, uniqueFileName } from './newFileTemplates';

async function existingNames(folder: vscode.Uri): Promise<Set<string>> {
  try {
    return new Set((await vscode.workspace.fs.readDirectory(folder)).map(([name]) => name));
  } catch {
    return new Set();
  }
}

/** Which folder a new file should land in: the active file's own folder when there is one (that is
 * where the user is working), otherwise the single workspace folder, otherwise ask. */
async function targetFolder(): Promise<vscode.Uri | undefined> {
  const active = vscode.window.activeTextEditor?.document.uri;
  if (active && active.scheme === 'file' && vscode.workspace.getWorkspaceFolder(active)) {
    return vscode.Uri.file(path.dirname(active.fsPath));
  }
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 1) return folders[0].uri;
  if (folders.length > 1) {
    const picked = await vscode.window.showWorkspaceFolderPick({ placeHolder: 'Where should the new file go?' });
    return picked?.uri;
  }
  return undefined;
}

export function registerNewFile(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('fasm2Studio.newFile', async () => {
      const template = await vscode.window.showQuickPick(templatesFor(process.platform), {
        placeHolder: 'Which kind of program?',
        matchOnDetail: true,
      });
      if (!template) return;

      const folder = await targetFolder();
      // No folder open at all — there is nowhere to put a file without asking, and an untitled
      // buffer would be worse than it looks: Build/Run/Debug all derive their paths from the
      // document's own fsPath, which an unsaved document does not have.
      const uri = folder
        ? vscode.Uri.joinPath(folder, uniqueFileName(await existingNames(folder), template.fileName))
        : await vscode.window.showSaveDialog({
            title: 'New FASM file',
            filters: { 'FASM source': ['asm', 'inc', 'fasm'] },
            saveLabel: 'Create',
          });
      if (!uri) return;

      try {
        await vscode.workspace.fs.writeFile(uri, Buffer.from(template.content, 'utf8'));
      } catch (err) {
        void vscode.window.showErrorMessage(`${MESSAGE_PREFIX}could not create ${uri.fsPath}: ${(err as Error).message}`);
        return;
      }

      const document = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(document);
    }),
  );
}
