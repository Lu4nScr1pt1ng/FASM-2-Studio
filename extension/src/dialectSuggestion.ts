// Offers to fix a misconfigured dialect when the server has proved one is wrong.
//
// Dialect auto-detection only recognizes fasm2-only syntax (see server/src/dialect.ts for why a
// fasm1 marker set was deliberately removed), so a project written in fasm1 without any of those
// markers falls back to `fasm2Studio.defaultDialect` and reports errors across code that assembles
// perfectly. The setting to fix it exists, but nothing ever points at it, so the failure looks like
// a broken extension rather than a one-line configuration.
//
// The server only raises this after one assembler has rejected the file and the other has accepted
// it, so the suggestion is never a guess.

import * as vscode from 'vscode';
import { CONFIG_SECTION, hasWorkspaceFolder, MESSAGE_PREFIX, projectConfigurationTarget } from './config';
import { Dialect, DIALECT_LABEL } from './types';

export interface SuggestDialectParams {
  uri: string;
  dialect: Dialect;
}

const DEFAULT_DIALECT_SETTING = 'defaultDialect';

/** The prompt's wording, kept pure so it can be asserted without a running VS Code. */
export function suggestionMessage(dialect: Dialect, fileName: string): string {
  const other: Dialect = dialect === 'fasm1' ? 'fasm2' : 'fasm1';
  return (
    `${MESSAGE_PREFIX}${fileName} does not assemble as ${DIALECT_LABEL[other]}, but does as ` +
    `${DIALECT_LABEL[dialect]}. This project is probably ${DIALECT_LABEL[dialect]}.`
  );
}

export function registerDialectSuggestion(
  context: vscode.ExtensionContext,
  onNotification: (method: string, handler: (params: SuggestDialectParams) => void) => vscode.Disposable,
): void {
  context.subscriptions.push(
    onNotification('fasm2Studio/suggestDialect', (params) => {
      void promptForDialect(params);
    }),
  );
}

async function promptForDialect(params: SuggestDialectParams): Promise<void> {
  const fileName = params.uri.split('/').pop() ?? 'This file';
  const useIt = `Use ${DIALECT_LABEL[params.dialect]} for this project`;

  const choice = await vscode.window.showWarningMessage(suggestionMessage(params.dialect, fileName), useIt, 'Ignore');
  if (choice !== useIt) return;

  const target = projectConfigurationTarget(hasWorkspaceFolder());
  try {
    await vscode.workspace.getConfiguration(CONFIG_SECTION).update(DEFAULT_DIALECT_SETTING, params.dialect, target);
  } catch (err) {
    void vscode.window.showErrorMessage(`${MESSAGE_PREFIX}Could not save the setting: ${(err as Error).message}`);
    return;
  }
  void vscode.window.showInformationMessage(
    `${MESSAGE_PREFIX}Dialect set to ${DIALECT_LABEL[params.dialect]}${target === vscode.ConfigurationTarget.Workspace ? ' for this workspace' : ''}.`,
  );
}
