// "FASM: Select Compiler" — points the extension at an assembler executable.
//
// This is the recovery path when a compiler isn't on PATH: the status bar reports "compiler not
// found" and clicking it lands here, so it has to work for someone who does not know which setting
// holds the path.
//
// Its first step asks which of the two path settings to write, and that question used to read
// "Which dialect are you configuring a compiler path for?" — close enough to "which dialect is this
// project?" to be mistaken for it, which is exactly what happened. The wording below keeps the
// subject on executables, shows what each dialect currently resolves to, and names the command that
// does answer the other question.

import * as vscode from 'vscode';
import { resolveCompiler, invalidateCompilerCache } from './compilerDiscovery';
import { fasmConfig, MESSAGE_PREFIX } from './config';
import { refreshStatusBar } from './statusBar';
import { COMPILER_PATH_SETTING, Dialect, DIALECT_LABEL } from './types';

export interface CompilerChoice {
  label: string;
  description: string;
  detail: string;
  dialect: Dialect;
}

/** Where each dialect's compiler currently resolves to, or undefined when none was found. */
export type ResolvedCompilers = Partial<Record<Dialect, { path: string; autoDetected: boolean } | undefined>>;

/**
 * The options offered, showing what each dialect resolves to today so it is clear the choice is
 * about executables. Pure, so the wording can be asserted without a running VS Code.
 */
export function compilerChoices(resolved: ResolvedCompilers): CompilerChoice[] {
  return (Object.keys(DIALECT_LABEL) as Dialect[]).map((dialect) => {
    const current = resolved[dialect];
    return {
      label: DIALECT_LABEL[dialect],
      description: current ? `${current.path}${current.autoDetected ? ' (auto-detected)' : ''}` : 'not found',
      detail: `Sets ${COMPILER_PATH_SETTING[dialect]}. This does not change which dialect your project uses — run "FASM: Select Dialect" for that.`,
      dialect,
    };
  });
}

export const SELECT_COMPILER_PLACEHOLDER = 'Which assembler executable do you want to point at?';

export function registerSelectCompiler(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('fasm2Studio.selectCompiler', async () => {
      const resolved: ResolvedCompilers = {};
      for (const dialect of Object.keys(DIALECT_LABEL) as Dialect[]) {
        resolved[dialect] = await resolveCompiler(dialect);
      }

      const picked = await vscode.window.showQuickPick(compilerChoices(resolved), {
        placeHolder: SELECT_COMPILER_PLACEHOLDER,
        matchOnDescription: true,
      });
      if (!picked) return;

      const chosen = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        title: `Select the ${picked.label} executable`,
      });
      if (!chosen || chosen.length === 0) return;

      // Global on purpose: where a tool is installed is a property of the machine, not of one
      // project — unlike the dialect, which Select Dialect writes into the workspace.
      await fasmConfig().update(COMPILER_PATH_SETTING[picked.dialect], chosen[0].fsPath, vscode.ConfigurationTarget.Global);
      invalidateCompilerCache();
      // The status bar names the resolved compiler, so it is stale the moment this returns.
      // onDidChangeConfiguration would eventually cover it, but only once VS Code has finished
      // persisting the write — refresh explicitly so the bar reflects the choice as soon as the
      // confirmation appears, not a beat later.
      refreshStatusBar();
      void vscode.window.showInformationMessage(`${MESSAGE_PREFIX}${picked.label} compiler set to ${chosen[0].fsPath}`);
    }),
  );
}
