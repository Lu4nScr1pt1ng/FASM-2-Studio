// An unsaved buffer is a FASM document as far as every read-only language feature is concerned —
// isFasmDocument classifies by language id precisely so a scratch buffer still highlights. The
// commands that spawn a compiler cannot accept the same input: an untitled document's `uri.fsPath`
// is its label ("Untitled-1"), not a path.
//
// Left ungated, that label reached the server's entry-point resolution, which found nothing named
// that, concluded it was an orphaned fragment, and fell through to the "which project is this for?"
// quick pick — offering unrelated .asm files from elsewhere in the workspace as candidates for a
// buffer that had never been written anywhere. Nothing timed out and no error was shown, so the
// observable behaviour was a build silently turning into a prompt about other people's files.
import * as assert from 'assert';
import * as vscode from 'vscode';
import { UNSAVED_FILE_MESSAGE } from '../../src/activeEditor';

const PROGRAM_SRC = ['format ELF64 executable 3', 'entry start', '', 'segment readable executable', 'start:', '\tmov edi, 0', '\tmov eax, 60', '\tsyscall', ''].join('\n');

/** Captures warning/error notifications and neutralises the quick pick, so the assertion is about
 * which of the two a command reaches for rather than about whichever one blocks the test first. */
function captureUi() {
  const messages: string[] = [];
  let quickPickShown = false;
  const original = {
    warn: vscode.window.showWarningMessage,
    error: vscode.window.showErrorMessage,
    quickPick: vscode.window.showQuickPick,
  };
  (vscode.window as unknown as Record<string, unknown>).showWarningMessage = (message: string) => {
    messages.push(message);
    return Promise.resolve(undefined); // as if the user dismissed it
  };
  (vscode.window as unknown as Record<string, unknown>).showErrorMessage = (message: string) => {
    messages.push(message);
    return Promise.resolve(undefined);
  };
  (vscode.window as unknown as Record<string, unknown>).showQuickPick = () => {
    quickPickShown = true;
    return Promise.resolve(undefined);
  };
  return {
    messages,
    get quickPickShown() {
      return quickPickShown;
    },
    restore() {
      Object.assign(vscode.window, {
        showWarningMessage: original.warn,
        showErrorMessage: original.error,
        showQuickPick: original.quickPick,
      });
    },
  };
}

async function withUntitledFasmBuffer(run: (ui: ReturnType<typeof captureUi>) => Promise<void>): Promise<void> {
  const document = await vscode.workspace.openTextDocument({ language: 'fasm', content: PROGRAM_SRC });
  await vscode.window.showTextDocument(document);
  assert.strictEqual(document.uri.scheme, 'untitled', 'expected an untitled buffer to test against');

  const ui = captureUi();
  try {
    await run(ui);
  } finally {
    ui.restore();
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
  }
}

describe('build commands on an unsaved buffer', () => {
  before(async () => {
    const extension = vscode.extensions.getExtension('Lu4nScr1pt1ng.fasm2-studio');
    assert.ok(extension, 'the extension is not installed in this test host');
    await extension.activate();
  });

  for (const command of ['fasm2Studio.build', 'fasm2Studio.buildAndRun', 'fasm2Studio.run', 'fasm2Studio.clean']) {
    it(`${command} says the buffer is unsaved instead of asking which project it belongs to`, async function () {
      this.timeout(20000);
      await withUntitledFasmBuffer(async (ui) => {
        await vscode.commands.executeCommand(command);

        assert.ok(
          ui.messages.includes(UNSAVED_FILE_MESSAGE),
          `expected the unsaved-buffer message, got: ${JSON.stringify(ui.messages)}`,
        );
        assert.ok(!ui.quickPickShown, 'an unsaved buffer should never reach the entry-point picker');
      });
    });
  }

  it('fasm2Studio.debug stops before starting a session it has no file for', async function () {
    this.timeout(20000);
    await withUntitledFasmBuffer(async (ui) => {
      await vscode.commands.executeCommand('fasm2Studio.debug');

      assert.ok(
        ui.messages.includes(UNSAVED_FILE_MESSAGE),
        `expected the unsaved-buffer message, got: ${JSON.stringify(ui.messages)}`,
      );
      assert.strictEqual(vscode.debug.activeDebugSession, undefined, 'a debug session was started for a buffer with no file');
    });
  });

  // The message is the whole fix for a user who hits this: it has to name the state (never saved)
  // and the action (save it), since nothing else on screen explains why a build did nothing.
  it('names both the cause and the way out', () => {
    assert.match(UNSAVED_FILE_MESSAGE, /saved/i);
    assert.match(UNSAVED_FILE_MESSAGE, /disk/i);
  });
});
