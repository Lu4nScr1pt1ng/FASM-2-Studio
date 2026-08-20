// End-to-end proof that "console": "integratedTerminal" gives the debugged program a real terminal:
// a program blocked in a `read` syscall receives what is typed into that terminal, and answers on
// it rather than through the Debug Console.
//
// The client half is played the way VS Code plays it — the adapter sends a `runInTerminal` reverse
// request, and something on the other side has to open a terminal and run the command in it. Here
// that something is util-linux's `script`, whose entire job is to run a command under a pty. So the
// pty is real, the tty handshake is real, gdb's -inferior-tty-set is real, and the bytes this test
// writes travel the same path a keystroke would.
import * as assert from 'assert';
import { ChildProcess, spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DapClient, isAvailable } from './dapClient';
import { makeTempDir, removeTempDir } from './tempDir';

/** Reads up to 32 bytes of stdin, then writes "got: " followed by exactly what it read, then exits.
 * The prefix matters: a pty echoes back whatever is typed at it, so an assertion on the input text
 * alone would pass without the program ever having run. Only the program can produce "got: ". */
const ECHO_SRC = [
  'format ELF64 executable 3',
  'entry start',
  '',
  'segment readable executable',
  '',
  'start:',
  '\tmov eax, 0',
  '\tmov edi, 0',
  '\tmov esi, buf',
  '\tmov edx, 32',
  '\tsyscall',
  '\tmov r12d, eax',
  '\tmov eax, 1',
  '\tmov edi, 1',
  '\tmov esi, prefix',
  '\tmov edx, prefix_len',
  '\tsyscall',
  '\tmov eax, 1',
  '\tmov edi, 1',
  '\tmov esi, buf',
  '\tmov edx, r12d',
  '\tsyscall',
  '\tmov eax, 60',
  '\txor edi, edi',
  '\tsyscall',
  '',
  'segment readable writeable',
  '',
  "prefix db 'got: '",
  'prefix_len = $ - prefix',
  'buf rb 32',
  '',
].join('\n');

/** The PE64 equivalent of ECHO_SRC above, for the Windows suite below: reads up to 32 bytes from
 * stdin via ReadFile, writes "got: " followed by exactly what it read via WriteFile, then exits.
 * Same "got: " reasoning as ECHO_SRC — a relay that just echoed the raw bytes back would pass this
 * test without the program, or gdb's -inferior-tty-set, ever being involved. */
const PE_ECHO_SRC = [
  'format PE64 console',
  'entry start',
  // Included directly, rather than injected with fasm2's own "-i" flag the way the Linux fixture
  // below does it: that flag's value has to survive a shell, and the official Windows fasm2 is a
  // ".cmd" wrapper Node can only reach via one — exactly the kind of cmd.exe/PowerShell quoting
  // mismatch the extension itself had to fix once already (CHANGELOG 1.27.1). Not worth fighting
  // in a test when the include line can just be part of the fixture instead.
  "include 'listing.inc'",
  '',
  "include 'win64a.inc'",
  '',
  "section '.text' code readable executable",
  '',
  'start:',
  '\tsub     rsp, 40',
  '\tinvoke  GetStdHandle, STD_INPUT_HANDLE',
  '\tmov     [hStdin], rax',
  '\tinvoke  GetStdHandle, STD_OUTPUT_HANDLE',
  '\tmov     [hStdout], rax',
  '\tinvoke  ReadFile, [hStdin], buf, 32, bytesRead, 0',
  '\tinvoke  WriteFile, [hStdout], prefix, prefix_len, written, 0',
  '\tmov     eax, [bytesRead]',
  '\tmov     [writeLen], eax',
  '\tinvoke  WriteFile, [hStdout], buf, [writeLen], written, 0',
  '\tinvoke  ExitProcess, 0',
  '',
  "section '.data' data readable writeable",
  '',
  "prefix db 'got: '",
  'prefix_len = $ - prefix',
  'buf rb 32',
  'hStdin dq ?',
  'hStdout dq ?',
  'bytesRead dd ?',
  'writeLen dd ?',
  'written dq ?',
  '',
  "section '.idata' import data readable writeable",
  '',
  "library kernel32, 'KERNEL32.DLL'",
  "import kernel32, GetStdHandle, 'GetStdHandle', ReadFile, 'ReadFile', WriteFile, 'WriteFile', ExitProcess, 'ExitProcess'",
  '',
].join('\n');

const TYPED_LINE = 'hello from a real terminal';

function waitFor(predicate: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = (): void => {
      if (predicate()) return resolve();
      if (Date.now() >= deadline) return reject(new Error(`timed out waiting for ${what}`));
      setTimeout(tick, 50);
    };
    tick();
  });
}

describe('console: integratedTerminal (real adapter.js, real gdb, real pty)', function () {
  let dir: string;
  let asmPath: string;
  let programPath: string;
  let listingPath: string;
  const available = isAvailable('gdb') && isAvailable('fasm2') && isAvailable('script') && os.platform() === 'linux';

  before(function () {
    if (!available) {
      this.skip();
      return;
    }
    dir = makeTempDir('fasm2-studio-tty-e2e-');
    asmPath = path.join(dir, 'prog.asm');
    programPath = path.join(dir, 'prog');
    listingPath = path.join(dir, 'prog.lst');
    fs.writeFileSync(asmPath, ECHO_SRC, 'utf8');

    const build = spawnSync('fasm2', ['-i', "include 'listing.inc'", asmPath, programPath], { cwd: dir, timeout: 15000 });
    if (build.status !== 0) throw new Error(`fasm2 build failed:\n${build.stdout}\n${build.stderr}`);
    fs.chmodSync(programPath, 0o755);
  });

  after(async () => {
    await removeTempDir(dir);
  });

  it('carries typed input into the program and its output back out, instead of the Debug Console', async function () {
    this.timeout(40000);

    const proc = spawn(process.execPath, [path.join(__dirname, '..', 'dist', 'adapter.js')], { stdio: ['pipe', 'pipe', 'pipe'] });
    const client = new DapClient(proc);
    const stderrChunks: string[] = [];
    proc.stderr.on('data', (c: Buffer) => stderrChunks.push(c.toString('utf8')));

    let terminal: ChildProcess | undefined;
    let terminalOutput = '';

    // The client's side of runInTerminal: open a terminal and run the given command vector in it.
    client.onReverseRequest('runInTerminal', (args) => {
      const { args: argv, cwd } = args as { args: string[]; cwd: string };
      // `script -c` runs one shell command line under a fresh pty, which is exactly the property a
      // terminal has and a pipe does not.
      const commandLine = argv.map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(' ');
      terminal = spawn('script', ['-q', '-c', commandLine, '/dev/null'], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
      terminal.stdout?.on('data', (c: Buffer) => {
        terminalOutput += c.toString('utf8');
      });
      return { shellProcessId: terminal.pid };
    });

    try {
      await client.sendRequest('initialize', {
        adapterID: 'fasm2',
        linesStartAt1: true,
        columnsStartAt1: true,
        pathFormat: 'path',
        supportsRunInTerminalRequest: true,
      });
      await client.waitForEvent('initialized');

      await client.sendRequest('launch', {
        program: programPath,
        asmFile: asmPath,
        listingFile: listingPath,
        cwd: dir,
        console: 'integratedTerminal',
        stopOnEntry: false,
      });

      // Not necessarily sent by the time the launch response lands: the terminal is set up
      // alongside the launch and only has to be settled by configurationDone, which is the last
      // moment before the program starts.
      await waitFor(() => client.reverseRequests.length > 0, 5000, 'the adapter to ask the client for a terminal');
      assert.deepStrictEqual(
        client.reverseRequests.map((r) => r.command),
        ['runInTerminal'],
        'the adapter asked the client for something other than a terminal',
      );
      assert.ok(terminal, 'no terminal was started');

      await client.sendRequest('configurationDone');

      // The program is now blocked in read(2) on the pty. Type at it.
      terminal!.stdin!.write(`${TYPED_LINE}\n`);

      await waitFor(() => terminalOutput.includes(`got: ${TYPED_LINE}`), 15000, 'the program to answer on the terminal');
      await client.waitForEvent('terminated');

      // The same bytes must not have gone to the Debug Console: that is the whole difference
      // between this mode and the default one.
      assert.ok(!client.output().includes(`got: ${TYPED_LINE}`), `the program's output also reached the Debug Console:\n${client.output()}`);

      await client.sendRequest('disconnect');

      // Ending the session drops the agent's connection, and the agent stops holding the terminal
      // open — after offering the keypress that keeps the program's last output on screen, which
      // is what this test answers with.
      await waitFor(() => /press Enter/.test(terminalOutput), 10000, 'the agent to offer to close the terminal');
      terminal!.stdin!.write('\n');
      await waitFor(() => terminal!.exitCode !== null || terminal!.signalCode !== null, 10000, 'the terminal agent to exit');
    } catch (err) {
      throw new Error(`${(err as Error).message}\n--- terminal ---\n${terminalOutput}\n--- adapter stderr ---\n${stderrChunks.join('')}`);
    } finally {
      terminal?.kill();
      proc.kill();
    }
  });

  it('uses a terminal opened before the session started, which is how the extension does it', async function () {
    this.timeout(40000);

    // The extension's route (extension/src/inferiorTerminal.ts): it opens the terminal itself, with
    // the agent as the terminal's own process, and tells the session where to listen. Nothing asks
    // the client to run anything, so no shell is anywhere near this — the agent is simply already
    // out there, reconnecting until the adapter is listening.
    const endpoint = path.join(dir, 'endpoint.sock');
    const agentArgv = `'${process.execPath}' '${path.join(__dirname, '..', 'dist', 'adapter.js')}' --terminal-agent '${endpoint}'`;
    const terminal = spawn('script', ['-q', '-c', agentArgv, '/dev/null'], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] });
    let terminalOutput = '';
    terminal.stdout?.on('data', (c: Buffer) => (terminalOutput += c.toString('utf8')));

    const proc = spawn(process.execPath, [path.join(__dirname, '..', 'dist', 'adapter.js')], { stdio: ['pipe', 'pipe', 'pipe'] });
    const client = new DapClient(proc);

    try {
      await client.sendRequest('initialize', {
        adapterID: 'fasm2',
        linesStartAt1: true,
        columnsStartAt1: true,
        pathFormat: 'path',
        supportsRunInTerminalRequest: true,
      });
      await client.waitForEvent('initialized');

      await client.sendRequest('launch', {
        program: programPath,
        asmFile: asmPath,
        listingFile: listingPath,
        cwd: dir,
        console: 'integratedTerminal',
        terminalEndpoint: endpoint,
        stopOnEntry: false,
      });

      assert.deepStrictEqual(client.reverseRequests, [], 'the client was asked to open a terminal even though one was handed to the session');

      await client.sendRequest('configurationDone');
      terminal.stdin!.write(`${TYPED_LINE}\n`);

      await waitFor(() => terminalOutput.includes(`got: ${TYPED_LINE}`), 15000, 'the program to answer on the terminal');
      await client.waitForEvent('terminated');
      assert.ok(!client.output().includes(`got: ${TYPED_LINE}`), `the program's output also reached the Debug Console:\n${client.output()}`);

      await client.sendRequest('disconnect');
      await waitFor(() => /press Enter/.test(terminalOutput), 10000, 'the agent to offer to close the terminal');
    } catch (err) {
      throw new Error(`${(err as Error).message}\n--- terminal ---\n${terminalOutput}`);
    } finally {
      terminal.kill();
      proc.kill();
    }
  });

  it('falls back to the Debug Console, and says so, when the client cannot open a terminal', async function () {
    this.timeout(40000);

    const proc = spawn(process.execPath, [path.join(__dirname, '..', 'dist', 'adapter.js')], { stdio: ['pipe', 'pipe', 'pipe'] });
    const client = new DapClient(proc);

    try {
      // No supportsRunInTerminalRequest: this is what an older or minimal DAP client looks like.
      await client.sendRequest('initialize', { adapterID: 'fasm2', linesStartAt1: true, columnsStartAt1: true, pathFormat: 'path' });
      await client.waitForEvent('initialized');

      await client.sendRequest('launch', {
        program: programPath,
        asmFile: asmPath,
        listingFile: listingPath,
        cwd: dir,
        console: 'integratedTerminal',
        stopOnEntry: false,
      });

      assert.deepStrictEqual(client.reverseRequests, [], 'a client that never declared runInTerminal support should not be asked');
      await waitFor(() => /cannot open a terminal/.test(client.output()), 5000, 'the fallback to be explained');

      // The launch still happened: degrading is not the same as failing.
      await client.sendRequest('configurationDone');
      await client.sendRequest('disconnect');
    } finally {
      proc.kill();
    }
  });
});

/**
 * The Windows equivalent of the suite above: no pty, so no `script` — the "terminal" here is just
 * an ordinary piped child process running the agent command exactly as VS Code's own `runInTerminal`
 * would, and what makes it act as one is entirely gdb's `-inferior-tty-set` pointed at the pipe this
 * agent hosts (session.ts's attachInferiorTerminal, terminalAgent.ts's listenForInferior) rather
 * than anything pty-shaped about the process itself — the same property a plain pipe does not have
 * on POSIX, and the reason that suite needs a real pty stand-in and this one does not.
 */
describe('console: integratedTerminal on Windows (real adapter.js, real gdb, a named pipe instead of a pty)', function () {
  let dir: string;
  let asmPath: string;
  let programPath: string;
  let listingPath: string;
  const gdbAvailable = isAvailable('gdb');
  // fasm2's official Windows distribution is a `.cmd` wrapper — spawnSync only resolves that
  // through a shell, unlike gdb.exe above, which is a real executable.
  const fasm2Available = os.platform() === 'win32' && !spawnSync('fasm2', ['--version'], { shell: true, timeout: 5000 }).error;

  before(function () {
    if (!gdbAvailable || !fasm2Available || os.platform() !== 'win32') {
      this.skip();
      return;
    }
    dir = makeTempDir('fasm2-studio-tty-e2e-win-');
    asmPath = path.join(dir, 'prog.asm');
    programPath = path.join(dir, 'prog.exe');
    listingPath = path.join(dir, 'prog.lst');
    fs.writeFileSync(asmPath, PE_ECHO_SRC, 'utf8');

    const build = spawnSync('fasm2', [asmPath, programPath], { cwd: dir, shell: true, timeout: 15000 });
    if (build.status !== 0) throw new Error(`fasm2 build failed:\n${build.stdout}\n${build.stderr}`);
  });

  after(async () => {
    await removeTempDir(dir);
  });

  it('carries typed input into the program and its output back out, instead of the Debug Console', async function () {
    this.timeout(40000);

    const proc = spawn(process.execPath, [path.join(__dirname, '..', 'dist', 'adapter.js')], { stdio: ['pipe', 'pipe', 'pipe'] });
    const client = new DapClient(proc);
    const stderrChunks: string[] = [];
    proc.stderr.on('data', (c: Buffer) => stderrChunks.push(c.toString('utf8')));

    let terminal: ChildProcess | undefined;
    let terminalOutput = '';

    // The client's side of runInTerminal: run the given command vector in a plain child process.
    // No pty and no shell — exactly the command vector agentCommand builds, run directly, which is
    // also exactly what makes it safe for VS Code's real runInTerminal to type into an actual shell.
    client.onReverseRequest('runInTerminal', (args) => {
      const { args: argv, cwd } = args as { args: string[]; cwd: string };
      terminal = spawn(argv[0], argv.slice(1), { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
      terminal.stdout?.on('data', (c: Buffer) => {
        terminalOutput += c.toString('utf8');
      });
      return { shellProcessId: terminal.pid };
    });

    try {
      await client.sendRequest('initialize', {
        adapterID: 'fasm2',
        linesStartAt1: true,
        columnsStartAt1: true,
        pathFormat: 'path',
        supportsRunInTerminalRequest: true,
      });
      await client.waitForEvent('initialized');

      await client.sendRequest('launch', {
        program: programPath,
        asmFile: asmPath,
        listingFile: listingPath,
        cwd: dir,
        console: 'integratedTerminal',
        stopOnEntry: false,
      });

      await waitFor(() => client.reverseRequests.length > 0, 5000, 'the adapter to ask the client for a terminal');
      assert.deepStrictEqual(
        client.reverseRequests.map((r) => r.command),
        ['runInTerminal'],
        'the adapter asked the client for something other than a terminal',
      );
      assert.ok(terminal, 'no terminal was started');

      await client.sendRequest('configurationDone');

      // The program is now blocked in ReadFile on the pipe the agent is hosting. Type at it.
      terminal!.stdin!.write(`${TYPED_LINE}\n`);

      await waitFor(() => terminalOutput.includes(`got: ${TYPED_LINE}`), 15000, 'the program to answer on the terminal');
      await client.waitForEvent('terminated');

      // The same bytes must not have gone to the Debug Console: that is the whole difference
      // between this mode and the default one.
      assert.ok(!client.output().includes(`got: ${TYPED_LINE}`), `the program's output also reached the Debug Console:\n${client.output()}`);

      await client.sendRequest('disconnect');

      // Ending the session drops the agent's handshake connection, and the agent stops holding the
      // terminal open — after offering the keypress that keeps the program's last output on screen.
      await waitFor(() => /press Enter/.test(terminalOutput), 10000, 'the agent to offer to close the terminal');
      terminal!.stdin!.write('\n');
      await waitFor(() => terminal!.exitCode !== null || terminal!.signalCode !== null, 10000, 'the terminal agent to exit');
    } catch (err) {
      throw new Error(`${(err as Error).message}\n--- terminal ---\n${terminalOutput}\n--- adapter stderr ---\n${stderrChunks.join('')}`);
    } finally {
      terminal?.kill();
      proc.kill();
    }
  });

  it('falls back to the Debug Console, and says so, when the client cannot open a terminal', async function () {
    this.timeout(40000);

    const proc = spawn(process.execPath, [path.join(__dirname, '..', 'dist', 'adapter.js')], { stdio: ['pipe', 'pipe', 'pipe'] });
    const client = new DapClient(proc);

    try {
      await client.sendRequest('initialize', { adapterID: 'fasm2', linesStartAt1: true, columnsStartAt1: true, pathFormat: 'path' });
      await client.waitForEvent('initialized');

      await client.sendRequest('launch', {
        program: programPath,
        asmFile: asmPath,
        listingFile: listingPath,
        cwd: dir,
        console: 'integratedTerminal',
        stopOnEntry: false,
      });

      assert.deepStrictEqual(client.reverseRequests, [], 'a client that never declared runInTerminal support should not be asked');
      await waitFor(() => /cannot open a terminal/.test(client.output()), 5000, 'the fallback to be explained');

      await client.sendRequest('configurationDone');
      await client.sendRequest('disconnect');
    } finally {
      proc.kill();
    }
  });
});
