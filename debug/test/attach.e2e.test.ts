// End-to-end attach: the real adapter.js process, real gdb, a real compiled fasm2 binary — and, for
// the process case, a real running program that this test did not start under the debugger.
//
// Two fixtures, because the two attach targets are genuinely different animals:
//
//   spin  — sets PR_SET_PTRACER_ANY on itself and then loops forever. The prctl is not decoration:
//           most Linux distributions ship yama's ptrace_scope at 1, which permits ptrace only from
//           an ancestor of the target. gdb here is a sibling (both are children of this test), so
//           without the target opting in, attach fails with "Operation not permitted" on any
//           ordinary developer machine and this test would only ever be exercising an error path.
//   crash — dereferences a null pointer. Its core is produced by driving gdb itself
//           (`run` + `generate-core-file`) rather than by faulting and hoping: /proc/sys/kernel/
//           core_pattern routes cores to systemd-coredump on most modern distributions, so a
//           "just let it dump" test would find no file to open on the machines it most needs to run.
import * as assert from 'assert';
import { ChildProcessWithoutNullStreams, spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DapClient, isAvailable } from './dapClient';
import { makeTempDir, removeTempDir } from './tempDir';

/** PR_SET_PTRACER (0x59616d61, "Yama") with PR_SET_PTRACER_ANY (-1), so a non-ancestor gdb is
 * allowed to attach whatever ptrace_scope is set to. See the file header. */
const SPIN_SRC = [
  'format ELF64 executable 3',
  'entry start',
  '',
  'segment readable executable',
  '',
  'start:',
  '\tmov eax, 157',
  '\tmov edi, 0x59616d61',
  '\tmov rsi, -1',
  '\txor edx, edx',
  '\txor r10d, r10d',
  '\txor r8d, r8d',
  '\tsyscall',
  '\tmov ecx, 0',
  'spin:',
  '\tinc ecx',
  '\tjmp spin',
  '',
].join('\n');

const CRASH_SRC = [
  'format ELF64 executable 3',
  'entry start',
  '',
  'segment readable executable',
  '',
  'start:',
  '\tmov eax, 0x1234',
  '\txor rbx, rbx',
  '\tmov [rbx], eax',
  '',
].join('\n');

function buildWithListing(dir: string, name: string, source: string): { asmPath: string; programPath: string; listingPath: string } {
  const asmPath = path.join(dir, `${name}.asm`);
  const programPath = path.join(dir, name);
  const listingPath = path.join(dir, `${name}.lst`);
  fs.writeFileSync(asmPath, source, 'utf8');

  const build = spawnSync('fasm2', ['-i', "include 'listing.inc'", asmPath, programPath], { cwd: dir, timeout: 15000 });
  if (build.status !== 0) throw new Error(`fasm2 build failed:\n${build.stdout}\n${build.stderr}`);
  fs.chmodSync(programPath, 0o755);
  assert.ok(fs.existsSync(listingPath), 'expected the -i injected listing.inc to produce a .lst file');
  return { asmPath, programPath, listingPath };
}

function startAdapter(): { proc: ChildProcessWithoutNullStreams; client: DapClient; stderr: string[] } {
  const proc = spawn(process.execPath, [path.join(__dirname, '..', 'dist', 'adapter.js')], { stdio: ['pipe', 'pipe', 'pipe'] });
  const stderr: string[] = [];
  proc.stderr.on('data', (c: Buffer) => stderr.push(c.toString('utf8')));
  return { proc, client: new DapClient(proc), stderr };
}

/**
 * Whether `program` exits within `ms`.
 *
 * Deliberately watching the child's own exit event rather than probing with `kill(pid, 0)`: the
 * fixture is a child of this test process, so a killed one lingers as a zombie until Node reaps it
 * — and `kill(pid, 0)` answers "still there" for a zombie, which would have let a debuggee that
 * was never killed pass as one that was.
 */
function exitsWithin(program: ChildProcessWithoutNullStreams | { once: (e: string, cb: () => void) => void }, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    program.once('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

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

describe('attach end-to-end (real adapter.js, real gdb, real fasm2 binary)', function () {
  let dir: string;
  let spin: ReturnType<typeof buildWithListing>;
  let crash: ReturnType<typeof buildWithListing>;
  let corePath: string;

  before(function () {
    this.timeout(60000);
    if (!isAvailable('gdb') || !isAvailable('fasm2') || os.platform() !== 'linux') {
      this.skip();
      return;
    }
    dir = makeTempDir('fasm2-studio-attach-e2e-');
    spin = buildWithListing(dir, 'spin', SPIN_SRC);
    crash = buildWithListing(dir, 'crash', CRASH_SRC);

    corePath = path.join(dir, 'crash.core');
    const dump = spawnSync('gdb', ['--nx', '-q', '-batch', '-ex', 'run', '-ex', `generate-core-file ${corePath}`, crash.programPath], {
      cwd: dir,
      timeout: 30000,
    });
    if (!fs.existsSync(corePath)) {
      throw new Error(`could not produce a core file:\n${dump.stdout}\n${dump.stderr}`);
    }
  });

  after(async () => {
    await removeTempDir(dir);
  });

  it('attaches to a running process, stops it, maps the PC to source, and leaves it running on disconnect', async function () {
    this.timeout(40000);

    const program = spawn(spin.programPath, [], { cwd: dir, stdio: 'ignore' });
    const pid = program.pid!;
    // The prctl is the program's first instruction block; attaching before it has run would race a
    // ptrace_scope refusal that has nothing to do with the adapter.
    await new Promise((resolve) => setTimeout(resolve, 300));

    const { proc, client, stderr } = startAdapter();
    try {
      await client.sendRequest('initialize', { adapterID: 'fasm2', linesStartAt1: true, columnsStartAt1: true, pathFormat: 'path' });
      await client.waitForEvent('initialized');

      const stopped = client.waitForEvent('stopped');
      await client.sendRequest('attach', {
        program: spin.programPath,
        asmFile: spin.asmPath,
        listingFile: spin.listingPath,
        processId: pid,
        cwd: dir,
      });
      await client.sendRequest('configurationDone');
      await stopped;

      // The whole point of attaching rather than launching: the program was already deep inside its
      // own loop, and where it is now is a line of the user's source.
      const stackTrace = await client.sendRequest<{ stackFrames: Array<{ line: number; source?: { path: string } }> }>('stackTrace', {
        threadId: 1,
      });
      assert.strictEqual(stackTrace.stackFrames[0].source?.path, spin.asmPath);
      assert.ok(
        [17, 18].includes(stackTrace.stackFrames[0].line),
        `expected to be stopped inside the spin loop (lines 17-18), got line ${stackTrace.stackFrames[0].line}`,
      );

      const scopes = await client.sendRequest<{ scopes: Array<{ name: string; variablesReference: number }> }>('scopes', { frameId: 1 });
      const registers = scopes.scopes.find((s) => s.name === 'Registers')!;
      const rcx = await findRegisterValue(client, registers.variablesReference, 'rcx');
      assert.ok(rcx, 'expected the Registers scope to be readable on an attached process');

      // Stepping an attached process is the same machinery as stepping a launched one — it is only
      // a *core* that cannot be resumed.
      await client.sendRequest('next', { threadId: 1, granularity: 'instruction' });
      await client.waitForEvent('stopped', (b) => (b as { reason?: string }).reason === 'step');

      const exited = exitsWithin(program, 1000);
      await client.sendRequest('disconnect');
      // The contract that makes attach safe to use on anything real: ending the debug session is
      // not a request to end the program.
      assert.strictEqual(await exited, false, 'the attached process should still be running after a plain disconnect');
    } catch (err) {
      throw new Error(`${(err as Error).message}\n--- adapter stderr ---\n${stderr.join('')}`);
    } finally {
      proc.kill();
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // already gone
      }
    }
  });

  it('kills the attached process when the client asks for the debuggee to be terminated', async function () {
    this.timeout(40000);

    const program = spawn(spin.programPath, [], { cwd: dir, stdio: 'ignore' });
    const pid = program.pid!;
    await new Promise((resolve) => setTimeout(resolve, 300));

    const { proc, client, stderr } = startAdapter();
    try {
      await client.sendRequest('initialize', { adapterID: 'fasm2', linesStartAt1: true, columnsStartAt1: true, pathFormat: 'path' });
      await client.waitForEvent('initialized');
      const stopped = client.waitForEvent('stopped');
      await client.sendRequest('attach', {
        program: spin.programPath,
        asmFile: spin.asmPath,
        listingFile: spin.listingPath,
        processId: pid,
        cwd: dir,
      });
      await client.sendRequest('configurationDone');
      await stopped;

      const exited = exitsWithin(program, 5000);
      await client.sendRequest('disconnect', { terminateDebuggee: true });
      assert.strictEqual(await exited, true, 'the process should be gone once the client asked to terminate the debuggee');
    } catch (err) {
      throw new Error(`${(err as Error).message}\n--- adapter stderr ---\n${stderr.join('')}`);
    } finally {
      proc.kill();
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // already gone
      }
    }
  });

  it('opens a core dump: names the signal, maps the faulting address to its source line, and refuses to resume', async function () {
    this.timeout(40000);

    const { proc, client, stderr } = startAdapter();
    try {
      await client.sendRequest('initialize', { adapterID: 'fasm2', linesStartAt1: true, columnsStartAt1: true, pathFormat: 'path' });
      await client.waitForEvent('initialized');

      const stopped = client.waitForEvent('stopped') as Promise<{ reason: string; description?: string }>;
      await client.sendRequest('attach', {
        program: crash.programPath,
        asmFile: crash.asmPath,
        listingFile: crash.listingPath,
        coreFile: corePath,
        cwd: dir,
      });
      await client.sendRequest('configurationDone');

      // gdb emits no *stopped record at all for a core load, so this event is the adapter's own —
      // and without it the session would show no frame, no registers and no source line.
      const stopBody = await stopped;
      assert.strictEqual(stopBody.reason, 'exception');
      assert.match(stopBody.description ?? '', /SIGSEGV/);

      const exceptionInfo = await client.sendRequest<{ exceptionId: string; description: string }>('exceptionInfo', { threadId: 1 });
      assert.strictEqual(exceptionInfo.exceptionId, 'SIGSEGV');
      assert.match(exceptionInfo.description, /Segmentation fault/i);

      // Line 9 is "mov [rbx], eax" — the instruction that actually faulted.
      const stackTrace = await client.sendRequest<{ stackFrames: Array<{ line: number; source?: { path: string } }> }>('stackTrace', {
        threadId: 1,
      });
      assert.strictEqual(stackTrace.stackFrames[0].source?.path, crash.asmPath);
      assert.strictEqual(stackTrace.stackFrames[0].line, 9);

      // A snapshot is still fully readable: this is the whole value of opening a core at all.
      const scopes = await client.sendRequest<{ scopes: Array<{ name: string; variablesReference: number }> }>('scopes', { frameId: 1 });
      const registers = scopes.scopes.find((s) => s.name === 'Registers')!;
      const rax = await findRegisterValue(client, registers.variablesReference, 'rax');
      assert.ok(rax && /1234/i.test(rax), `expected the frozen rax (0x1234) to be readable from the core, got: ${rax}`);

      // ...but never resumable, and it has to say so in those terms rather than passing along gdb's
      // "The program is not being run", which describes a program that failed to start.
      await assert.rejects(
        () => client.sendRequest('continue', { threadId: 1 }),
        /core dump/i,
        'continuing a core dump should be refused in terms of what a core dump is',
      );
      await assert.rejects(() => client.sendRequest('next', { threadId: 1 }), /core dump/i);

      await client.sendRequest('disconnect');
    } catch (err) {
      throw new Error(`${(err as Error).message}\n--- adapter stderr ---\n${stderr.join('')}`);
    } finally {
      proc.kill();
    }
  });

  it('reports a bad attach configuration as an error response, not as a hung session', async function () {
    this.timeout(30000);

    const { proc, client, stderr } = startAdapter();
    try {
      await client.sendRequest('initialize', { adapterID: 'fasm2', linesStartAt1: true, columnsStartAt1: true, pathFormat: 'path' });
      await client.waitForEvent('initialized');

      await assert.rejects(
        () =>
          client.sendRequest('attach', {
            program: spin.programPath,
            asmFile: spin.asmPath,
            listingFile: spin.listingPath,
            cwd: dir,
          }),
        /processId|coreFile/,
        'an attach config naming no target should fail with a message naming what is missing',
      );
    } catch (err) {
      throw new Error(`${(err as Error).message}\n--- adapter stderr ---\n${stderr.join('')}`);
    } finally {
      proc.kill();
    }
  });
});
