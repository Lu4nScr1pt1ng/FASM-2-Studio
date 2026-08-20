import * as assert from 'assert';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { getDefaultOutputPath } from '../../src/buildPaths';
import { makeTempDir, removeTempDir } from '../tempDir';

// "fasm2" on Windows is a fasm2.cmd wrapper script (the official distribution's own shape), which
// spawnSync cannot even attempt to run without a shell — see the same reasoning in
// server/src/features/diagnostics.ts's execCompiler.
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
const LINUX_PROGRAM_SRC = [
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

// CreateFileA(MARKER, GENERIC_WRITE, 0, 0, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, 0) then
// ExitProcess(0). Windows PE64: the same "leaves something behind" property as the Linux program
// above, needed for exactly the same reason — this is also the regression test for runner.ts
// having used spawnSync, which never returns at all when this process is VS Code's own binary run
// as Node (ELECTRON_RUN_AS_NODE) on Windows, confirmed directly against the built runner.js. Never
// reaching CreateFileA (marker absent) is indistinguishable on its own from "the terminal opened
// but the program itself failed to start" — it's the *terminal* this test goes on to check for
// (see below) that pins the failure down to "hung before running anything" specifically.
const WINDOWS_PROGRAM_SRC = [
  'format PE64 console',
  'entry start',
  '',
  "include 'win64a.inc'",
  '',
  "section '.text' code readable executable",
  '',
  'start:',
  '\tsub\trsp, 8*5',
  '\tinvoke\tCreateFileA, marker, 40000000h, 0, 0, 2, 80h, 0',
  '\tinvoke\tCloseHandle, rax',
  '\tinvoke\tExitProcess, 0',
  '',
  "section '.data' data readable writeable",
  '',
  `marker db '${MARKER}', 0`,
  '',
  "section '.idata' import data readable writeable",
  '',
  "library kernel32, 'KERNEL32.DLL'",
  "import kernel32, CreateFileA, 'CreateFileA', CloseHandle, 'CloseHandle', ExitProcess, 'ExitProcess'",
  '',
].join('\n');

const PROGRAM_SRC = os.platform() === 'win32' ? WINDOWS_PROGRAM_SRC : LINUX_PROGRAM_SRC;

async function waitForFile(filePath: string, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (!fs.existsSync(filePath)) {
    if (Date.now() - start >= timeoutMs) return false;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return true;
}

// Named "FASM" (see runCommand.ts's TERMINAL_NAME) everywhere the extension itself is asked — but
// on Windows, VS Code overrides that with the tab title of whatever process the shellPath actually
// launches, which for this terminal is VS Code's own binary run as Node ("Code"), not "FASM" —
// confirmed directly against a real run, not a guess. shellPath is what's actually distinctive
// about this terminal (a real shell, however it got named, never runs as process.execPath), so it
// is what both finding and cleaning these terminals up key on, rather than a name Windows may have
// already renamed out from under the extension by the time either runs.
function isRunTerminal(terminal: vscode.Terminal): boolean {
  return (terminal.creationOptions as vscode.TerminalOptions | undefined)?.shellPath === process.execPath;
}

function disposeRunTerminals(): void {
  for (const terminal of vscode.window.terminals) {
    if (isRunTerminal(terminal)) terminal.dispose();
  }
}

describe('FASM: Build and Run', () => {
  it('runs the program it just built, on a terminal that is the program rather than a shell', async function () {
    if (!fasm2Available() || !['linux', 'win32'].includes(os.platform())) {
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

      // Regression test for the default build output having no file extension at all: cmd.exe's
      // PATHEXT search only ever appends one to a bare command name, never to an already-qualified
      // path, so a fully-valid PE at "prog" (rather than "prog.exe") could not be launched at all —
      // "'...\prog' is not recognized as an internal or external command" — confirmed directly, not
      // just reasoned about. Silent on its own (no error was visible without the runner.ts fix
      // above too — spawnSync never returned to report it), which is why the marker check alone
      // would not have caught a regression here even though it *would* have caught this bug itself.
      if (os.platform() === 'win32') {
        assert.ok(getDefaultOutputPath(asmPath).endsWith('.exe'), 'the default Windows build output must end in ".exe" to be launchable at all');
      }

      const terminal = vscode.window.terminals.find(isRunTerminal);
      assert.ok(
        terminal,
        `no terminal was opened for the program; terminals: ${vscode.window.terminals
          .map((t) => `${t.name} shellPath=${(t.creationOptions as vscode.TerminalOptions)?.shellPath}`)
          .join(' | ')}`,
      );
      // The program's terminal runs a process of the extension's own choosing. A terminal opened
      // with the user's shell instead is the shape of the bug above, whether or not it happened to
      // work on the machine running this test. (isRunTerminal above already establishes this for
      // every platform; asserted again explicitly here as the one thing this whole test is about.)
      assert.strictEqual((terminal.creationOptions as vscode.TerminalOptions).shellPath, process.execPath);
      // The "FASM" name itself is only checked where Windows doesn't override it — see
      // isRunTerminal's own comment.
      if (os.platform() !== 'win32') assert.strictEqual(terminal.name, 'FASM');
    } finally {
      disposeRunTerminals();
      await removeTempDir(dir);
    }
  });

  it('offers to build first when FASM: Run is asked for something that was never built', async function () {
    if (!fasm2Available() || !['linux', 'win32'].includes(os.platform())) {
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
