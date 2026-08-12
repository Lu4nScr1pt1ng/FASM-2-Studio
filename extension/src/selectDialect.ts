// "FASM: Select Dialect" — records which assembler a project is written for.
//
// The dialect is auto-detected per file, but only from syntax that is exclusive to fasm2; there is
// no fasm1 counterpart, because every candidate for one is also a legitimate macro name in fasmg's
// own packages. A fasm1 project using none of those markers therefore falls back to
// `defaultDialect`, and getting that wrong makes every file in the project report errors against
// the wrong assembler.
//
// The setting has always been editable by hand, and a failing file now offers to set it. This is
// the third way in and the only one you can reach before anything has gone wrong: pick the dialect
// up front and it is written into the project's own settings.

import * as vscode from 'vscode';
import { configurationTargetLabel, CONFIG_SECTION, fasmConfig, hasWorkspaceFolder, MESSAGE_PREFIX, projectConfigurationTarget } from './config';
import { refreshStatusBar } from './statusBar';
import { Dialect, DIALECT_LABEL } from './types';

export const DEFAULT_DIALECT_SETTING = 'defaultDialect';

export interface DialectChoice {
  label: string;
  description: string;
  detail: string;
  dialect: Dialect;
}

/**
 * The options offered, with the one already in effect marked. Pure so the wording and the
 * current-value marker can be asserted without a running VS Code.
 */
export function dialectChoices(current: Dialect): DialectChoice[] {
  const options: Array<{ dialect: Dialect; detail: string }> = [
    {
      dialect: 'fasm2',
      detail: 'flat assembler 2 / fasmg. Also the right answer for a bare fasmg project.',
    },
    {
      dialect: 'fasm1',
      detail: 'Classic flat assembler 1. Choose this for a project fasm1 builds, since its syntax is not auto-detected.',
    },
  ];

  return options.map((option) => ({
    label: DIALECT_LABEL[option.dialect],
    description: option.dialect === current ? 'current' : '',
    detail: option.detail,
    dialect: option.dialect,
  }));
}

/** What to tell the user once it is written, which differs by scope: a workspace (or, in a
 * multi-root workspace, workspace-folder) write lands in the project and is the point of the
 * command, while a global one quietly affects everything else. */
export function confirmationMessage(dialect: Dialect, target: vscode.ConfigurationTarget): string {
  const where =
    target === vscode.ConfigurationTarget.Global
      ? 'globally — open a folder to set it for one project only'
      : configurationTargetLabel(target);
  return `${MESSAGE_PREFIX}Dialect set to ${DIALECT_LABEL[dialect]} ${where}.`;
}

export function registerSelectDialect(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('fasm2Studio.selectDialect', async () => {
      // The active file decides both which folder's current value to show and, in a multi-root
      // workspace, which folder's settings the answer gets written into — the dialect describes
      // one project, so in a workspace holding both a fasm1 and a fasm2 project there is no single
      // right answer to write window-wide.
      const resource = vscode.window.activeTextEditor?.document.uri;
      const current = fasmConfig(resource).get<Dialect>(DEFAULT_DIALECT_SETTING, 'fasm2');

      const picked = await vscode.window.showQuickPick(dialectChoices(current), {
        placeHolder: 'Which assembler is this project written for?',
        matchOnDetail: true,
      });
      if (!picked) return;

      const target = projectConfigurationTarget(hasWorkspaceFolder(), resource);
      try {
        await vscode.workspace.getConfiguration(CONFIG_SECTION, resource).update(DEFAULT_DIALECT_SETTING, picked.dialect, target);
      } catch (err) {
        void vscode.window.showErrorMessage(`${MESSAGE_PREFIX}Could not save the setting: ${(err as Error).message}`);
        return;
      }
      refreshStatusBar();
      void vscode.window.showInformationMessage(confirmationMessage(picked.dialect, target));
    }),
  );
}
