// "FASM: Select Inline Annotations" — turns on the address/size/encoding annotations, and says so
// when the project cannot produce them.
//
// The mode is written globally rather than into the project. It is a preference about how you read
// assembly rather than a fact about the code, so it should follow you between projects, and
// writing it per-workspace would create a `.vscode/settings.json` — and a diff — for a personal
// display choice. Anyone who does want it per-project can still say so by hand, since the setting
// stays `resource`-scoped.

import * as vscode from 'vscode';
import { dialectForDocument } from './buildPaths';
import { fasmConfig, MESSAGE_PREFIX } from './config';
import { INLAY_HINTS_SETTING, InlayHintsMode, inlayHintsChoices, unmetPrerequisite } from './inlayHintsChoices';
import { isWorkspaceTrusted } from './workspaceTrust';

export const SELECT_INLAY_HINTS_COMMAND = 'fasm2Studio.selectInlayHints';

export function registerSelectInlayHints(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(SELECT_INLAY_HINTS_COMMAND, async () => {
      const document = vscode.window.activeTextEditor?.document;
      const resource = document?.uri;
      const current = fasmConfig(resource).get<InlayHintsMode>(INLAY_HINTS_SETTING, 'off');

      const picked = await vscode.window.showQuickPick(inlayHintsChoices(current), {
        placeHolder: 'What should each line that produces machine code be annotated with?',
        matchOnDetail: true,
      });
      if (!picked || picked.mode === current) return;

      try {
        await fasmConfig(resource).update(INLAY_HINTS_SETTING, picked.mode, vscode.ConfigurationTarget.Global);
      } catch (err) {
        void vscode.window.showErrorMessage(`${MESSAGE_PREFIX}could not save the setting: ${(err as Error).message}`);
        return;
      }

      if (picked.mode === 'off') {
        void vscode.window.showInformationMessage(`${MESSAGE_PREFIX}inline annotations off.`);
        return;
      }

      const unmet = unmetPrerequisite({
        trusted: isWorkspaceTrusted(),
        diagnosticsEnabled: fasmConfig(resource).get<boolean>('diagnosticsEnabled', true),
        dialect: document ? dialectForDocument(document) : fasmConfig(resource).get<'fasm2' | 'fasm1'>('defaultDialect', 'fasm2'),
      });
      if (unmet) {
        void vscode.window.showWarningMessage(`${MESSAGE_PREFIX}inline annotations are on, but ${unmet}`);
        return;
      }
      void vscode.window.showInformationMessage(`${MESSAGE_PREFIX}inline annotations on.`);
    }),
  );
}
