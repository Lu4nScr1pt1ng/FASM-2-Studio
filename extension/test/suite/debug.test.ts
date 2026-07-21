import * as assert from 'assert';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

function isAvailable(command: string): boolean {
  const result = spawnSync(command, ['--version'], { timeout: 5000 });
  return !(result.error && (result.error as NodeJS.ErrnoException).code === 'ENOENT');
}

const PROGRAM_SRC = [
  'format ELF64 executable 3',
  'entry start',
  '',
  'segment readable executable',
  '',
  'start:',
  '\tmov eax, 1',
  '\tmov ebx, 2',
  '\tadd eax, ebx',
  '\tnop',
  '\tmov edi, 0',
  '\tmov eax, 60',
  '\tsyscall',
  '',
].join('\n');

/**
 * Drives a full debug session (breakpoint set, launched via `start`, continued past each stop,
 * terminated) and returns the source lines it stopped at. Shared by two scenarios that launch
 * differently but must behave identically end to end.
 */
async function runDebugSessionAndCollectStops(docUri: vscode.Uri, breakpointLine: number, start: () => Thenable<unknown>): Promise<number[]> {
  const bp = new vscode.SourceBreakpoint(new vscode.Location(docUri, new vscode.Position(breakpointLine, 0)), true);
  vscode.debug.addBreakpoints([bp]);

  const log: string[] = [];
  const stoppedAtLines: number[] = [];
  let session: vscode.DebugSession | undefined;

  // The debug UI drives its own stackTrace/scopes/variables calls reactively whenever the
  // adapter reports a "stopped" event; this only needs to notice each stop and send the program
  // on its way again, exactly like a person clicking "Continue" would.
  const trackerDisposable = vscode.debug.registerDebugAdapterTrackerFactory('fasm', {
    createDebugAdapterTracker: () => ({
      onDidSendMessage: (m: unknown) => {
        log.push(`dap <- ${JSON.stringify(m)}`);
        const msg = m as { type?: string; event?: string; body?: { threadId?: number } };
        if (msg.type === 'event' && msg.event === 'stopped' && session) {
          void session.customRequest('stackTrace', { threadId: msg.body?.threadId ?? 1 }).then((st: { stackFrames?: Array<{ line: number }> }) => {
            if (st.stackFrames?.[0]) stoppedAtLines.push(st.stackFrames[0].line);
            void session!.customRequest('continue', { threadId: msg.body?.threadId ?? 1 });
          });
        }
      },
      onError: (e) => log.push(`dap error: ${e}`),
    }),
  });

  const started = new Promise<vscode.DebugSession>((resolve) => {
    const disposable = vscode.debug.onDidStartDebugSession((s) => {
      if (s.type === 'fasm') {
        disposable.dispose();
        resolve(s);
      }
    });
  });
  const terminated = new Promise<void>((resolve) => {
    const disposable = vscode.debug.onDidTerminateDebugSession((s) => {
      if (s.type === 'fasm') {
        disposable.dispose();
        resolve();
      }
    });
  });

  try {
    await start();

    session = await Promise.race([
      started,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timed out waiting for onDidStartDebugSession')), 10000)),
    ]);
    assert.strictEqual(session.type, 'fasm');

    await Promise.race([
      terminated,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timed out waiting for onDidTerminateDebugSession')), 15000)),
    ]);

    return stoppedAtLines;
  } catch (err) {
    throw new Error(`${(err as Error).message}\n--- stops: ${stoppedAtLines.join(', ')} ---\n--- log ---\n${log.join('\n')}`);
  } finally {
    trackerDisposable.dispose();
    vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
  }
}

describe('FASM2 Studio debugger (real VS Code host, real gdb, real fasm2 binary)', () => {
  before(async () => {
    const ext = vscode.extensions.getExtension('Lu4nScr1pt1ng.fasm2-studio');
    await ext!.activate();
  });

  it('runs a full FASM: Debug session end-to-end (build with listing, launch, hit breakpoint, terminate)', async function () {
    if (!isAvailable('gdb') || !isAvailable('fasm2') || os.platform() !== 'linux') {
      this.skip();
      return;
    }
    this.timeout(30000);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fasm2-studio-ext-debug-test-'));
    const asmPath = path.join(dir, 'prog.asm');
    fs.writeFileSync(asmPath, PROGRAM_SRC, 'utf8');

    try {
      const doc = await vscode.workspace.openTextDocument(asmPath);
      await vscode.window.showTextDocument(doc);

      const stoppedAtLines = await runDebugSessionAndCollectStops(doc.uri, 8, () => vscode.commands.executeCommand('fasm2Studio.debug'));

      assert.ok(stoppedAtLines.includes(9), `expected a stop at line 9 ("add eax, ebx"), got: ${stoppedAtLines.join(', ')}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('starts via launch.json-style config even when the active editor is not the asm file', async function () {
    if (!isAvailable('gdb') || !isAvailable('fasm2') || os.platform() !== 'linux') {
      this.skip();
      return;
    }
    this.timeout(30000);

    // Regression test for a bug where the generated debug config carried a preLaunchTask that
    // VS Code resolves and runs *before* ever calling resolveDebugConfiguration — via a label
    // lookup that only finds FasmTaskProvider's dynamic task when the active editor happens to be
    // the fasm file, failing with "Could not find the task ..." whenever a debug session starts
    // any other way (e.g. from the Run and Debug panel). The fix: never set preLaunchTask on our
    // own generated configs at all, and build directly inside resolveDebugConfiguration instead.
    // Deliberately leaves an unrelated document focused to prove this no longer depends on
    // editor focus.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fasm2-studio-ext-debug-nofocus-test-'));
    const asmPath = path.join(dir, 'prog.asm');
    fs.writeFileSync(asmPath, PROGRAM_SRC, 'utf8');
    // A real file in the test's own (cleaned-up) temp dir, not a synthetic untitled document:
    // VS Code's session-restore/backup handling for unsaved untitled buffers can materialize them
    // as real files, which would leak an artifact into the repo across repeated test runs.
    const otherPath = path.join(dir, 'not-a-fasm-file.txt');
    fs.writeFileSync(otherPath, 'not a fasm file', 'utf8');

    try {
      const doc = await vscode.workspace.openTextDocument(asmPath);
      const other = await vscode.workspace.openTextDocument(otherPath);
      await vscode.window.showTextDocument(other);
      assert.notStrictEqual(vscode.window.activeTextEditor?.document.languageId, 'fasm', 'active editor must not be the fasm file for this test to be meaningful');

      const stoppedAtLines = await runDebugSessionAndCollectStops(doc.uri, 8, () =>
        vscode.debug.startDebugging(vscode.workspace.getWorkspaceFolder(doc.uri), {
          type: 'fasm',
          request: 'launch',
          name: 'Debug FASM program',
          asmFile: asmPath,
          stopOnEntry: true,
        }),
      );

      assert.ok(stoppedAtLines.includes(9), `expected a stop at line 9 ("add eax, ebx"), got: ${stoppedAtLines.join(', ')}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
