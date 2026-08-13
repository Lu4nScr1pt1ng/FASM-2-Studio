// "FASM: Select Debugger", and the preflight that sends people to it.
//
// The recovery path for a debugger that isn't installed, deliberately shaped like the assembler's
// (selectCompiler.ts): say what is missing, say where to get it, and offer to point at one that is
// already on disk somewhere detection can't guess. The preflight is the part that matters most —
// without it none of this is ever reached, because a missing debugger announces itself only as an
// ENOENT inside the adapter, long after the launch appeared to be going fine.

import * as vscode from 'vscode';
import { fasmConfig, MESSAGE_PREFIX } from './config';
import { DebuggerChoiceAction, debuggerChoices, debuggerInstallHint, selectDebuggerPlaceholder } from './debuggerChoices';
import { debuggerAvailable, invalidateDebuggerCache, resolveDebuggerCommand } from './gdbDiscovery';

export const SELECT_DEBUGGER_COMMAND = 'fasm2Studio.selectDebugger';

async function browseForDebugger(): Promise<boolean> {
  const chosen = await vscode.window.showOpenDialog({
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: false,
    title: 'Select the gdb (or lldb-mi) executable',
  });
  if (!chosen || chosen.length === 0) return false;

  // Global, for the same reason the compiler paths are: where a tool is installed is a property of
  // the machine, not of one project.
  await fasmConfig().update('gdbPath', chosen[0].fsPath, vscode.ConfigurationTarget.Global);
  invalidateDebuggerCache();
  void vscode.window.showInformationMessage(`${MESSAGE_PREFIX}debugger set to ${chosen[0].fsPath}`);
  return true;
}

async function rescanDebugger(): Promise<boolean> {
  invalidateDebuggerCache();
  const command = resolveDebuggerCommand();
  const found = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: `${MESSAGE_PREFIX}looking for a debugger…` },
    () => debuggerAvailable(command),
  );
  if (found) {
    void vscode.window.showInformationMessage(`${MESSAGE_PREFIX}found ${command}.`);
  } else {
    void vscode.window.showWarningMessage(`${MESSAGE_PREFIX}still no debugger found — ${debuggerInstallHint()}`);
  }
  return found;
}

/** Runs one menu entry. Returns whether the debugger is (now) usable, so the preflight can carry
 * straight on into the launch when the user has just fixed the problem. */
async function runChoice(action: DebuggerChoiceAction): Promise<boolean> {
  switch (action.kind) {
    case 'browse':
      return browseForDebugger();
    case 'install':
      void vscode.window.showInformationMessage(`${MESSAGE_PREFIX}${debuggerInstallHint()}`, { modal: true });
      return false;
    case 'rescan':
      return rescanDebugger();
  }
}

async function showDebuggerMenu(): Promise<boolean> {
  const command = resolveDebuggerCommand();
  const found = await debuggerAvailable(command);
  const picked = await vscode.window.showQuickPick(debuggerChoices(command, found), {
    placeHolder: selectDebuggerPlaceholder(command, found),
    matchOnDescription: true,
  });
  if (!picked) return found;
  return runChoice(picked.action);
}

/**
 * Checked before a debug launch commits to anything: is there a debugger to drive at all?
 *
 * Returns true to proceed. Returns false only when the debugger is genuinely absent *and* the user
 * did not fix it from the prompt — in which case the launch is abandoned before a build runs and
 * before a terminal is opened, rather than failing several seconds later with an ENOENT.
 *
 * The prompt is modal because this is a hard stop that the launch cannot continue past. A toast
 * would be dismissed by the very Debug Console output that follows it.
 */
export async function ensureDebuggerAvailable(configuredPath?: string): Promise<boolean> {
  const command = resolveDebuggerCommand(configuredPath);
  if (await debuggerAvailable(command)) return true;

  const locate = 'Point at a debugger…';
  const help = 'How do I install one?';
  const choice = await vscode.window.showErrorMessage(
    `${MESSAGE_PREFIX}cannot start debugging — “${command}” was not found. ` +
      'This extension drives a debugger you install yourself; it does not bundle one.',
    { modal: true, detail: debuggerInstallHint() },
    locate,
    help,
  );

  if (choice === locate) return browseForDebugger();
  if (choice === help) return runChoice({ kind: 'install' });
  return false;
}

export function registerSelectDebugger(context: vscode.ExtensionContext): void {
  context.subscriptions.push(vscode.commands.registerCommand(SELECT_DEBUGGER_COMMAND, () => showDebuggerMenu()));
}
