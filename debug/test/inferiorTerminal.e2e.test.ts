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
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fasm2-studio-tty-e2e-'));
    asmPath = path.join(dir, 'prog.asm');
    programPath = path.join(dir, 'prog');
    listingPath = path.join(dir, 'prog.lst');
    fs.writeFileSync(asmPath, ECHO_SRC, 'utf8');

    const build = spawnSync('fasm2', ['-i', "include 'listing.inc'", asmPath, programPath], { cwd: dir, timeout: 15000 });
    if (build.status !== 0) throw new Error(`fasm2 build failed:\n${build.stdout}\n${build.stderr}`);
    fs.chmodSync(programPath, 0o755);
  });

  after(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
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

      assert.deepStrictEqual(
        client.reverseRequests.map((r) => r.command),
        ['runInTerminal'],
        'the adapter never asked the client for a terminal',
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

      // Ending the session releases the terminal holder, so the terminal is not left with a stray
      // shell sleeping in it forever.
      await waitFor(() => terminal!.exitCode !== null || terminal!.signalCode !== null, 10000, 'the terminal holder to exit');
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
