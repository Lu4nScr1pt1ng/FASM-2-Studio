import * as assert from 'assert';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildLaunchArgs, GdbDriver } from '../src/gdbDriver';

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

describe('buildLaunchArgs', () => {
  it('uses the full gdb flag set for a gdb binary', () => {
    assert.deepStrictEqual(buildLaunchArgs('gdb', '/tmp/prog'), ['--interpreter=mi3', '--nx', '-q', '--args', '/tmp/prog']);
    assert.deepStrictEqual(buildLaunchArgs('/usr/bin/gdb', '/tmp/prog', ['a', 'b']), ['--interpreter=mi3', '--nx', '-q', '--args', '/tmp/prog', 'a', 'b']);
  });

  it('uses the minimal lldb-mi invocation for an lldb-mi binary (its option parser rejects/misparses the gdb flags)', () => {
    // lldb-mi scans the command line right-to-left for anything filename-shaped to treat as the
    // executable, so gdb's "--args" flag can itself get picked up as the program path there —
    // the conventional client invocation is just "--interpreter <program>".
    assert.deepStrictEqual(buildLaunchArgs('lldb-mi', '/tmp/prog'), ['--interpreter', '/tmp/prog']);
    assert.deepStrictEqual(buildLaunchArgs('/usr/local/bin/lldb-mi', '/tmp/prog'), ['--interpreter', '/tmp/prog']);
    assert.deepStrictEqual(buildLaunchArgs('C:\\tools\\lldb-mi.exe', '/tmp/prog'), ['--interpreter', '/tmp/prog']);
  });
});

describe('GdbDriver (integration, real gdb + a real compiled fasm2 ELF binary)', function () {
  let dir: string;
  let programPath: string;
  const gdbAvailable = isAvailable('gdb');
  const fasm2Available = isAvailable('fasm2');

  before(async function () {
    if (!gdbAvailable || !fasm2Available || os.platform() !== 'linux') {
      this.skip();
      return;
    }
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fasm2-studio-gdb-test-'));
    const asmPath = path.join(dir, 'prog.asm');
    programPath = path.join(dir, 'prog');
    fs.writeFileSync(asmPath, PROGRAM_SRC, 'utf8');

    const result = spawnSync('fasm2', [asmPath, programPath], { cwd: dir, timeout: 15000 });
    if (result.status !== 0) throw new Error(`fasm2 build failed: ${result.stdout}${result.stderr}`);
    fs.chmodSync(programPath, 0o755);
  });

  after(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('sets a breakpoint by address, runs, stops there, and reads a register via expression evaluation', async function () {
    this.timeout(20000);
    const driver = new GdbDriver();

    const stoppedEvents: Array<Record<string, unknown>> = [];
    driver.on('stopped', (data) => stoppedEvents.push(data));

    try {
      driver.start({ gdbPath: 'gdb', programPath, cwd: dir });

      // "add eax, ebx" — the third real instruction (0-based) after "mov eax,1" and "mov ebx,2".
      const insert = await driver.sendCommand('-break-insert *0x400082');
      assert.strictEqual(insert.klass, 'done');

      const run = await driver.sendCommand('-exec-run');
      assert.strictEqual(run.klass, 'running');

      // Wait for the *stopped async record (breakpoint hit) to arrive.
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timed out waiting for breakpoint hit')), 10000);
        driver.on('stopped', (data) => {
          if (data.reason === 'breakpoint-hit') {
            clearTimeout(timer);
            resolve();
          }
        });
      });

      assert.ok(stoppedEvents.some((e) => e.reason === 'breakpoint-hit'));

      // At this point eax=1 (set by "mov eax,1") — "add eax,ebx" hasn't executed yet.
      const eaxResult = await driver.sendCommand('-data-evaluate-expression $eax');
      const eaxData = eaxResult.data as Record<string, unknown>;
      assert.match(String(eaxData.value), /1/);

      await driver.sendCommand('-exec-continue');
      await new Promise<void>((resolve) => {
        driver.on('exit', () => resolve());
        driver.on('stopped', (data) => {
          if (data.reason === 'exited-normally') resolve();
        });
      });
    } finally {
      await driver.dispose();
    }
  });

  it('rejects the sendCommand promise with the gdb-reported error message on a bad command', async function () {
    this.timeout(15000);
    const driver = new GdbDriver();
    try {
      driver.start({ gdbPath: 'gdb', programPath, cwd: dir });
      await assert.rejects(() => driver.sendCommand('-this-is-not-a-real-command'));
    } finally {
      await driver.dispose();
    }
  });

  it('correlates concurrent commands to their own results rather than cross-wiring them', async function () {
    this.timeout(15000);
    const driver = new GdbDriver();
    try {
      driver.start({ gdbPath: 'gdb', programPath, cwd: dir });

      // Fired concurrently, on purpose, to prove the token-keyed correlation in GdbDriver picks
      // the right pending promise for each reply rather than resolving them in send order.
      const [a, b, c] = await Promise.all([
        driver.sendCommand('-data-evaluate-expression 11+11'),
        driver.sendCommand('-data-evaluate-expression 22+22'),
        driver.sendCommand('-data-evaluate-expression 33+33'),
      ]);

      assert.strictEqual((a.data as Record<string, unknown>).value, '22');
      assert.strictEqual((b.data as Record<string, unknown>).value, '44');
      assert.strictEqual((c.data as Record<string, unknown>).value, '66');
    } finally {
      await driver.dispose();
    }
  });
});

describe('GdbDriver (unit, against a fake process that dies mid-command)', () => {
  let dir: string;
  let fakeGdbPath: string;

  before(async function () {
    if (os.platform() === 'win32') {
      // The fake below is a POSIX shell script; the behavior under test (pending commands reject
      // on an unexpected exit) is platform-agnostic, so it's sufficient to cover it on POSIX.
      this.skip();
      return;
    }
    const fs2 = await import('fs/promises');
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fasm2-studio-gdb-crash-test-'));
    fakeGdbPath = path.join(dir, 'fake-gdb.sh');
    // Reads (and discards) exactly one line -- the first command GdbDriver sends -- then exits
    // without ever responding, simulating gdb crashing or being killed mid-command.
    await fs2.writeFile(fakeGdbPath, '#!/bin/sh\nread line\nexit 1\n', 'utf8');
    await fs2.chmod(fakeGdbPath, 0o755);
  });

  after(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('rejects a pending command instead of hanging forever when the process exits unexpectedly', async function () {
    this.timeout(10000);
    const driver = new GdbDriver();
    driver.start({ gdbPath: fakeGdbPath, programPath: '/dev/null', cwd: dir });

    await assert.rejects(() => driver.sendCommand('-exec-run', 8000), /exited/i);
  });
});
