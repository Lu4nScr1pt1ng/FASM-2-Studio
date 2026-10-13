// Tells the language server which open documents have unsaved changes.
//
// The server assembles every program with open buffers in place of their files, but only a buffer
// with unsaved changes says anything the disk does not. A clean buffer is a copy of the disk that
// can be behind it: when a file changes outside the editor (git, a build script, an AI agent), VS
// Code reloads its editor a moment later, and never reloads one opened through a symlink whose real
// file changed. Compiling such a copy reported the old version's errors, or hid the new version's.
// LSP has no notion of "unsaved", so the client, which does, reports it.
import * as vscode from 'vscode';
import { LanguageClient, State } from 'vscode-languageclient/node';

export const DIRTY_DOCUMENTS_NOTIFICATION = 'fasm2Studio/dirtyDocuments';

export interface DirtyDocumentsParams {
  /** Every open file-backed document with unsaved changes, as the server knows their uris. */
  uris: string[];
}

export function registerDirtyDocuments(context: vscode.ExtensionContext, client: LanguageClient): void {
  let lastSent: string | undefined;

  const send = (force: boolean): void => {
    if (client.state !== State.Running) return;
    const uris = vscode.workspace.textDocuments
      .filter((doc) => doc.isDirty && doc.uri.scheme === 'file')
      .map((doc) => client.code2ProtocolConverter.asUri(doc.uri))
      .sort();
    const key = uris.join('\n');
    if (!force && key === lastSent) return;
    lastSent = key;
    void client.sendNotification(DIRTY_DOCUMENTS_NOTIFICATION, { uris } satisfies DirtyDocumentsParams);
  };

  context.subscriptions.push(
    // Fired for every edit, and also when only the dirty state changes (a revert, an undo back to
    // the saved text); comparing with what was last sent keeps it to one message per change.
    vscode.workspace.onDidChangeTextDocument(() => send(false)),
    vscode.workspace.onDidSaveTextDocument(() => send(false)),
    vscode.workspace.onDidOpenTextDocument(() => send(false)),
    vscode.workspace.onDidCloseTextDocument(() => send(false)),
    // A restarted (or crashed and restarted) server starts with no idea, so it is told again.
    client.onDidChangeState((e) => {
      if (e.newState === State.Running) send(true);
    }),
  );
  send(true);
}
