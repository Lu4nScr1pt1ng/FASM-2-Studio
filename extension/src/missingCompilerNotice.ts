// The one thing this extension says without being asked.
//
// Everything else it reports about its own state lives in the status bar, deliberately: a standing
// condition that a popup would re-announce on every keystroke belongs somewhere it can be stated
// permanently and quietly (see statusBar.ts). "There is no assembler on this machine at all" is the
// exception, and it is worth exactly one notification.
//
// It is the first thing a new user hits and the only one they cannot act on from what they can see.
// The status bar says "compiler not found", which reads as a setting to fix — but for someone who
// has just installed this extension and never installed flat assembler, nothing is misconfigured,
// there is no path to correct, and the fix is to go and download something. Without this, the
// features that need a compiler simply do nothing, and the extension looks broken rather than
// unequipped.
//
// Shown once ever, not once per workspace: whether an assembler exists on PATH is a property of the
// machine, and someone who has already been told and chosen not to act does not need telling again
// in the next folder they open. After this, the status bar carries it.

import * as vscode from 'vscode';
import { MESSAGE_PREFIX } from './config';
import { openSetupWalkthrough } from './selectCompiler';

/** globalState key recording that the notice below has had its one showing. */
export const MISSING_COMPILER_NOTICE_KEY = 'missingCompilerNoticeShown';

/** Leads with what still works, because most of the extension does: an unequipped install is a
 * perfectly good reader of assembly, and someone who only wanted highlighting should be able to
 * dismiss this and carry on rather than think they have to install a toolchain first. */
export const MISSING_COMPILER_MESSAGE =
  `${MESSAGE_PREFIX}no fasm2 or fasm1 assembler found. Highlighting, navigation and completion work without one — ` +
  'Build, Run, Debug and live error checking need one installed.';

const INSTALL_ACTION = 'How do I install one?';
const SELECT_ACTION = 'I already have one';

/**
 * Latches the notice per state store, synchronously.
 *
 * `update` is asynchronous, so the flag it writes is not readable by the time a second caller
 * arrives — and callers do arrive together: the status bar renders on editor switches, settings
 * changes and edits alike, and two of those landing in one tick would otherwise each produce a
 * notification for the same condition. Keyed on the store rather than a bare module flag so a test
 * can drive this with a store of its own and get the real first-time behaviour.
 */
const latched = new WeakSet<vscode.Memento>();

/**
 * Shows the missing-assembler notice, at most once per machine. Returns whether it was shown.
 *
 * Caller contract: only invoke this when an assembler genuinely could not be resolved *and* the
 * workspace is trusted — in an untrusted workspace nothing is going to run either way, so the
 * absence of a compiler is not the user's problem yet (statusBar.ts checks in that order).
 */
export async function showMissingCompilerNoticeOnce(state: vscode.Memento): Promise<boolean> {
  if (latched.has(state) || state.get<boolean>(MISSING_COMPILER_NOTICE_KEY, false)) return false;
  latched.add(state);
  // Recorded before the answer, not after: a notification the user ignores or dismisses has still
  // been shown, and "shown once" must not turn into "shown until you click something".
  await state.update(MISSING_COMPILER_NOTICE_KEY, true);

  const choice = await vscode.window.showInformationMessage(MISSING_COMPILER_MESSAGE, INSTALL_ACTION, SELECT_ACTION);
  if (choice === INSTALL_ACTION) await openSetupWalkthrough();
  else if (choice === SELECT_ACTION) await vscode.commands.executeCommand('fasm2Studio.selectCompiler');
  return true;
}
