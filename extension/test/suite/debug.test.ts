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

      const breakpointLine = 8; // "add eax, ebx" (0-based line 8 == 1-based source line 9)
      const bp = new vscode.SourceBreakpoint(new vscode.Location(doc.uri, new vscode.Position(breakpointLine, 0)), true);
      vscode.debug.addBreakpoints([bp]);

      const log: string[] = [];
      const stoppedAtLines: number[] = [];
      let session: vscode.DebugSession | undefined;

      // The debug UI drives its own stackTrace/scopes/variables calls reactively whenever the
      // adapter reports a "stopped" event; this test only needs to notice each stop and send the
      // program on its way again, exactly like a person clicking "Continue" would.
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
        await vscode.commands.executeCommand('fasm2Studio.debug');

        session = await Promise.race([
          started,
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timed out waiting for onDidStartDebugSession')), 10000)),
        ]);
        assert.strictEqual(session.type, 'fasm');

        await Promise.race([
          terminated,
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timed out waiting for onDidTerminateDebugSession')), 15000)),
        ]);

        assert.ok(stoppedAtLines.includes(9), `expected a stop at line 9 ("add eax, ebx"), got: ${stoppedAtLines.join(', ')}`);
      } catch (err) {
        throw new Error(`${(err as Error).message}\n--- stops: ${stoppedAtLines.join(', ')} ---\n--- log ---\n${log.join('\n')}`);
      } finally {
        trackerDisposable.dispose();
      }
    } finally {
      vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
