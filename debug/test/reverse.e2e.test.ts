// Reverse debugging, end to end against real gdb: record the run, step backwards over an
// instruction that overwrote a register, and read the register's *previous* value back out.
//
// Worth an end-to-end test rather than a unit one because nothing here is our own logic — it is
// entirely a question of whether gdb accepts the MI we send it. `record` has no MI form at all
// (it goes through -interpreter-exec), the reverse execution commands take a `--reverse` flag
// rather than being separate commands, and getting either wrong fails only at runtime, against a
// real debugger, in a way no amount of type checking would catch.
import * as assert from 'assert';
import { ChildProcessWithoutNullStreams, spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DapClient, isAvailable } from './dapClient';

// eax is deliberately given a distinctive value and then clobbered twice. Stepping back across the
// clobber has to restore the value that came *before* it — which is the whole promise of the
// feature, and is not something a forward-only debugger can answer at all.
const PROGRAM_SRC = [
  'format ELF64 executable 3',
  'entry start',
  '',
  'segment readable executable',
  '',
  'start:',
  '\tmov eax, 111',
  '\tmov eax, 222',
  '\tnop',
  '\tmov edi, 0',
  '\tmov eax, 60',
  '\tsyscall',
  '',
].join('\n');

async function findRegisterValue(client: DapClient, registersRef: number, registerName: string): Promise<string | undefined> {
  const groups = await client.sendRequest<{ variables: Array<{ name: string; variablesReference: number }> }>('variables', {
    variablesReference: registersRef,
  });
  for (const group of groups.variables) {
    const members = await client.sendRequest<{ variables: Array<{ name: string; value: string }> }>('variables', {
      variablesReference: group.variablesReference,
    });
    const match = members.variables.find((v) => v.name === registerName);
    if (match) return match.value;
  }
  return undefined;
}

async function registersScopeRef(client: DapClient): Promise<number> {
  const scopes = await client.sendRequest<{ scopes: Array<{ name: string; variablesReference: number }> }>('scopes', { frameId: 1 });
  const registers = scopes.scopes.find((s) => s.name === 'Registers');
  if (!registers) throw new Error('no Registers scope');
  return registers.variablesReference;
}

describe('reverse debugging end-to-end (real adapter.js, real gdb execution recording)', function () {
  let dir: string;
  let asmPath: string;
  let programPath: string;
  let listingPath: string;
  const gdbAvailable = isAvailable('gdb');
  const fasm2Available = isAvailable('fasm2');

  before(function () {
    if (!gdbAvailable || !fasm2Available || os.platform() !== 'linux') {
      this.skip();
      return;
    }
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fasm2-studio-reverse-e2e-'));
    asmPath = path.join(dir, 'prog.asm');
    programPath = path.join(dir, 'prog');
    listingPath = path.join(dir, 'prog.lst');
    fs.writeFileSync(asmPath, PROGRAM_SRC, 'utf8');

    const build = spawnSync('fasm2', ['-i', "include 'listing.inc'", asmPath, programPath], { cwd: dir, timeout: 15000 });
    if (build.status !== 0) throw new Error(`fasm2 build failed:\n${build.stdout}\n${build.stderr}`);
    fs.chmodSync(programPath, 0o755);
  });

  after(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('records the run, announces stepBack support, and restores a clobbered register by stepping back', async function () {
    this.timeout(40000);

    const proc: ChildProcessWithoutNullStreams = spawn(process.execPath, [path.join(__dirname, '..', 'dist', 'adapter.js')], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const client = new DapClient(proc);
    const stderrChunks: string[] = [];
    proc.stderr.on('data', (c: Buffer) => stderrChunks.push(c.toString('utf8')));

    try {
      const initResponse = await client.sendRequest<{ supportsStepBack?: boolean }>('initialize', {
        adapterID: 'fasm2',
        linesStartAt1: true,
        columnsStartAt1: true,
        pathFormat: 'path',
      });
      // Not known this early: the launch arguments haven't arrived, and whether the debugger can
      // record at all isn't established until it accepts the command.
      assert.notStrictEqual(initResponse.supportsStepBack, true, 'stepBack must not be claimed before recording is actually on');

      await client.waitForEvent('initialized');

      // The capabilities event has to arrive for the client to ever show a Step Back button, so it
      // is awaited rather than assumed — and it is the signal that "record full" was accepted.
      const capabilities = client.waitForEvent('capabilities', (b) => (b as { capabilities?: { supportsStepBack?: boolean } }).capabilities?.supportsStepBack === true);

      await client.sendRequest('launch', {
        program: programPath,
        asmFile: asmPath,
        listingFile: listingPath,
        cwd: dir,
        reverseDebugging: true,
      });
      await client.sendRequest('configurationDone');

      // reverseDebugging implies stopping at the entry point, whether or not stopOnEntry was set —
      // recording cannot start after the code it is meant to record has already run.
      await client.waitForEvent('stopped');
      await capabilities;

      await client.sendRequest('setBreakpoints', {
        source: { path: asmPath },
        breakpoints: [{ line: 9 }], // "nop", i.e. after both writes to eax
      });
      await client.sendRequest('continue', { threadId: 1 });
      await client.waitForEvent('stopped', (b) => (b as { reason?: string }).reason === 'breakpoint');

      const atBreakpoint = await findRegisterValue(client, await registersScopeRef(client), 'rax');
      assert.ok(atBreakpoint && /\b222\b/.test(atBreakpoint), `expected eax to hold 222 at the breakpoint, got: ${atBreakpoint}`);

      // Back over "mov eax, 222" — the value that instruction destroyed has to come back.
      await client.sendRequest('stepBack', { threadId: 1, granularity: 'instruction' });
      await client.waitForEvent('stopped');

      const afterStepBack = await findRegisterValue(client, await registersScopeRef(client), 'rax');
      assert.ok(
        afterStepBack && /\b111\b/.test(afterStepBack),
        `expected stepping back over "mov eax, 222" to restore eax to 111, got: ${afterStepBack}`,
      );

      await client.sendRequest('disconnect');
    } catch (err) {
      throw new Error(`${(err as Error).message}\n--- adapter stderr ---\n${stderrChunks.join('')}`);
    } finally {
      proc.kill();
    }
  });

  it('refuses a stepBack on a session that was never recording, instead of handing gdb a command it will reject', async function () {
    this.timeout(30000);

    const proc: ChildProcessWithoutNullStreams = spawn(process.execPath, [path.join(__dirname, '..', 'dist', 'adapter.js')], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const client = new DapClient(proc);

    try {
      await client.sendRequest('initialize', { adapterID: 'fasm2', linesStartAt1: true, columnsStartAt1: true, pathFormat: 'path' });
      await client.waitForEvent('initialized');
      // No reverseDebugging: this is an ordinary launch, and Step Back must not silently do
      // something arbitrary.
      await client.sendRequest('launch', { program: programPath, asmFile: asmPath, listingFile: listingPath, cwd: dir, stopOnEntry: true });
      await client.sendRequest('configurationDone');
      await client.waitForEvent('stopped');

      await assert.rejects(
        () => client.sendRequest('stepBack', { threadId: 1 }),
        /no execution history|reverseDebugging/i,
        'expected a clear refusal naming the setting that would enable it',
      );

      await client.sendRequest('disconnect');
    } finally {
      proc.kill();
    }
  });
});
