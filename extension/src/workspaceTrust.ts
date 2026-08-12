// The line between what this extension does in an untrusted workspace and what it doesn't.
//
// The manifest declares `untrustedWorkspaces.supported: "limited"`, so the extension activates and
// every read-only language feature keeps working on a folder the user has not trusted — which is
// the common case for this extension specifically, since "clone an unfamiliar asm project and read
// it" is a large share of why anyone installs it. `restrictedConfigurations` makes VS Code ignore
// the workspace's own compiler/gdb/preload/include settings while untrusted, so it cannot choose
// which binary gets run.
//
// That alone is not the whole guard, though: it only neutralizes *which* executable would run, not
// whether one runs at all. Assembling untrusted source still means feeding a fasmg macro engine —
// which can read files off disk and write output ones — input the workspace wrote. So everything
// that spawns a process is gated here as well, and comes back the moment trust is granted.

import * as vscode from 'vscode';
import { MESSAGE_PREFIX } from './config';

export function isWorkspaceTrusted(): boolean {
  return vscode.workspace.isTrusted;
}

/**
 * Guards an action that would start a process. Returns true when it may proceed; otherwise names
 * the reason and offers the one thing that fixes it, since a command that merely did nothing would
 * read as the extension being broken.
 *
 * `action` completes "… is disabled in an untrusted workspace", e.g. "Building".
 */
export async function ensureTrusted(action: string): Promise<boolean> {
  if (vscode.workspace.isTrusted) return true;

  const trust = 'Manage Workspace Trust';
  const choice = await vscode.window.showWarningMessage(
    `${MESSAGE_PREFIX}${action} is disabled in an untrusted workspace, because it runs the assembler against this folder's source. Editing, navigation and highlighting are unaffected.`,
    trust,
    'Cancel',
  );
  if (choice === trust) await vscode.commands.executeCommand('workbench.trust.manage');
  return false;
}

/** Runs `onGranted` if/when the user trusts the workspace during this session, so the features
 * withheld above switch back on without needing a window reload. */
export function onTrustGranted(context: vscode.ExtensionContext, onGranted: () => void): void {
  context.subscriptions.push(vscode.workspace.onDidGrantWorkspaceTrust(onGranted));
}
