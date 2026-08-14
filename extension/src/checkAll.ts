// "FASM: Check All Entry Points" — assembles every program in the workspace and puts what the
// compiler says into the Problems panel.
//
// Live error checking is driven entirely by the open-editor set: the server compiles a document
// when it is opened, changed or saved, and nothing else ever triggers it. That is the right design
// for the thing it does — it is answering "what is wrong with the file in front of you", against
// the unsaved buffer — but it leaves the Problems panel only ever as complete as the tabs someone
// happens to have open. In an include-tree language that is a real gap rather than a theoretical
// one: editing a shared .inc can break four of the five programs that include it, and the four stay
// looking clean until the day each is opened.
//
// So this is the deliberate whole-project pass. It is one assembler process per program, which is
// why it is a command rather than something on a timer, and it assembles into a temp directory —
// checking a project never writes a binary into it.

import * as vscode from 'vscode';
import { LanguageClient } from 'vscode-languageclient/node';
import { CheckAllSummary, summaryMessage } from './checkAllSummary';
import { MESSAGE_PREFIX } from './config';
import { ensureTrusted } from './workspaceTrust';

interface CheckAllProgress {
  done: number;
  total: number;
  uri: string;
}

export function registerCheckAll(context: vscode.ExtensionContext, getClient: () => LanguageClient | undefined): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('fasm2Studio.checkAll', async () => {
      if (!(await ensureTrusted('Checking every entry point'))) return;

      const client = getClient();
      if (!client) {
        void vscode.window.showErrorMessage(`${MESSAGE_PREFIX}the language server is not ready yet — try again in a moment.`);
        return;
      }

      const summary = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `${MESSAGE_PREFIX}checking every entry point`,
          // One assembler run per program, sequentially — a large workspace is a genuine wait, and
          // a wait with no way out is the thing that makes people avoid a command entirely.
          cancellable: true,
        },
        async (progress, token): Promise<CheckAllSummary | undefined> => {
          const listener = client.onNotification('fasm2Studio/checkAllProgress', (params: CheckAllProgress) => {
            progress.report({
              message: `${params.done + 1}/${params.total}: ${vscode.workspace.asRelativePath(vscode.Uri.parse(params.uri), false)}`,
            });
          });
          try {
            // The token goes to the server, which stops between programs — cancelling has to leave
            // the diagnostics it already published in place rather than half-retracting them.
            return await client.sendRequest<CheckAllSummary>('fasm2Studio/checkAllEntryPoints', {}, token);
          } catch (err) {
            // A cancelled request rejects; that is the user's own answer, not a failure to report.
            if (token.isCancellationRequested) return undefined;
            void vscode.window.showErrorMessage(`${MESSAGE_PREFIX}the check failed: ${(err as Error).message}`);
            return undefined;
          } finally {
            listener.dispose();
          }
        },
      );
      if (!summary) return;

      const message = `${MESSAGE_PREFIX}${summaryMessage(summary)}.`;
      // Entry points that could not be assembled at all: a missing include stops fasmg before it
      // reaches any line worth marking, so these have nowhere to appear as a squiggle and would
      // otherwise be counted as clean.
      if (summary.failures.length > 0) {
        void vscode.window.showWarningMessage(`${message} ${summary.failures.length} could not be assembled: ${summary.failures.join('; ')}`);
        return;
      }
      if (summary.errors > 0) {
        const show = 'Show Problems';
        // Deliberately not awaited: the check is finished, and a notification sitting unanswered
        // is not a reason for the command to still be running. Awaiting it would also mean an
        // ignored notification never lets the command complete.
        void vscode.window.showWarningMessage(message, show).then((choice) => {
          if (choice === show) return vscode.commands.executeCommand('workbench.actions.view.problems');
          return undefined;
        });
        return;
      }
      void vscode.window.showInformationMessage(message);
    }),
  );
}
