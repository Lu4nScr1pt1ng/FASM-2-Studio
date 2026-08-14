import * as assert from 'assert';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { makeTempDir, removeTempDir } from '../tempDir';

function fasm2Available(): boolean {
  const result = spawnSync('fasm2', [], { shell: true, timeout: 3000, encoding: 'utf8' });
  return `${result.stdout ?? ''}${result.stderr ?? ''}`.toLowerCase().includes('flat assembler');
}

/** The marker the program below writes, in whatever directory it is run from — the only evidence
 * available from outside that the program itself actually ran, as opposed to a terminal having been
 * opened for it. */
const MARKER = 'ran.txt';

// sys_creat(MARKER, 0644) then exit(0). Linux x86-64: this test asserts that a program runs at all,
// so it has to be one whose running leaves something behind.
const PROGRAM_SRC = [
  'format ELF64 executable 3',
  'entry start',
  '',
  'segment readable executable',
  'start:',
  '\tmov\teax, 85',
  '\tmov\tedi, marker',
  '\tmov\tesi, 420',
  '\tsyscall',
  '\tmov\tedi, 0',
  '\tmov\teax, 60',
  '\tsyscall',
  `marker db '${MARKER}', 0`,
  '',
].join('\n');

async function waitForFile(filePath: string, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (!fs.existsSync(filePath)) {
    if (Date.now() - start >= timeoutMs) return false;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return true;
}

function disposeRunTerminals(): void {
  for (const terminal of vscode.window.terminals) {
    if (terminal.name === 'FASM') terminal.dispose();
  }
}

describe('FASM: Build and Run', () => {
  it('runs the program it just built, on a terminal that is the program rather than a shell', async function () {
    if (!fasm2Available() || os.platform() !== 'linux') {
      this.skip();
      return;
    }
    this.timeout(40000);

    // Regression test for a first run that opened the "FASM" terminal and ran nothing in it. The
    // command used to be typed into that terminal's shell, and a shell still starting up discards
    // typed-ahead input (readline and fish both switch to raw mode with TCSAFLUSH) — so the failure
    // only appeared when there was no already-open terminal to reuse, which is exactly the state a
    // not-yet-compiled project runs from. Asserting on the program's own side effect rather than on
    // the terminal's contents keeps this independent of which shell the machine running it uses.
    const dir = makeTempDir('fasm2-studio-run-test-');
    const asmPath = path.join(dir, 'prog.asm');
    fs.writeFileSync(asmPath, PROGRAM_SRC, 'utf8');

    try {
      disposeRunTerminals();
      const doc = await vscode.workspace.openTextDocument(asmPath);
      await vscode.window.showTextDocument(doc);

      await vscode.commands.executeCommand('fasm2Studio.buildAndRun');

      const marker = path.join(dir, MARKER);
      assert.ok(await waitForFile(marker, 20000), `the built program never ran: no ${marker}, directory holds ${fs.readdirSync(dir).join(', ')}`);

      const terminal = vscode.window.terminals.find((t) => t.name === 'FASM');
      assert.ok(terminal, `no terminal was opened for the program; terminals: ${vscode.window.terminals.map((t) => t.name).join(', ')}`);
      // The program's terminal runs a process of the extension's own choosing. A terminal opened
      // with the user's shell instead is the shape of the bug above, whether or not it happened to
      // work on the machine running this test.
      assert.strictEqual((terminal.creationOptions as vscode.TerminalOptions).shellPath, process.execPath);
    } finally {
      disposeRunTerminals();
      await removeTempDir(dir);
    }
  });

  it('offers to build first when FASM: Run is asked for something that was never built', async function () {
    if (!fasm2Available() || os.platform() !== 'linux') {
      this.skip();
      return;
    }
    this.timeout(40000);

    const dir = makeTempDir('fasm2-studio-run-unbuilt-test-');
    const asmPath = path.join(dir, 'prog.asm');
    fs.writeFileSync(asmPath, PROGRAM_SRC, 'utf8');

    // Answering the "nothing built yet" warning, which is modeless and so cannot be answered by the
    // test any other way.
    const originalShowWarning = vscode.window.showWarningMessage;
    let asked = 0;
    (vscode.window as unknown as Record<string, unknown>).showWarningMessage = (_message: string, ...items: unknown[]) => {
      asked += 1;
      return Promise.resolve(items.find((item) => item === 'Build it now'));
    };

    try {
      disposeRunTerminals();
      const doc = await vscode.workspace.openTextDocument(asmPath);
      await vscode.window.showTextDocument(doc);

      await vscode.commands.executeCommand('fasm2Studio.run');

      assert.strictEqual(asked, 1, 'expected exactly one "nothing built yet" warning');
      const marker = path.join(dir, MARKER);
      assert.ok(await waitForFile(marker, 20000), `"Build it now" built but never ran the program: no ${marker}, directory holds ${fs.readdirSync(dir).join(', ')}`);
    } finally {
      Object.assign(vscode.window, { showWarningMessage: originalShowWarning });
      disposeRunTerminals();
      await removeTempDir(dir);
    }
  });
});
