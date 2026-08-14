// "FASM: Open Build Output in Hex Editor" — looks at the bytes a build actually produced.
//
// Assembly is the one language where the output file is something you routinely need to read: a
// hand-built PE/ELF header, a boot sector that has to be exactly 512 bytes ending in 0x55AA, a
// data table you laid out by hand. The extension already knows precisely where a build writes
// (getDefaultOutputPath, honouring fasm2Studio.buildOutputPath), so the only thing standing
// between the user and those bytes was knowing the path and finding the right "Open With".
//
// The hex editor itself is Microsoft's, not built in, so a machine without it gets an offer to
// install rather than VS Code's raw "no editor for this file" error.

import * as path from 'path';
import * as vscode from 'vscode';
import { LanguageClient } from 'vscode-languageclient/node';
import { activeFasmEditor, buildableFsPath, NO_ACTIVE_FASM_FILE_MESSAGE } from './activeEditor';
import { getDefaultOutputPath } from './buildPaths';
import { MESSAGE_PREFIX } from './config';
import { resolveEntryPointFsPath } from './entryPointResolver';

const HEX_EDITOR_EXTENSION_ID = 'ms-vscode.hexeditor';
/** The custom-editor view type the Hex Editor registers; what `vscode.openWith` selects it by. */
const HEX_EDITOR_VIEW_TYPE = 'hexEditor.hexedit';

async function exists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

/**
 * Makes sure the Hex Editor is installed, offering to install it if not.
 *
 * Returns false when it is still unavailable afterwards, in which case the caller has already had
 * its say — nothing further is shown, since declining an install is an answer rather than an error.
 */
async function ensureHexEditor(): Promise<boolean> {
  if (vscode.extensions.getExtension(HEX_EDITOR_EXTENSION_ID)) return true;

  const install = 'Install Hex Editor';
  const choice = await vscode.window.showInformationMessage(
    `${MESSAGE_PREFIX}viewing build output needs Microsoft's Hex Editor extension, which isn't installed.`,
    install,
  );
  if (choice !== install) return false;

  try {
    await vscode.commands.executeCommand('workbench.extensions.installExtension', HEX_EDITOR_EXTENSION_ID);
  } catch (err) {
    void vscode.window.showErrorMessage(`${MESSAGE_PREFIX}could not install the Hex Editor: ${(err as Error).message}`);
    return false;
  }
  return vscode.extensions.getExtension(HEX_EDITOR_EXTENSION_ID) !== undefined;
}

export function registerOpenBuildOutput(context: vscode.ExtensionContext, getClient: () => LanguageClient | undefined): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('fasm2Studio.openBuildOutput', async (resource?: vscode.Uri) => {
      let sourceFsPath: string | undefined;
      if (resource) {
        sourceFsPath = resource.fsPath;
      } else {
        const editor = activeFasmEditor();
        if (!editor) {
          void vscode.window.showWarningMessage(NO_ACTIVE_FASM_FILE_MESSAGE);
          return;
        }
        sourceFsPath = await buildableFsPath(editor.document);
      }
      if (!sourceFsPath) return;

      const client = getClient();
      if (!client) {
        void vscode.window.showErrorMessage(`${MESSAGE_PREFIX}the language server is not ready yet — try again in a moment.`);
        return;
      }
      // Resolved through the same entry point Build uses, so opening the output of an included
      // fragment shows the binary the program it belongs to actually produced, rather than looking
      // for output next to a file that never wrote any.
      const entryFile = await resolveEntryPointFsPath(client, sourceFsPath);
      if (!entryFile) return;

      const outputUri = vscode.Uri.file(getDefaultOutputPath(entryFile));
      if (!(await exists(outputUri))) {
        const build = 'Build it now';
        const choice = await vscode.window.showWarningMessage(
          `${MESSAGE_PREFIX}${path.basename(outputUri.fsPath)} has not been built yet.`,
          build,
        );
        if (choice !== build) return;
        // Goes through the command rather than runBuildTask directly, so the workspace-trust check
        // that guards every spawned process stays in exactly one place.
        await vscode.commands.executeCommand('fasm2Studio.build', vscode.Uri.file(entryFile));
        if (!(await exists(outputUri))) return; // the build failed and has already said so
      }

      if (!(await ensureHexEditor())) return;

      try {
        await vscode.commands.executeCommand('vscode.openWith', outputUri, HEX_EDITOR_VIEW_TYPE);
      } catch (err) {
        void vscode.window.showErrorMessage(`${MESSAGE_PREFIX}could not open ${outputUri.fsPath}: ${(err as Error).message}`);
      }
    }),
  );
}
