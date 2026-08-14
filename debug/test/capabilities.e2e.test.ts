// End-to-end coverage for the debug capabilities added alongside the existing ones: conditional /
// hit-count / log breakpoints, function and instruction breakpoints, watchpoints, raw memory
// read/write, set-next-statement, restart, program arguments and environment, and signal reporting.
//
// Same approach as session.e2e.test.ts: spawn the real built adapter.js, speak raw DAP framing to
// it, and let it drive a real gdb against a real fasm2-assembled binary. Nothing is mocked, so a
// passing test here means the capability genuinely works rather than that the adapter answers the
// request.
import * as assert from 'assert';
import { spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DapClient, isAvailable } from './dapClient';
import { makeTempDir, removeTempDir } from './tempDir';

/** Counts to 5 in ebx, then writes a value to a data label and exits. Chosen so a conditional
 * breakpoint, a hit-count breakpoint and a watchpoint all have something real to observe. */
const LOOP_SRC = [
  'format ELF64 executable 3',
  'entry start',
  '',
  'segment readable executable',
  '',
  'start:',
  '\tmov ebx, 0',
  'again:',
  '\tinc ebx',
  '\tmov [counter], ebx',
  '\tcmp ebx, 5',
  '\tjl again',
  'done:',
  '\tmov edi, 0',
  '\tmov eax, 60',
  '\tsyscall',
  '',
  'segment readable writeable',
  'counter dd 0',
  "greeting db 'hi', 0",
  '',
].join('\n');

/** Dereferences a null pointer, to produce a real SIGSEGV. */
const CRASH_SRC = [
  'format ELF64 executable 3',
  'entry start',
  '',
  'segment readable executable',
  '',
  'start:',
  '\txor rax, rax',
  '\tmov rbx, [rax]',
  '\tmov eax, 60',
  '\tsyscall',
  '',
].join('\n');

interface Fixture {
  dir: string;
  asmPath: string;
  programPath: string;
  listingPath: string;
}

/** Every fixture `build` has created, for the `after` hook to remove — see its comment below. */
const builtFixtures: Fixture[] = [];

function build(name: string, source: string): Fixture {
  const dir = makeTempDir(`fasm2-studio-cap-${name}-`);
  const fixture: Fixture = {
    dir,
    asmPath: path.join(dir, `${name}.asm`),
    programPath: path.join(dir, name),
    listingPath: path.join(dir, `${name}.lst`),
  };
  // Recorded before the build can fail, so a directory that was created still gets cleaned up.
  builtFixtures.push(fixture);
  fs.writeFileSync(fixture.asmPath, source, 'utf8');
  const result = spawnSync('fasm2', ['-i', "include 'listing.inc'", fixture.asmPath, fixture.programPath], { cwd: dir, timeout: 15000 });
  if (result.status !== 0) throw new Error(`fasm2 build failed:\n${result.stdout}\n${result.stderr}`);
  fs.chmodSync(fixture.programPath, 0o755);
  return fixture;
}

describe('FasmDebugSession capabilities end-to-end (real adapter.js, real gdb, real fasm2 binary)', function () {
  let loop: Fixture;
  let crash: Fixture;
  const canRun = isAvailable('gdb') && isAvailable('fasm2') && os.platform() === 'linux';

  before(function () {
    if (!canRun) {
      this.skip();
      return;
    }
    loop = build('loop', LOOP_SRC);
    crash = build('crash', CRASH_SRC);
  });

  // Cleans up whatever `build` actually created, rather than naming `loop`/`crash` directly.
  // Mocha runs a suite's `after` hook even when its `before` called this.skip(), so on a machine
  // without fasm2 this ran with both still undefined — reading `.dir` off one threw, and a suite
  // that had correctly skipped itself failed the whole run instead. Tracking the built fixtures
  // also covers the half-built case, where the second `build` throws and the first's directory
  // would otherwise be left behind.
  after(async () => {
    for (const fixture of builtFixtures) {
      await removeTempDir(fixture.dir);
    }
  });

  /** Boots an adapter, initializes and launches it against `fixture`, and hands back the client. */
  async function start(fixture: Fixture, launchExtras: Record<string, unknown> = {}) {
    const proc = spawn(process.execPath, [path.join(__dirname, '..', 'dist', 'adapter.js')], { stdio: ['pipe', 'pipe', 'pipe'] });
    const client = new DapClient(proc);
    const stderrChunks: string[] = [];
    proc.stderr.on('data', (c: Buffer) => stderrChunks.push(c.toString('utf8')));

    const capabilities = await client.sendRequest<Record<string, boolean>>('initialize', {
      adapterID: 'fasm2',
      linesStartAt1: true,
      columnsStartAt1: true,
      pathFormat: 'path',
    });
    await client.waitForEvent('initialized');
    await client.sendRequest('launch', {
      program: fixture.programPath,
      asmFile: fixture.asmPath,
      listingFile: fixture.listingPath,
      cwd: fixture.dir,
      ...launchExtras,
    });
    return { proc, client, capabilities, stderr: () => stderrChunks.join('') };
  }

  it('declares every capability the new UI affordances are gated on', async function () {
    this.timeout(30000);
    const { proc, capabilities } = await start(loop);
    try {
      for (const capability of [
        'supportsConditionalBreakpoints',
        'supportsHitConditionalBreakpoints',
        'supportsLogPoints',
        'supportsFunctionBreakpoints',
        'supportsInstructionBreakpoints',
        'supportsDataBreakpoints',
        'supportsReadMemoryRequest',
        'supportsWriteMemoryRequest',
        'supportsGotoTargetsRequest',
        'supportsRestartRequest',
        'supportsExceptionInfoRequest',
        'supportsCompletionsRequest',
      ]) {
        assert.strictEqual(capabilities[capability], true, `${capability} not declared`);
      }
    } finally {
      proc.kill();
    }
  });

  it('completes a partly-typed Debug Console command from gdb\'s own command set', async function () {
    this.timeout(30000);
    const { proc, client, stderr } = await start(loop);
    try {
      // The Debug Console is a raw gdb command line, so the completions have to come from gdb
      // rather than a list baked into the adapter — "info reg" is a command only gdb knows.
      const completions = await client.sendRequest<{ targets: Array<{ label: string; start?: number; length?: number }> }>(
        'completions',
        { text: 'info reg', column: 9 },
      );
      const labels = completions.targets.map((t) => t.label);
      assert.ok(labels.includes('info registers'), `expected "info registers" among ${JSON.stringify(labels)}`);
      // Whole-command matches replace everything typed, rather than appending to it.
      assert.strictEqual(completions.targets[0].start, 0);
      assert.strictEqual(completions.targets[0].length, 8);
    } catch (err) {
      throw new Error(`${(err as Error).message}\n--- adapter stderr ---\n${stderr()}`);
    } finally {
      proc.kill();
    }
  });

  it('answers an empty list rather than failing when there is nothing to complete', async function () {
    this.timeout(30000);
    const { proc, client, stderr } = await start(loop);
    try {
      const completions = await client.sendRequest<{ targets: unknown[] }>('completions', { text: '', column: 1 });
      assert.deepStrictEqual(completions.targets, []);
    } catch (err) {
      throw new Error(`${(err as Error).message}\n--- adapter stderr ---\n${stderr()}`);
    } finally {
      proc.kill();
    }
  });

  it('stops a conditional breakpoint only once its condition holds', async function () {
    this.timeout(30000);
    const { proc, client, stderr } = await start(loop);
    try {
      // Line 10 is "mov [counter], ebx", inside the loop — it runs five times, but $ebx == 4 on
      // exactly one of them.
      const bp = await client.sendRequest<{ breakpoints: Array<{ verified: boolean }> }>('setBreakpoints', {
        source: { path: loop.asmPath },
        breakpoints: [{ line: 10, condition: '$ebx == 4' }],
      });
      assert.strictEqual(bp.breakpoints[0].verified, true);

      await client.sendRequest('configurationDone');
      await client.waitForEvent('stopped', (b) => (b as { reason?: string }).reason === 'breakpoint');

      const value = await client.sendRequest<{ result: string }>('evaluate', { expression: '$ebx', context: 'watch' });
      assert.match(value.result, /\b4\b/, `expected to stop with ebx == 4, got ${value.result}`);

      await client.sendRequest('continue', { threadId: 1 });
      await client.waitForEvent('terminated');
    } catch (err) {
      throw new Error(`${(err as Error).message}\n--- adapter stderr ---\n${stderr()}`);
    } finally {
      proc.kill();
    }
  });

  it('ignores the first N hits of a hit-count breakpoint', async function () {
    this.timeout(30000);
    const { proc, client, stderr } = await start(loop);
    try {
      await client.sendRequest('setBreakpoints', {
        source: { path: loop.asmPath },
        breakpoints: [{ line: 10, hitCondition: '3' }],
      });
      await client.sendRequest('configurationDone');
      await client.waitForEvent('stopped', (b) => (b as { reason?: string }).reason === 'breakpoint');

      // Three hits ignored, so the first stop is on the fourth pass, where ebx == 4.
      const value = await client.sendRequest<{ result: string }>('evaluate', { expression: '$ebx', context: 'watch' });
      assert.match(value.result, /\b4\b/, `expected the 4th hit (ebx == 4), got ${value.result}`);
      // gdb's ignore count only skips the *first* N hits — the fifth pass stops too, so the
      // program needs resuming more than once to reach the end.
      await client.sendRequest('continue', { threadId: 1 });
    } catch (err) {
      throw new Error(`${(err as Error).message}\n--- adapter stderr ---\n${stderr()}`);
    } finally {
      proc.kill();
    }
  });

  it('prints a log point with its {expression} interpolated, and never stops on it', async function () {
    this.timeout(30000);
    const { proc, client, stderr } = await start(loop);
    try {
      await client.sendRequest('setBreakpoints', {
        source: { path: loop.asmPath },
        breakpoints: [{ line: 10, logMessage: 'counter is now {$ebx}' }],
      });
      await client.sendRequest('configurationDone');
      // The program must run to completion: a log point that stopped would never terminate here.
      await client.waitForEvent('terminated');

      const output = client.output();
      assert.match(output, /counter is now 1/, `expected interpolated log output, got: ${JSON.stringify(output)}`);
      assert.match(output, /counter is now 5/, `expected all five iterations logged, got: ${JSON.stringify(output)}`);
      assert.ok(
        !client.events.some((e) => e.event === 'stopped' && (e.body as { reason?: string }).reason === 'breakpoint'),
        'a log point must not raise a stopped event',
      );
    } catch (err) {
      throw new Error(`${(err as Error).message}\n--- adapter stderr ---\n${stderr()}`);
    } finally {
      proc.kill();
    }
  });

  it('sets a function breakpoint on a label by name, resolved through the listing', async function () {
    this.timeout(30000);
    const { proc, client, stderr } = await start(loop);
    try {
      const result = await client.sendRequest<{ breakpoints: Array<{ verified: boolean; instructionReference?: string }> }>('setFunctionBreakpoints', {
        breakpoints: [{ name: 'done' }, { name: 'no_such_label' }],
      });
      assert.strictEqual(result.breakpoints[0].verified, true, 'expected "done" to resolve from the listing');
      assert.ok(result.breakpoints[0].instructionReference, 'expected an address for the resolved label');
      assert.strictEqual(result.breakpoints[1].verified, false, 'a label that does not exist must not verify');

      await client.sendRequest('configurationDone');
      await client.waitForEvent('stopped', (b) => (b as { reason?: string }).reason === 'breakpoint');

      const stack = await client.sendRequest<{ stackFrames: Array<{ line: number }> }>('stackTrace', { threadId: 1 });
      // "done:" is a bare label, so its address belongs to the next real instruction, on line 14.
      assert.strictEqual(stack.stackFrames[0].line, 14, 'expected to stop at the "done:" label');

      await client.sendRequest('continue', { threadId: 1 });
      await client.waitForEvent('terminated');
    } catch (err) {
      throw new Error(`${(err as Error).message}\n--- adapter stderr ---\n${stderr()}`);
    } finally {
      proc.kill();
    }
  });

  it('sets an instruction breakpoint at a raw address, as the disassembly view does', async function () {
    this.timeout(30000);
    const { proc, client, stderr } = await start(loop);
    try {
      const resolved = await client.sendRequest<{ breakpoints: Array<{ instructionReference?: string }> }>('setFunctionBreakpoints', {
        breakpoints: [{ name: 'done' }],
      });
      const address = resolved.breakpoints[0].instructionReference!;
      // Clear the function breakpoint so only the instruction one can be what stops us.
      await client.sendRequest('setFunctionBreakpoints', { breakpoints: [] });

      const result = await client.sendRequest<{ breakpoints: Array<{ verified: boolean }> }>('setInstructionBreakpoints', {
        breakpoints: [{ instructionReference: address }],
      });
      assert.strictEqual(result.breakpoints[0].verified, true);

      await client.sendRequest('configurationDone');
      await client.waitForEvent('stopped', (b) => (b as { reason?: string }).reason === 'breakpoint');

      const stack = await client.sendRequest<{ stackFrames: Array<{ line: number }> }>('stackTrace', { threadId: 1 });
      assert.strictEqual(stack.stackFrames[0].line, 14);

      await client.sendRequest('continue', { threadId: 1 });
      await client.waitForEvent('terminated');
    } catch (err) {
      throw new Error(`${(err as Error).message}\n--- adapter stderr ---\n${stderr()}`);
    } finally {
      proc.kill();
    }
  });

  it('breaks on a data label being written, via a real gdb watchpoint', async function () {
    this.timeout(30000);
    const { proc, client, stderr } = await start(loop);
    try {
      const info = await client.sendRequest<{ dataId: string | null; description: string }>('dataBreakpointInfo', { name: 'counter' });
      assert.ok(info.dataId, `expected a dataId for the "counter" label, got ${JSON.stringify(info)}`);

      const set = await client.sendRequest<{ breakpoints: Array<{ verified: boolean }> }>('setDataBreakpoints', {
        breakpoints: [{ dataId: info.dataId, accessType: 'write' }],
      });
      assert.strictEqual(set.breakpoints[0].verified, true, 'expected the watchpoint to be accepted by gdb');

      await client.sendRequest('configurationDone');
      await client.waitForEvent('stopped');

      // The watchpoint fires on "mov [counter], ebx", so counter has just taken its first value.
      const value = await client.sendRequest<{ result: string }>('evaluate', { expression: 'counter', context: 'watch' });
      assert.ok(value.result.length > 0);
    } catch (err) {
      throw new Error(`${(err as Error).message}\n--- adapter stderr ---\n${stderr()}`);
    } finally {
      proc.kill();
    }
  });

  it('reports an unknown name as unwatchable rather than pretending to watch it', async function () {
    this.timeout(30000);
    const { proc, client } = await start(loop);
    try {
      const info = await client.sendRequest<{ dataId: string | null }>('dataBreakpointInfo', { name: 'not_a_label' });
      assert.strictEqual(info.dataId, null);
    } finally {
      proc.kill();
    }
  });

  it('reads and writes raw memory at a data label', async function () {
    this.timeout(30000);
    const { proc, client, stderr } = await start(loop);
    try {
      await client.sendRequest('setBreakpoints', { source: { path: loop.asmPath }, breakpoints: [{ line: 14 }] });
      await client.sendRequest('configurationDone');
      await client.waitForEvent('stopped', (b) => (b as { reason?: string }).reason === 'breakpoint');

      const scopes = await client.sendRequest<{ scopes: Array<{ name: string; variablesReference: number }> }>('scopes', { frameId: 1 });
      const labels = scopes.scopes.find((s) => s.name === 'Data Labels')!;
      const vars = await client.sendRequest<{ variables: Array<{ name: string; memoryReference?: string }> }>('variables', {
        variablesReference: labels.variablesReference,
      });
      const greeting = vars.variables.find((v) => v.name === 'greeting')!;
      assert.ok(greeting.memoryReference, 'a data label needs a memoryReference for the hex editor to be offered at all');

      const read = await client.sendRequest<{ data?: string; unreadableBytes?: number }>('readMemory', {
        memoryReference: greeting.memoryReference,
        count: 3,
      });
      assert.strictEqual(Buffer.from(read.data!, 'base64').toString('latin1'), 'hi\0');

      await client.sendRequest('writeMemory', {
        memoryReference: greeting.memoryReference,
        data: Buffer.from('HI', 'latin1').toString('base64'),
      });
      const afterWrite = await client.sendRequest<{ data?: string }>('readMemory', {
        memoryReference: greeting.memoryReference,
        count: 3,
      });
      assert.strictEqual(Buffer.from(afterWrite.data!, 'base64').toString('latin1'), 'HI\0', 'writeMemory did not take effect');

      await client.sendRequest('continue', { threadId: 1 });
      await client.waitForEvent('terminated');
    } catch (err) {
      throw new Error(`${(err as Error).message}\n--- adapter stderr ---\n${stderr()}`);
    } finally {
      proc.kill();
    }
  });

  it('moves the program counter with set-next-statement', async function () {
    this.timeout(30000);
    const { proc, client, stderr } = await start(loop);
    try {
      await client.sendRequest('setBreakpoints', { source: { path: loop.asmPath }, breakpoints: [{ line: 7 }] });
      await client.sendRequest('configurationDone');
      await client.waitForEvent('stopped', (b) => (b as { reason?: string }).reason === 'breakpoint');

      // Jump straight past the loop, to the first instruction after "done:".
      const targets = await client.sendRequest<{ targets: Array<{ id: number; line: number }> }>('gotoTargets', {
        source: { path: loop.asmPath },
        line: 14,
      });
      assert.ok(targets.targets.length === 1, `expected one goto target, got ${JSON.stringify(targets)}`);

      // Counted rather than matched by reason: the breakpoint stop from a moment ago is still in
      // the event log, and waitForEvent happily returns an already-seen match.
      const stopsBefore = client.events.filter((e) => e.event === 'stopped').length;
      await client.sendRequest('goto', { threadId: 1, targetId: targets.targets[0].id });
      await client.waitForEvent('stopped', () => client.events.filter((e) => e.event === 'stopped').length > stopsBefore);

      const stack = await client.sendRequest<{ stackFrames: Array<{ line: number }> }>('stackTrace', { threadId: 1 });
      assert.strictEqual(stack.stackFrames[0].line, 14, 'expected the program counter to have moved past the loop');

      // The loop never ran, so counter is still 0 — proof that execution really skipped it.
      const counter = await client.sendRequest<{ result: string }>('evaluate', { expression: 'counter', context: 'watch' });
      assert.match(counter.result, /\b0\b/, `expected the skipped loop to have left counter at 0, got ${counter.result}`);
    } catch (err) {
      throw new Error(`${(err as Error).message}\n--- adapter stderr ---\n${stderr()}`);
    } finally {
      proc.kill();
    }
  });

  it('restarts the program in the same session, keeping its breakpoints', async function () {
    this.timeout(30000);
    const { proc, client, stderr } = await start(loop);
    try {
      await client.sendRequest('setBreakpoints', { source: { path: loop.asmPath }, breakpoints: [{ line: 7 }] });
      await client.sendRequest('configurationDone');
      await client.waitForEvent('stopped', (b) => (b as { reason?: string }).reason === 'breakpoint');

      const stopsBefore = client.events.filter((e) => e.event === 'stopped').length;
      await client.sendRequest('restart', {});
      // The same breakpoint must catch the restarted program, without re-sending it.
      await client.waitForEvent(
        'stopped',
        () => client.events.filter((e) => e.event === 'stopped').length > stopsBefore,
      );

      const stack = await client.sendRequest<{ stackFrames: Array<{ line: number }> }>('stackTrace', { threadId: 1 });
      assert.strictEqual(stack.stackFrames[0].line, 7, 'expected the retained breakpoint to catch the restarted program');
    } catch (err) {
      throw new Error(`${(err as Error).message}\n--- adapter stderr ---\n${stderr()}`);
    } finally {
      proc.kill();
    }
  });

  it('names the signal when the program faults, instead of a bare "exception"', async function () {
    this.timeout(30000);
    const { proc, client, stderr } = await start(crash);
    try {
      await client.sendRequest('configurationDone');
      const stopped = (await client.waitForEvent('stopped', (b) => (b as { reason?: string }).reason === 'exception')) as {
        description?: string;
        text?: string;
      };
      assert.match(stopped.description ?? '', /SIGSEGV/, `expected the signal named in the stop description, got ${JSON.stringify(stopped)}`);

      const info = await client.sendRequest<{ exceptionId: string; description: string }>('exceptionInfo', { threadId: 1 });
      assert.strictEqual(info.exceptionId, 'SIGSEGV');
      assert.match(info.description, /Segmentation fault/i);
    } catch (err) {
      throw new Error(`${(err as Error).message}\n--- adapter stderr ---\n${stderr()}`);
    } finally {
      proc.kill();
    }
  });

  it('passes launch arguments and environment through to the debugged program', async function () {
    this.timeout(30000);
    const { proc, client, stderr } = await start(loop, { args: ['alpha', 'beta'], env: { FASM2_STUDIO_TEST: 'present' } });
    try {
      await client.sendRequest('setBreakpoints', { source: { path: loop.asmPath }, breakpoints: [{ line: 7 }] });
      await client.sendRequest('configurationDone');
      await client.waitForEvent('stopped', (b) => (b as { reason?: string }).reason === 'breakpoint');

      // argc/argv/envp live on the stack at entry on x86-64 Linux: [rsp] is argc, then argv[0..],
      // a NULL, then envp[0..]. The program has not touched the stack yet at "start:", so these
      // read the real values the kernel set up — the debugged process's own view, not gdb's.
      const argc = await client.sendRequest<{ result: string }>('evaluate', { expression: '*(long*)$rsp', context: 'watch' });
      assert.match(argc.result, /\b3\b/, `expected argc == 3 (program + two arguments), got ${argc.result}`);

      // getenv is not callable here: a fasm binary carries no libc and no symbol table, so the
      // environment has to be read the same way the program itself would — straight off the stack.
      // envp starts after argc, argv[0..argc-1] and the NULL terminator: rsp + 8*(argc + 2).
      // Bounded only to keep a malformed stack from looping forever: the variable is appended
      // after everything already in the environment, which on a normal desktop shell is well over
      // a hundred entries — a small scan limit silently misses it.
      let found = false;
      for (let i = 0; i < 512 && !found; i++) {
        const offset = 8 * (3 + 2) + 8 * i;
        const entry = await client.sendRequest<{ result: string }>('evaluate', {
          expression: `(char*)*(long*)($rsp+${offset})`,
          context: 'watch',
        });
        if (/FASM2_STUDIO_TEST=present/.test(entry.result)) found = true;
        if (/^0x0\b/.test(entry.result)) break; // end of envp
      }
      assert.ok(found, 'expected the launch env to reach the debugged program');
    } catch (err) {
      throw new Error(`${(err as Error).message}\n--- adapter stderr ---\n${stderr()}`);
    } finally {
      proc.kill();
    }
  });
});
