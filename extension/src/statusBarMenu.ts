// What clicking the status bar item opens.
//
// The bar reports two things — the dialect a file is being treated as, and the executable that
// will assemble it — but clicking it only ever led to the compiler picker, and "FASM: Select
// Dialect" was reachable from the command palette alone. The dialect is the setting most likely to
// be wrong (a fasm1 project is not auto-detectable, by design), so the one visible affordance for
// it should lead to all of it: the two settings the bar displays, the live-error-checking switch,
// and the language server's own log and restart.
//
// The list itself lives in statusBarMenuItems.ts, which imports nothing from vscode so its
// ordering can be tested directly.

import * as vscode from 'vscode';
import { dialectForDocument } from './buildPaths';
import { resolveCompiler } from './compilerDiscovery';
import { configurationTargetLabel, fasmConfig, hasWorkspaceFolder, MESSAGE_PREFIX, projectConfigurationTarget } from './config';
import { menuItems, TOGGLE_DIAGNOSTICS_ACTION } from './statusBarMenuItems';
import { Dialect, DIALECT_LABEL } from './types';

export const STATUS_BAR_MENU_COMMAND = 'fasm2Studio.statusBarMenu';
const DIAGNOSTICS_SETTING = 'diagnosticsEnabled';

async function toggleDiagnostics(resource: vscode.Uri | undefined, enabled: boolean): Promise<void> {
  const target = projectConfigurationTarget(hasWorkspaceFolder(), resource);
  try {
    await fasmConfig(resource).update(DIAGNOSTICS_SETTING, !enabled, target);
  } catch (err) {
    void vscode.window.showErrorMessage(`${MESSAGE_PREFIX}could not save the setting: ${(err as Error).message}`);
    return;
  }
  void vscode.window.showInformationMessage(
    `${MESSAGE_PREFIX}live error checking ${!enabled ? 'on' : 'off'} ${configurationTargetLabel(target)}.`,
  );
}

export function registerStatusBarMenu(context: vscode.ExtensionContext, getDiagnosticsIssue: () => string | undefined): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(STATUS_BAR_MENU_COMMAND, async () => {
      const document = vscode.window.activeTextEditor?.document;
      const resource = document?.uri;
      // Detected from the live buffer for the same reason the bar itself does it: typing the very
      // marker that flips the dialect should be reflected before the file is saved.
      const dialect = document ? dialectForDocument(document) : fasmConfig(resource).get<Dialect>('defaultDialect', 'fasm2');
      const compiler = await resolveCompiler(dialect, resource);
      const diagnosticsEnabled = fasmConfig(resource).get<boolean>(DIAGNOSTICS_SETTING, true);

      const picked = await vscode.window.showQuickPick(
        menuItems({ dialect, compilerPath: compiler?.path, diagnosticsEnabled, diagnosticsIssue: getDiagnosticsIssue() }),
        { placeHolder: `FASM2 Studio — ${DIALECT_LABEL[dialect]}${compiler ? ` via ${compiler.path}` : ''}` },
      );
      if (!picked) return;

      if (picked.action === TOGGLE_DIAGNOSTICS_ACTION) {
        await toggleDiagnostics(resource, diagnosticsEnabled);
        return;
      }
      await vscode.commands.executeCommand(picked.action);
    }),
  );
}
