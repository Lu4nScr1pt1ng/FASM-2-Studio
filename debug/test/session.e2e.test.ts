// True end-to-end test: spawns the actual built adapter.js as a child process and speaks raw DAP
// wire protocol to it (Content-Length framing over stdio) — exactly what VS Code itself does.
// This is the strongest validation available short of driving real VS Code: it exercises the
// full chain (DAP framing -> session.ts -> GdbDriver -> real gdb -> real compiled fasm2 binary)
// with nothing mocked.
import * as assert from 'assert';
import { ChildProcessWithoutNullStreams, spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

function isAvailable(command: string): boolean {
  const result = spawnSync(command, ['--version'], { timeout: 5000 });
  return !(result.error && (result.error as NodeJS.ErrnoException).code === 'ENOENT');
}

interface RawDapMessage {
  type: 'response' | 'event';
  request_seq?: number;
  success?: boolean;
  message?: string;
  event?: string;
  body?: unknown;
}

class DapClient {
  private buffer = Buffer.alloc(0);
  private seq = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private readonly eventWaiters: Array<{ event: string; predicate?: (body: unknown) => boolean; resolve: (body: unknown) => void }> = [];
  readonly events: Array<{ event: string; body: unknown }> = [];

  constructor(private readonly proc: ChildProcessWithoutNullStreams) {
    proc.stdout.on('data', (chunk: Buffer) => this.onData(chunk));
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) return;
      const header = this.buffer.subarray(0, headerEnd).toString('utf8');
      const match = /Content-Length: (\d+)/.exec(header);
      if (!match) return;
      const length = parseInt(match[1], 10);
      const bodyStart = headerEnd + 4;
      if (this.buffer.length < bodyStart + length) return;
      const body = this.buffer.subarray(bodyStart, bodyStart + length).toString('utf8');
      this.buffer = this.buffer.subarray(bodyStart + length);
      this.handleMessage(JSON.parse(body) as RawDapMessage);
    }
  }

  private handleMessage(msg: RawDapMessage): void {
    if (msg.type === 'response') {
      const p = this.pending.get(msg.request_seq!);
      if (p) {
        this.pending.delete(msg.request_seq!);
        if (msg.success) p.resolve(msg.body);
        else p.reject(new Error(msg.message ?? 'request failed'));
      }
    } else if (msg.type === 'event') {
      this.events.push({ event: msg.event!, body: msg.body });
      for (let i = this.eventWaiters.length - 1; i >= 0; i--) {
        const w = this.eventWaiters[i];
        if (w.event === msg.event && (!w.predicate || w.predicate(msg.body))) {
          this.eventWaiters.splice(i, 1);
          w.resolve(msg.body);
        }
      }
    }
  }

  sendRequest<T = unknown>(command: string, args?: unknown): Promise<T> {
    const seq = this.seq++;
    const payload = JSON.stringify({ seq, type: 'request', command, arguments: args });
    const framed = `Content-Length: ${Buffer.byteLength(payload, 'utf8')}\r\n\r\n${payload}`;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(seq, { resolve: resolve as (v: unknown) => void, reject });
      this.proc.stdin.write(framed);
    });
  }

  waitForEvent(event: string, predicate?: (body: unknown) => boolean, timeoutMs = 15000): Promise<unknown> {
    const already = this.events.find((e) => e.event === event && (!predicate || predicate(e.body)));
    if (already) return Promise.resolve(already.body);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for DAP event "${event}"`)), timeoutMs);
      this.eventWaiters.push({
        event,
        predicate,
        resolve: (body) => {
          clearTimeout(timer);
          resolve(body);
        },
      });
    });
  }
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
 * The Registers scope is a tree, not a flat list — its top-level variablesReference resolves to
 * group headers ("General Purpose", "Pointers", "Flags", "Segment"), each with its own nested
 * variablesReference holding the actual registers. Finds `registerName`'s own formatted value,
 * searching every group (read-only lookups don't care which one it's in).
 */
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

/** setVariable targets a *group's* variablesReference (the container), not an individual
 * register's own — the register being set doesn't have to already be a listed row in that
 * specific group (setRegister validates the name against REGISTER_WIDTH_BITS directly, not
 * against whatever this group happens to enumerate), it just has to be a real container kind. */
async function getRegisterGroupRef(client: DapClient, registersRef: number, groupLabel: string): Promise<number> {
  const groups = await client.sendRequest<{ variables: Array<{ name: string; variablesReference: number }> }>('variables', {
    variablesReference: registersRef,
  });
  const group = groups.variables.find((v) => v.name === groupLabel);
  if (!group) throw new Error(`no "${groupLabel}" register group in this Registers scope`);
  return group.variablesReference;
}

describe('FasmDebugSession end-to-end (real adapter.js process, real gdb, real fasm2 binary)', function () {
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
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fasm2-studio-dap-e2e-'));
    asmPath = path.join(dir, 'prog.asm');
    programPath = path.join(dir, 'prog');
    listingPath = path.join(dir, 'prog.lst');
    fs.writeFileSync(asmPath, PROGRAM_SRC, 'utf8');

    const build = spawnSync('fasm2', ['-i', "include 'listing.inc'", asmPath, programPath], { cwd: dir, timeout: 15000 });
    if (build.status !== 0) {
      throw new Error(`fasm2 build failed:\n${build.stdout}\n${build.stderr}`);
    }
    fs.chmodSync(programPath, 0o755);
    assert.ok(fs.existsSync(listingPath), 'expected the -i injected listing.inc to produce a .lst file');
  });

  after(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('runs a full launch -> breakpoint -> stop -> inspect -> continue -> terminate session over real DAP framing', async function () {
    this.timeout(30000);

    const proc = spawn(process.execPath, [path.join(__dirname, '..', 'dist', 'adapter.js')], { stdio: ['pipe', 'pipe', 'pipe'] });
    const client = new DapClient(proc);
    const stderrChunks: string[] = [];
    proc.stderr.on('data', (c: Buffer) => stderrChunks.push(c.toString('utf8')));

    try {
      await client.sendRequest('initialize', { adapterID: 'fasm2', linesStartAt1: true, columnsStartAt1: true, pathFormat: 'path' });
      await client.waitForEvent('initialized');

      const launchPromise = client.sendRequest('launch', {
        program: programPath,
        asmFile: asmPath,
        listingFile: listingPath,
        cwd: dir,
      });
      await launchPromise;

      const bpResponse = await client.sendRequest<{ breakpoints: Array<{ verified: boolean; line: number }> }>('setBreakpoints', {
        source: { path: asmPath },
        breakpoints: [{ line: 9 }], // "add eax, ebx"
      });
      assert.strictEqual(bpResponse.breakpoints.length, 1);
      assert.strictEqual(bpResponse.breakpoints[0].verified, true, 'expected the breakpoint on a real instruction line to verify');

      await client.sendRequest('configurationDone');

      const stoppedBody = (await client.waitForEvent('stopped', (b) => (b as { reason?: string }).reason === 'breakpoint')) as {
        threadId: number;
      };
      assert.strictEqual(stoppedBody.threadId, 1);

      const stackTrace = await client.sendRequest<{ stackFrames: Array<{ line: number; source: { path: string } }> }>('stackTrace', { threadId: 1 });
      assert.strictEqual(stackTrace.stackFrames[0].line, 9);
      assert.strictEqual(stackTrace.stackFrames[0].source.path, asmPath);

      const scopes = await client.sendRequest<{ scopes: Array<{ name: string; variablesReference: number }> }>('scopes', { frameId: 1 });
      const registersScope = scopes.scopes.find((s) => s.name === 'Registers')!;
      assert.ok(registersScope);

      const rax = await findRegisterValue(client, registersScope.variablesReference, 'rax');
      assert.ok(rax && /\b1\b/.test(rax), `expected rax to read back as 1 before "add eax,ebx" executes, got: ${rax}`);

      const evalResult = await client.sendRequest<{ result: string }>('evaluate', { expression: '$eax', context: 'watch' });
      assert.match(evalResult.result, /\b1\b/);

      await client.sendRequest('continue', { threadId: 1 });
      await client.waitForEvent('terminated');

      await client.sendRequest('disconnect');
    } catch (err) {
      throw new Error(`${(err as Error).message}\n--- adapter stderr ---\n${stderrChunks.join('')}`);
    } finally {
      proc.kill();
    }
  });

  it('formats registers as unsigned hex/decimal/binary, not gdb\'s raw signed default', async function () {
    this.timeout(30000);

    // eax/dl chosen specifically because their top bit is set: gdb's own default evaluation of a
    // plain register is *signed*, so 0xffffffff would print as "-1" and 0xab as "-85" — exactly
    // the confusing behavior this feature fixes. sil is a 64-bit-only sub-register (no 32-bit
    // legacy alias) to prove the wider REGISTER_WIDTH_BITS alias table works, not just the curated
    // Registers-scope set.
    const regDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fasm2-studio-dap-e2e-regs-'));
    const regAsmPath = path.join(regDir, 'regs.asm');
    const regProgramPath = path.join(regDir, 'regs');
    const regListingPath = path.join(regDir, 'regs.lst');
    const REG_PROGRAM_SRC = [
      'format ELF64 executable 3',
      'entry start',
      '',
      'segment readable executable',
      'start:',
      '\tmov eax, 0xFFFFFFFF',
      '\tmov dl, 0xAB',
      '\tmov sil, 0x7F',
      '\tnop',
      '\tmov edi, 0',
      '\tmov eax, 60',
      '\tsyscall',
      '',
    ].join('\n');
    fs.writeFileSync(regAsmPath, REG_PROGRAM_SRC, 'utf8');
    const build = spawnSync('fasm2', ['-i', "include 'listing.inc'", regAsmPath, regProgramPath], { cwd: regDir, timeout: 15000 });
    if (build.status !== 0) throw new Error(`fasm2 build failed:\n${build.stdout}\n${build.stderr}`);
    fs.chmodSync(regProgramPath, 0o755);

    const proc = spawn(process.execPath, [path.join(__dirname, '..', 'dist', 'adapter.js')], { stdio: ['pipe', 'pipe', 'pipe'] });
    const client = new DapClient(proc);
    const stderrChunks: string[] = [];
    proc.stderr.on('data', (c: Buffer) => stderrChunks.push(c.toString('utf8')));

    try {
      await client.sendRequest('initialize', { adapterID: 'fasm2', linesStartAt1: true, columnsStartAt1: true, pathFormat: 'path' });
      await client.waitForEvent('initialized');
      await client.sendRequest('launch', { program: regProgramPath, asmFile: regAsmPath, listingFile: regListingPath, cwd: regDir });

      const bpResponse = await client.sendRequest<{ breakpoints: Array<{ verified: boolean }> }>('setBreakpoints', {
        source: { path: regAsmPath },
        breakpoints: [{ line: 9 }], // "nop"
      });
      assert.strictEqual(bpResponse.breakpoints[0].verified, true);

      await client.sendRequest('configurationDone');
      await client.waitForEvent('stopped', (b) => (b as { reason?: string }).reason === 'breakpoint');

      // Hovering over "eax" (context: hover) and evaluating from Watch/Debug Console (context:
      // watch) both go through the same code path — exercised here as "hover" specifically, since
      // that's the actual feature request (hover a register while debugging, see its value).
      const eax = await client.sendRequest<{ result: string }>('evaluate', { expression: 'eax', context: 'hover' });
      assert.strictEqual(eax.result, 'eax = 0xffffffff  4294967295  0b1111_1111_1111_1111_1111_1111_1111_1111');

      const dl = await client.sendRequest<{ result: string }>('evaluate', { expression: 'dl', context: 'hover' });
      assert.strictEqual(dl.result, 'dl = 0xab  171  0b1010_1011');

      const sil = await client.sendRequest<{ result: string }>('evaluate', { expression: 'sil', context: 'hover' });
      assert.strictEqual(sil.result, 'sil = 0x7f  127  0b0111_1111');

      // A bare "$"-prefixed name (as Watch/REPL users are used to typing) resolves the same way.
      const dollarEax = await client.sendRequest<{ result: string }>('evaluate', { expression: '$eax', context: 'watch' });
      assert.strictEqual(dollarEax.result, eax.result);

      // A compound expression is untouched — still falls through to the generic gdb evaluator.
      const compound = await client.sendRequest<{ result: string }>('evaluate', { expression: '$eax + 1', context: 'watch' });
      assert.match(compound.result, /^-?\d+$/);

      // The Registers scope panel gets the identical treatment, not just ad-hoc evaluate/hover —
      // rax reads back zero-extended from the eax write (standard x86-64 semantics). It lives in
      // the "General Purpose" group, one level below the scope's own top-level reference.
      const scopes = await client.sendRequest<{ scopes: Array<{ variablesReference: number }> }>('scopes', { frameId: 1 });
      const rax = await findRegisterValue(client, scopes.scopes[0].variablesReference, 'rax');
      assert.strictEqual(rax, 'rax = 0x00000000ffffffff  4294967295  0b0000_0000_0000_0000_0000_0000_0000_0000_1111_1111_1111_1111_1111_1111_1111_1111');

      await client.sendRequest('continue', { threadId: 1 });
      await client.waitForEvent('terminated');
      await client.sendRequest('disconnect');
    } catch (err) {
      throw new Error(`${(err as Error).message}\n--- adapter stderr ---\n${stderrChunks.join('')}`);
    } finally {
      proc.kill();
      fs.rmSync(regDir, { recursive: true, force: true });
    }
  });

  it('sets register values from the Registers panel and from a Watch expression', async function () {
    this.timeout(30000);

    const proc = spawn(process.execPath, [path.join(__dirname, '..', 'dist', 'adapter.js')], { stdio: ['pipe', 'pipe', 'pipe'] });
    const client = new DapClient(proc);
    const stderrChunks: string[] = [];
    proc.stderr.on('data', (c: Buffer) => stderrChunks.push(c.toString('utf8')));

    try {
      await client.sendRequest('initialize', { adapterID: 'fasm2', linesStartAt1: true, columnsStartAt1: true, pathFormat: 'path' });
      await client.waitForEvent('initialized');
      await client.sendRequest('launch', { program: programPath, asmFile: asmPath, listingFile: listingPath, cwd: dir });

      await client.sendRequest('setBreakpoints', { source: { path: asmPath }, breakpoints: [{ line: 9 }] }); // "add eax, ebx"
      await client.sendRequest('configurationDone');
      await client.waitForEvent('stopped', (b) => (b as { reason?: string }).reason === 'breakpoint');

      const scopes = await client.sendRequest<{ scopes: Array<{ variablesReference: number }> }>('scopes', { frameId: 1 });
      // eax/ebx are both "General Purpose" registers — setVariable targets that group's own
      // variablesReference, not the Registers scope's top-level one.
      const registersRef = await getRegisterGroupRef(client, scopes.scopes[0].variablesReference, 'General Purpose');

      // setVariable (the Registers panel's in-place editor), plain decimal.
      const viaSetVariable = await client.sendRequest<{ value: string }>('setVariable', {
        variablesReference: registersRef,
        name: 'eax',
        value: '42',
      });
      assert.strictEqual(viaSetVariable.value, 'eax = 0x0000002a  42  0b0000_0000_0000_0000_0000_0000_0010_1010');

      // The write is real, not just echoed back: re-reading confirms it via a fresh evaluate.
      const reread = await client.sendRequest<{ result: string }>('evaluate', { expression: 'eax', context: 'hover' });
      assert.strictEqual(reread.result, viaSetVariable.value);

      // setExpression (editing a Watch entry), asm-style "h" hex suffix and a "$"-prefixed name.
      const viaSetExpression = await client.sendRequest<{ value: string }>('setExpression', {
        expression: '$eax',
        value: '2Ah',
      });
      assert.strictEqual(viaSetExpression.value, viaSetVariable.value, 'expected "2Ah" (asm hex) to parse to the same 42 as decimal "42"');

      // A negative decimal wraps to the register's own two's-complement bit pattern.
      const negative = await client.sendRequest<{ value: string }>('setVariable', {
        variablesReference: registersRef,
        name: 'ebx',
        value: '-1',
      });
      assert.strictEqual(negative.value, 'ebx = 0xffffffff  4294967295  0b1111_1111_1111_1111_1111_1111_1111_1111');

      // An unparseable value is rejected with an error response, not silently ignored.
      await assert.rejects(
        client.sendRequest('setVariable', { variablesReference: registersRef, name: 'eax', value: 'not a number' }),
        /Could not parse/,
      );

      // The real user-reported bug: VS Code's in-place editor pre-fills the *entire* current
      // display string ("eax = 0x0000002a  42  0b0000...0010"), not a bare number. Editing only
      // the decimal or binary column and submitting the whole string back used to silently do
      // nothing (only the hex column ever took effect) — confirmed here against the real adapter
      // and a real register write, not just the pure parseUserNumber unit tests.
      const currentEax = (await client.sendRequest<{ result: string }>('evaluate', { expression: 'eax', context: 'hover' })).result;
      const editedDecimalOnly = currentEax.replace(/\d+(?=\s+0b)/, '100'); // change only the middle (decimal) column
      const viaDecimalEdit = await client.sendRequest<{ value: string }>('setVariable', {
        variablesReference: registersRef,
        name: 'eax',
        value: editedDecimalOnly,
      });
      assert.strictEqual(viaDecimalEdit.value, 'eax = 0x00000064  100  0b0000_0000_0000_0000_0000_0000_0110_0100');

      const currentEaxAgain = (await client.sendRequest<{ result: string }>('evaluate', { expression: 'eax', context: 'hover' })).result;
      const editedBinaryOnly = currentEaxAgain.replace(/0b[01_]+$/, '0b1111_1111_1111_1111_1111_1111_1111_1111'); // change only the last (binary) column
      const viaBinaryEdit = await client.sendRequest<{ value: string }>('setVariable', {
        variablesReference: registersRef,
        name: 'eax',
        value: editedBinaryOnly,
      });
      assert.strictEqual(viaBinaryEdit.value, 'eax = 0xffffffff  4294967295  0b1111_1111_1111_1111_1111_1111_1111_1111');

      await client.sendRequest('continue', { threadId: 1 });
      await client.waitForEvent('terminated');
      await client.sendRequest('disconnect');
    } catch (err) {
      throw new Error(`${(err as Error).message}\n--- adapter stderr ---\n${stderrChunks.join('')}`);
    } finally {
      proc.kill();
    }
  });

  it('shows real 32-bit registers (not "<unavailable>") and resolves a data label to its address+value, for a real 32-bit ELF target', async function () {
    // The exact bug report this guards against: registers used to be hardcoded to x86-64 names
    // only, so every single one read back "<unavailable>" against a 32-bit target (there's no
    // "$rax" on an i386 process) — and there was no way at all to ask "what's the address/value
    // of this label" for a plain data variable like "argc" (fasmg emits no symbol table for gdb
    // to resolve that from). Uses the user's own real-world snippet almost verbatim: reading argc
    // off the initial stack and storing it into a "argc dd ?" variable.
    this.timeout(30000);

    const argcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fasm2-studio-dap-e2e-argc32-'));
    const argcAsmPath = path.join(argcDir, 'argc32.asm');
    const argcProgramPath = path.join(argcDir, 'argc32');
    const argcListingPath = path.join(argcDir, 'argc32.lst');
    const ARGC32_SRC = [
      'format ELF executable 3', // EM_386 — a genuine 32-bit target, not ELF64
      'entry start',
      '',
      'segment readable executable',
      '',
      'start:',
      '\tmov ecx, [esp]',
      '\tmov [argc], ecx',
      '\tnop',
      '\tmov eax, 1',
      '\tmov ebx, 0',
      '\tint 0x80',
      '',
      'segment readable writeable',
      '',
      'argc dd ?',
      '',
    ].join('\n');
    fs.writeFileSync(argcAsmPath, ARGC32_SRC, 'utf8');
    const build = spawnSync('fasm2', ['-i', "include 'listing.inc'", argcAsmPath, argcProgramPath], { cwd: argcDir, timeout: 15000 });
    if (build.status !== 0) throw new Error(`fasm2 build failed:\n${build.stdout}\n${build.stderr}`);
    fs.chmodSync(argcProgramPath, 0o755);

    const proc = spawn(process.execPath, [path.join(__dirname, '..', 'dist', 'adapter.js')], { stdio: ['pipe', 'pipe', 'pipe'] });
    const client = new DapClient(proc);
    const stderrChunks: string[] = [];
    proc.stderr.on('data', (c: Buffer) => stderrChunks.push(c.toString('utf8')));

    try {
      await client.sendRequest('initialize', { adapterID: 'fasm2', linesStartAt1: true, columnsStartAt1: true, pathFormat: 'path' });
      await client.waitForEvent('initialized');
      await client.sendRequest('launch', { program: argcProgramPath, asmFile: argcAsmPath, listingFile: argcListingPath, cwd: argcDir });

      const bpResponse = await client.sendRequest<{ breakpoints: Array<{ verified: boolean }> }>('setBreakpoints', {
        source: { path: argcAsmPath },
        breakpoints: [{ line: 9 }], // "nop", right after "mov [argc], ecx" has executed
      });
      assert.strictEqual(bpResponse.breakpoints[0].verified, true);

      await client.sendRequest('configurationDone');
      await client.waitForEvent('stopped', (b) => (b as { reason?: string }).reason === 'breakpoint');

      const scopes = await client.sendRequest<{ scopes: Array<{ variablesReference: number }> }>('scopes', { frameId: 1 });
      const registersRef = scopes.scopes[0].variablesReference;

      // The bug: eax used to be entirely absent (only rax/rbx/... were ever queried), so every
      // register on a 32-bit target read back "<unavailable>".
      const eax = await findRegisterValue(client, registersRef, 'eax');
      assert.ok(eax, 'expected "eax" to be a real register on a 32-bit target');
      assert.ok(!eax!.includes('unavailable'), `expected eax to have a real value, got: ${eax}`);
      assert.match(eax!, /^eax = 0x[0-9a-f]{8}  \d+  0b[01_]+$/);

      // rax must NOT appear at all for a 32-bit target — it doesn't exist on this architecture.
      const rax = await findRegisterValue(client, registersRef, 'rax');
      assert.strictEqual(rax, undefined, 'expected no "rax" register to be reported for a 32-bit (i386) target');

      // Segment registers are real, gdb-reported values too, not just a curated GP set.
      const cs = await findRegisterValue(client, registersRef, 'cs');
      assert.ok(cs && /^cs = 0x[0-9a-f]{4}/.test(cs), `expected a real "cs" segment register value, got: ${cs}`);

      // Flags decode into individual named bits, not just a raw eflags number.
      const flagsGroupRef = await getRegisterGroupRef(client, registersRef, 'Flags');
      const flagsMembers = await client.sendRequest<{ variables: Array<{ name: string; value: string; type?: string }> }>('variables', {
        variablesReference: flagsGroupRef,
      });
      const ifFlag = flagsMembers.variables.find((v) => v.name === 'IF');
      assert.ok(ifFlag, 'expected an "IF" flag entry in the Flags group');
      assert.strictEqual(ifFlag!.value, '1', 'expected the Interrupt Enable flag to read as 1 in a normal running process');
      assert.ok(ifFlag!.type && ifFlag!.type.length > 10, 'expected a real explanatory description on the flag, not a bare name');

      // The actual feature request: hovering/watching "argc" (a label with no gdb symbol at all)
      // shows both its address and, since "dd" makes its size unambiguous, its current value —
      // clearly labeled as distinct things, not just a bare number that could be either.
      const argcHover = await client.sendRequest<{ result: string }>('evaluate', { expression: 'argc', context: 'hover' });
      assert.match(argcHover.result, /^argc {2}\(label, address 0x[0-9a-f]+\)\nvalue = 0x00000001 {2}1 {2}0b[01_]+$/);

      // A plain code label (no declared size) shows only the address — never a guessed-at value.
      const startHover = await client.sendRequest<{ result: string }>('evaluate', { expression: 'start', context: 'hover' });
      assert.match(startHover.result, /^start {2}\(label, address 0x[0-9a-f]+\)$/);

      await client.sendRequest('continue', { threadId: 1 });
      await client.waitForEvent('terminated');
      await client.sendRequest('disconnect');
    } catch (err) {
      throw new Error(`${(err as Error).message}\n--- adapter stderr ---\n${stderrChunks.join('')}`);
    } finally {
      proc.kill();
      fs.rmSync(argcDir, { recursive: true, force: true });
    }
  });

  it('shows arrays and strings for data labels, in both detailed (hover) and compact (watch/Data Labels scope) form', async function () {
    this.timeout(30000);

    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fasm2-studio-dap-e2e-data-'));
    const dataAsmPath = path.join(dataDir, 'data.asm');
    const dataProgramPath = path.join(dataDir, 'data');
    const dataListingPath = path.join(dataDir, 'data.lst');
    const DATA_SRC = [
      'format ELF executable 3',
      'entry start',
      '',
      'segment readable executable',
      '',
      'start:',
      '\tnop',
      '\tmov eax, 1',
      '\tmov ebx, 0',
      '\tint 0x80',
      '',
      'segment readable writeable',
      '',
      'table dd 10, 20, 30, 40',
      "msg db 'Hi there', 0",
      '',
    ].join('\n');
    fs.writeFileSync(dataAsmPath, DATA_SRC, 'utf8');
    const build = spawnSync('fasm2', ['-i', "include 'listing.inc'", dataAsmPath, dataProgramPath], { cwd: dataDir, timeout: 15000 });
    if (build.status !== 0) throw new Error(`fasm2 build failed:\n${build.stdout}\n${build.stderr}`);
    fs.chmodSync(dataProgramPath, 0o755);

    const proc = spawn(process.execPath, [path.join(__dirname, '..', 'dist', 'adapter.js')], { stdio: ['pipe', 'pipe', 'pipe'] });
    const client = new DapClient(proc);
    const stderrChunks: string[] = [];
    proc.stderr.on('data', (c: Buffer) => stderrChunks.push(c.toString('utf8')));

    try {
      await client.sendRequest('initialize', { adapterID: 'fasm2', linesStartAt1: true, columnsStartAt1: true, pathFormat: 'path' });
      await client.waitForEvent('initialized');
      await client.sendRequest('launch', { program: dataProgramPath, asmFile: dataAsmPath, listingFile: dataListingPath, cwd: dataDir });

      const bpResponse = await client.sendRequest<{ breakpoints: Array<{ verified: boolean }> }>('setBreakpoints', {
        source: { path: dataAsmPath },
        breakpoints: [{ line: 7 }], // "nop" — table/msg are statically initialized, already correct here
      });
      assert.strictEqual(bpResponse.breakpoints[0].verified, true);

      await client.sendRequest('configurationDone');
      await client.waitForEvent('stopped', (b) => (b as { reason?: string }).reason === 'breakpoint');

      // Array: detailed (hover) shows every element with its declared type; compact (watch) is a
      // terser bracketed list — both real reads of the actual initialized data, not guesses.
      const tableHover = await client.sendRequest<{ result: string }>('evaluate', { expression: 'table', context: 'hover' });
      assert.match(tableHover.result, /^table {2}\(label, address 0x[0-9a-f]+\)\n4 × dword: \[0xa, 0x14, 0x1e, 0x28\]$/);
      const tableWatch = await client.sendRequest<{ result: string }>('evaluate', { expression: 'table', context: 'watch' });
      assert.strictEqual(tableWatch.result, '[10, 20, 30, 40]');

      // String: detailed shows the byte count and null-terminated note; compact is just the quoted
      // text, ready to read at a glance without cluttering a Watch/inline-value row.
      const msgHover = await client.sendRequest<{ result: string }>('evaluate', { expression: 'msg', context: 'hover' });
      assert.match(msgHover.result, /^msg {2}\(label, address 0x[0-9a-f]+\)\nstring\[9\] = "Hi there"  \(null-terminated\)$/);
      const msgWatch = await client.sendRequest<{ result: string }>('evaluate', { expression: 'msg', context: 'watch' });
      assert.strictEqual(msgWatch.result, '"Hi there"');

      // The Data Labels scope: lists table/msg (real data) but not "start" (a plain code label —
      // deliberately out of scope for this panel, see session.ts). table is expandable into
      // per-index children; msg (a string) is not.
      const scopes = await client.sendRequest<{ scopes: Array<{ name: string; variablesReference: number }> }>('scopes', { frameId: 1 });
      const labelsScope = scopes.scopes.find((s) => s.name === 'Data Labels');
      assert.ok(labelsScope, 'expected a "Data Labels" scope');
      const labelsVars = await client.sendRequest<{ variables: Array<{ name: string; value: string; variablesReference: number }> }>('variables', {
        variablesReference: labelsScope!.variablesReference,
      });
      assert.strictEqual(labelsVars.variables.find((v) => v.name === 'start'), undefined, 'expected no code label in Data Labels');

      const tableRow = labelsVars.variables.find((v) => v.name === 'table');
      assert.ok(tableRow);
      assert.strictEqual(tableRow!.value, '[10, 20, 30, 40]');
      assert.ok(tableRow!.variablesReference > 0, 'expected "table" to be expandable into its elements');

      const msgRow = labelsVars.variables.find((v) => v.name === 'msg');
      assert.ok(msgRow);
      assert.strictEqual(msgRow!.value, '"Hi there"');
      assert.strictEqual(msgRow!.variablesReference, 0, 'expected a string label to not be expandable');

      const tableElements = await client.sendRequest<{ variables: Array<{ name: string; value: string }> }>('variables', {
        variablesReference: tableRow!.variablesReference,
      });
      assert.deepStrictEqual(
        tableElements.variables.map((v) => v.name),
        ['[0]', '[1]', '[2]', '[3]'],
      );
      assert.strictEqual(tableElements.variables[2].value, 'value = 0x0000001e  30  0b0000_0000_0000_0000_0000_0000_0001_1110');

      await client.sendRequest('continue', { threadId: 1 });
      await client.waitForEvent('terminated');
      await client.sendRequest('disconnect');
    } catch (err) {
      throw new Error(`${(err as Error).message}\n--- adapter stderr ---\n${stderrChunks.join('')}`);
    } finally {
      proc.kill();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('returns a clean empty result for a blank Debug Console/Watch expression, instead of gdb\'s raw "Argument required"', async function () {
    this.timeout(30000);

    // The exact user-reported scenario: pressing Enter on an empty Debug Console line, or an empty
    // Watch entry. Before this guard, the empty string sailed through every resolution step and
    // reached gdb as `-data-evaluate-expression ""`, which rejects with its own raw "Argument
    // required (expression to compute)." — confusing for something that was never a real command.
    const proc = spawn(process.execPath, [path.join(__dirname, '..', 'dist', 'adapter.js')], { stdio: ['pipe', 'pipe', 'pipe'] });
    const client = new DapClient(proc);
    const stderrChunks: string[] = [];
    proc.stderr.on('data', (c: Buffer) => stderrChunks.push(c.toString('utf8')));

    try {
      await client.sendRequest('initialize', { adapterID: 'fasm2', linesStartAt1: true, columnsStartAt1: true, pathFormat: 'path' });
      await client.waitForEvent('initialized');
      await client.sendRequest('launch', { program: programPath, asmFile: asmPath, listingFile: listingPath, cwd: dir });
      await client.sendRequest('setBreakpoints', { source: { path: asmPath }, breakpoints: [{ line: 9 }] }); // "add eax, ebx"
      await client.sendRequest('configurationDone');
      await client.waitForEvent('stopped', (b) => (b as { reason?: string }).reason === 'breakpoint');

      const blankRepl = await client.sendRequest<{ result: string }>('evaluate', { expression: '', context: 'repl' });
      assert.strictEqual(blankRepl.result, '');

      const whitespaceWatch = await client.sendRequest<{ result: string }>('evaluate', { expression: '   ', context: 'watch' });
      assert.strictEqual(whitespaceWatch.result, '');

      await client.sendRequest('continue', { threadId: 1 });
      await client.waitForEvent('terminated');
      await client.sendRequest('disconnect');
    } catch (err) {
      throw new Error(`${(err as Error).message}\n--- adapter stderr ---\n${stderrChunks.join('')}`);
    } finally {
      proc.kill();
    }
  });

  it('runs a raw gdb command typed into the Debug Console, and reports the target as continued when the command resumes it', async function () {
    this.timeout(30000);

    // The other half of the "console isn't a real gdb console" complaint: typing "print 1+1" or
    // "continue" directly into the Debug Console used to just be evaluated as a (failing) value
    // expression. Now anything not resolved as a register/label/constant, in 'repl' context only,
    // is run as a real gdb CLI command via -interpreter-exec console — its console output arrives
    // as an 'output' event exactly like any other gdb console text.
    const proc = spawn(process.execPath, [path.join(__dirname, '..', 'dist', 'adapter.js')], { stdio: ['pipe', 'pipe', 'pipe'] });
    const client = new DapClient(proc);
    const stderrChunks: string[] = [];
    proc.stderr.on('data', (c: Buffer) => stderrChunks.push(c.toString('utf8')));

    try {
      await client.sendRequest('initialize', { adapterID: 'fasm2', linesStartAt1: true, columnsStartAt1: true, pathFormat: 'path' });
      await client.waitForEvent('initialized');
      await client.sendRequest('launch', { program: programPath, asmFile: asmPath, listingFile: listingPath, cwd: dir });
      await client.sendRequest('setBreakpoints', { source: { path: asmPath }, breakpoints: [{ line: 9 }] }); // "add eax, ebx"
      await client.sendRequest('configurationDone');
      await client.waitForEvent('stopped', (b) => (b as { reason?: string }).reason === 'breakpoint');

      const printOutput = client.waitForEvent('output', (b) => /\$1 = 2/.test((b as { output?: string }).output ?? ''));
      const printResult = await client.sendRequest<{ result: string }>('evaluate', { expression: 'print 1+1', context: 'repl' });
      assert.strictEqual(printResult.result, '', 'the value itself arrives as console output text, not as the evaluate response');
      await printOutput;

      // A raw "continue" typed here arrives as an 'evaluate' request, not a 'continue' request —
      // without an explicit ContinuedEvent, VS Code would have no way to know the target resumed
      // and would leave the Variables/Call Stack views showing stale, stopped-at-the-breakpoint data.
      const continuedEvent = client.waitForEvent('continued');
      await client.sendRequest('evaluate', { expression: 'continue', context: 'repl' });
      await continuedEvent;

      await client.waitForEvent('terminated');
      await client.sendRequest('disconnect');
    } catch (err) {
      throw new Error(`${(err as Error).message}\n--- adapter stderr ---\n${stderrChunks.join('')}`);
    } finally {
      proc.kill();
    }
  });

  it('Step Over runs straight through a call inside a macro invocation; Step Into dives into it', async function () {
    this.timeout(30000);

    // The real user-reported scenario: a macro like "write_msg target, msg, msglen" whose body
    // ends in a real "call target" — stepping onto the invocation line and pressing Step used to
    // always dive into the callee (both were "-exec-step-instruction" under the hood, no
    // distinction). This macro is deliberately parameter-free ("call_helper" -> "call helper"): its
    // invocation-line text ("call_helper", one token) and its own macro-body text ("call helper",
    // two tokens) are never equal, so the listing's address<->line correlation unambiguously
    // attributes the generated "call" instruction to the *invocation* line, not the macro body —
    // confirmed for real against fasm2's own listing output before writing this test.
    const stepDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fasm2-studio-dap-e2e-step-'));
    const stepAsmPath = path.join(stepDir, 'step.asm');
    const stepProgramPath = path.join(stepDir, 'step');
    const stepListingPath = path.join(stepDir, 'step.lst');
    const STEP_SRC = [
      'format ELF64 executable 3', // 1
      'entry start', // 2
      '', // 3
      'macro call_helper', // 4
      '    call helper', // 5
      'end macro', // 6
      '', // 7
      'segment readable executable', // 8
      '', // 9
      'start:', // 10
      '\tmov eax, 1', // 11
      '\tcall_helper', // 12
      '\tmov ebx, 2', // 13
      '\tnop', // 14
      '\tmov edi, 0', // 15
      '\tmov eax, 60', // 16
      '\tsyscall', // 17
      '', // 18
      'helper:', // 19
      '\tmov ecx, 3', // 20
      '\tret', // 21
      '', // 22
    ].join('\n');
    fs.writeFileSync(stepAsmPath, STEP_SRC, 'utf8');
    const build = spawnSync('fasm2', ['-i', "include 'listing.inc'", stepAsmPath, stepProgramPath], { cwd: stepDir, timeout: 15000 });
    if (build.status !== 0) throw new Error(`fasm2 build failed:\n${build.stdout}\n${build.stderr}`);
    fs.chmodSync(stepProgramPath, 0o755);

    async function stopAtCallHelper(): Promise<{ client: DapClient; proc: ChildProcessWithoutNullStreams }> {
      const proc = spawn(process.execPath, [path.join(__dirname, '..', 'dist', 'adapter.js')], { stdio: ['pipe', 'pipe', 'pipe'] });
      const client = new DapClient(proc);
      await client.sendRequest('initialize', { adapterID: 'fasm2', linesStartAt1: true, columnsStartAt1: true, pathFormat: 'path' });
      await client.waitForEvent('initialized');
      await client.sendRequest('launch', { program: stepProgramPath, asmFile: stepAsmPath, listingFile: stepListingPath, cwd: stepDir });
      const bp = await client.sendRequest<{ breakpoints: Array<{ verified: boolean }> }>('setBreakpoints', {
        source: { path: stepAsmPath },
        breakpoints: [{ line: 12 }], // "call_helper"
      });
      assert.strictEqual(bp.breakpoints[0].verified, true);
      await client.sendRequest('configurationDone');
      await client.waitForEvent('stopped', (b) => (b as { reason?: string }).reason === 'breakpoint');
      return { client, proc };
    }

    const over = await stopAtCallHelper();
    try {
      await over.client.sendRequest('next', { threadId: 1 });
      await over.client.waitForEvent('stopped', (b) => (b as { reason?: string }).reason === 'step');
      const stackTrace = await over.client.sendRequest<{ stackFrames: Array<{ line: number }> }>('stackTrace', { threadId: 1 });
      assert.strictEqual(stackTrace.stackFrames[0].line, 13, 'Step Over should land on "mov ebx, 2" (line 13), never inside helper: (line 20)');

      await over.client.sendRequest('continue', { threadId: 1 });
      await over.client.waitForEvent('terminated');
      await over.client.sendRequest('disconnect');
    } finally {
      over.proc.kill();
    }

    const into = await stopAtCallHelper();
    try {
      await into.client.sendRequest('stepIn', { threadId: 1 });
      await into.client.waitForEvent('stopped', (b) => (b as { reason?: string }).reason === 'step');
      const stackTrace = await into.client.sendRequest<{ stackFrames: Array<{ line: number }> }>('stackTrace', { threadId: 1 });
      assert.strictEqual(stackTrace.stackFrames[0].line, 20, 'Step Into should dive into helper: (line 20), same as before this distinction existed');

      await into.client.sendRequest('continue', { threadId: 1 });
      await into.client.waitForEvent('terminated');
      await into.client.sendRequest('disconnect');
    } finally {
      into.proc.kill();
    }
  });

  it('supports instruction-granularity stepping and exposes instructionPointerReference, backing VS Code\'s Disassembly View', async function () {
    this.timeout(30000);

    const proc = spawn(process.execPath, [path.join(__dirname, '..', 'dist', 'adapter.js')], { stdio: ['pipe', 'pipe', 'pipe'] });
    const client = new DapClient(proc);
    const stderrChunks: string[] = [];
    proc.stderr.on('data', (c: Buffer) => stderrChunks.push(c.toString('utf8')));

    try {
      const capabilities = await client.sendRequest<{ supportsSteppingGranularity?: boolean; supportsDisassembleRequest?: boolean }>('initialize', {
        adapterID: 'fasm2',
        linesStartAt1: true,
        columnsStartAt1: true,
        pathFormat: 'path',
      });
      assert.strictEqual(capabilities.supportsSteppingGranularity, true);
      assert.strictEqual(capabilities.supportsDisassembleRequest, true);
      await client.waitForEvent('initialized');
      await client.sendRequest('launch', { program: programPath, asmFile: asmPath, listingFile: listingPath, cwd: dir });

      await client.sendRequest('setBreakpoints', { source: { path: asmPath }, breakpoints: [{ line: 7 }] }); // "mov eax, 1"
      await client.sendRequest('configurationDone');
      await client.waitForEvent('stopped', (b) => (b as { reason?: string }).reason === 'breakpoint');

      const beforeTrace = await client.sendRequest<{ stackFrames: Array<{ line: number; instructionPointerReference?: string }> }>('stackTrace', {
        threadId: 1,
      });
      const startPc = beforeTrace.stackFrames[0].instructionPointerReference;
      assert.ok(startPc && /^0x[0-9a-f]+$/i.test(startPc), `expected a hex instructionPointerReference, got: ${startPc}`);
      assert.strictEqual(beforeTrace.stackFrames[0].line, 7);

      // One raw machine-instruction step (Disassembly View's own "Step"), not a statement step —
      // "mov eax, 1" is 5 bytes, so the PC should land exactly 5 bytes later, still one real
      // instruction short of "mov ebx, 2" (the next *source-mapped* line).
      await client.sendRequest('next', { threadId: 1, granularity: 'instruction' });
      await client.waitForEvent('stopped', (b) => (b as { reason?: string }).reason === 'step');

      const afterTrace = await client.sendRequest<{ stackFrames: Array<{ line: number; instructionPointerReference?: string }> }>('stackTrace', {
        threadId: 1,
      });
      const afterPc = afterTrace.stackFrames[0].instructionPointerReference;
      assert.ok(afterPc, 'expected instructionPointerReference to still be set even off the exact PC read at the breakpoint');
      assert.strictEqual(BigInt(afterPc!) - BigInt(startPc!), 5n, '"mov eax, 1" (B8 01 00 00 00) is exactly 5 bytes');

      await client.sendRequest('continue', { threadId: 1 });
      await client.waitForEvent('terminated');
      await client.sendRequest('disconnect');
    } catch (err) {
      throw new Error(`${(err as Error).message}\n--- adapter stderr ---\n${stderrChunks.join('')}`);
    } finally {
      proc.kill();
    }
  });

  it('disassembles byte-accurately in Intel syntax, forward and backward through an unmapped mid-macro address, with placeholder rows before the first instruction', async function () {
    this.timeout(30000);

    // "backward" is the hard direction: x86 instructions are variable-length, so there's no
    // generally-sound way to find a real instruction boundary by walking backward from an
    // arbitrary address. This is the actual test of disassembleAround's anchor-and-forward-decode
    // strategy — proven here by asking for the *same* 3 instructions two different ways (forward
    // from their own known-good start, and backward from the last one, an address with no source
    // mapping of its own) and requiring byte-identical results either way.
    const disDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fasm2-studio-dap-e2e-disasm-'));
    const disAsmPath = path.join(disDir, 'dis.asm');
    const disProgramPath = path.join(disDir, 'dis');
    const disListingPath = path.join(disDir, 'dis.lst');
    const DIS_SRC = [
      'format ELF64 executable 3', // 1
      'entry start', // 2
      '', // 3
      'macro triple target, a, b', // 4
      '    mov eax, a', // 5
      '    mov ebx, b', // 6
      '    call target', // 7
      'end macro', // 8
      '', // 9
      'segment readable executable', // 10
      '', // 11
      'start:', // 12
      '\tnop', // 13
      '\ttriple helper, 0x11, 0x22', // 14
      '\tmov ecx, 0x33', // 15
      '\tnop', // 16
      '\tmov edi, 0', // 17
      '\tmov eax, 60', // 18
      '\tsyscall', // 19
      '', // 20
      'helper:', // 21
      '\tmov edx, 0x44', // 22
      '\tret', // 23
      '', // 24
    ].join('\n');
    fs.writeFileSync(disAsmPath, DIS_SRC, 'utf8');
    const build = spawnSync('fasm2', ['-i', "include 'listing.inc'", disAsmPath, disProgramPath], { cwd: disDir, timeout: 15000 });
    if (build.status !== 0) throw new Error(`fasm2 build failed:\n${build.stdout}\n${build.stderr}`);
    fs.chmodSync(disProgramPath, 0o755);

    const proc = spawn(process.execPath, [path.join(__dirname, '..', 'dist', 'adapter.js')], { stdio: ['pipe', 'pipe', 'pipe'] });
    const client = new DapClient(proc);
    const stderrChunks: string[] = [];
    proc.stderr.on('data', (c: Buffer) => stderrChunks.push(c.toString('utf8')));

    type Insn = { address: string; instruction: string; instructionBytes?: string; line?: number; presentationHint?: string };

    try {
      await client.sendRequest('initialize', { adapterID: 'fasm2', linesStartAt1: true, columnsStartAt1: true, pathFormat: 'path' });
      await client.waitForEvent('initialized');
      await client.sendRequest('launch', { program: disProgramPath, asmFile: disAsmPath, listingFile: disListingPath, cwd: disDir });

      const bp = await client.sendRequest<{ breakpoints: Array<{ verified: boolean }> }>('setBreakpoints', {
        source: { path: disAsmPath },
        breakpoints: [{ line: 13 }, { line: 14 }], // "nop", then "triple helper, 0x11, 0x22"
      });
      assert.strictEqual(bp.breakpoints.length, 2);
      assert.ok(bp.breakpoints.every((b) => b.verified));

      await client.sendRequest('configurationDone');
      await client.waitForEvent('stopped', (b) => (b as { reason?: string }).reason === 'breakpoint');

      // First stop: the very first instruction of the executable segment. Nothing is mapped
      // before it (the ELF header's own listing entry sits at address 0, but "nop" here is
      // already its own nearest-known-address-at-or-before itself), so asking for instructions
      // *before* it must come back as placeholder rows, never garbage decoded from data bytes.
      const nopTrace = await client.sendRequest<{ stackFrames: Array<{ line: number; instructionPointerReference?: string }> }>('stackTrace', {
        threadId: 1,
      });
      assert.strictEqual(nopTrace.stackFrames[0].line, 13);
      const nopPc = nopTrace.stackFrames[0].instructionPointerReference!;

      const beforeNop = await client.sendRequest<{ instructions: Insn[] }>('disassemble', {
        memoryReference: nopPc,
        instructionOffset: -2,
        instructionCount: 2,
      });
      assert.strictEqual(beforeNop.instructions.length, 2);
      for (const insn of beforeNop.instructions) assert.strictEqual(insn.presentationHint, 'invalid', 'nothing real precedes the segment\'s first instruction');

      // Second stop: the macro invocation. Its first generated instruction ("mov eax, 0x11") is
      // the only one of the three the listing attributes a source line to at all — the other two
      // ("mov ebx, 0x22" and "call helper", both inside the same collapsed macro expansion) have
      // no source mapping of their own, which is exactly the scenario disassembleAround's backward
      // reconstruction has to get right.
      await client.sendRequest('continue', { threadId: 1 });
      await client.waitForEvent('stopped', (b) => (b as { reason?: string }).reason === 'breakpoint');

      const macroTrace = await client.sendRequest<{ stackFrames: Array<{ line: number; instructionPointerReference?: string }> }>('stackTrace', {
        threadId: 1,
      });
      assert.strictEqual(macroTrace.stackFrames[0].line, 14);
      const macroStart = macroTrace.stackFrames[0].instructionPointerReference!;

      const forward = await client.sendRequest<{ instructions: Insn[] }>('disassemble', {
        memoryReference: macroStart,
        instructionOffset: 0,
        instructionCount: 3,
      });
      assert.strictEqual(forward.instructions.length, 3);
      const [movEax, movEbx, call] = forward.instructions;

      assert.match(movEax.instruction, /mov\s+eax,\s*0x?11/i, `expected Intel-syntax "mov eax, 0x11", got: ${movEax.instruction}`);
      assert.strictEqual(movEax.address, macroStart);
      assert.strictEqual(movEax.line, 14, 'the macro invocation\'s first generated instruction carries the invocation\'s own source line');
      assert.ok(movEax.instructionBytes && /^[0-9a-f]{2}(\s[0-9a-f]{2})*$/i.test(movEax.instructionBytes), `expected raw opcode bytes, got: ${movEax.instructionBytes}`);

      assert.match(movEbx.instruction, /mov\s+ebx,\s*0x?22/i, `expected Intel-syntax "mov ebx, 0x22", got: ${movEbx.instruction}`);
      assert.strictEqual(movEbx.line, undefined, 'the 2nd instruction of the collapsed macro expansion has no source line of its own');

      assert.match(call.instruction, /^call\b/i, `expected a call instruction, got: ${call.instruction}`);
      assert.strictEqual(call.line, undefined);

      // The actual proof: asking for the same 3 instructions *backward*, anchored on the call's
      // own (unmapped) address, must reconstruct byte-identical results to the forward decode.
      const backward = await client.sendRequest<{ instructions: Insn[] }>('disassemble', {
        memoryReference: call.address,
        instructionOffset: -2,
        instructionCount: 3,
      });
      assert.deepStrictEqual(
        backward.instructions.map((i) => [i.address, i.instruction]),
        forward.instructions.map((i) => [i.address, i.instruction]),
        'backward reconstruction through an unmapped mid-macro address must byte-align with the forward decode from the real, known-good boundary',
      );

      await client.sendRequest('continue', { threadId: 1 });
      await client.waitForEvent('terminated');
      await client.sendRequest('disconnect');
    } catch (err) {
      throw new Error(`${(err as Error).message}\n--- adapter stderr ---\n${stderrChunks.join('')}`);
    } finally {
      proc.kill();
      fs.rmSync(disDir, { recursive: true, force: true });
    }
  });

  it('hovering/watching a macro invocation itself (e.g. "write_msg" in "write_msg write_stderr, ...") gets a friendly message, not gdb\'s raw "No symbol table is loaded"', async function () {
    this.timeout(30000);

    // The exact user-reported scenario, reproduced with the real write_msg macro shape: a macro
    // vanishes entirely at compile time (fasmg substitutes its body inline; nothing is ever
    // generated for the macro *name* itself), so gdb has no symbol to resolve when hovering/
    // watching "write_msg" on the invocation line — it used to fall through to gdb's own
    // evaluator and surface its raw "No symbol table is loaded. Use the \"file\" command." error.
    const macroDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fasm2-studio-dap-e2e-macroname-'));
    const macroAsmPath = path.join(macroDir, 'macroname.asm');
    const macroProgramPath = path.join(macroDir, 'macroname');
    const macroListingPath = path.join(macroDir, 'macroname.lst');
    const MACRO_SRC = [
      'format ELF64 executable 3', // 1
      'entry start', // 2
      '', // 3
      'macro write_msg target, msg, msglen', // 4
      '    mov rsi, msg', // 5
      '    mov rdx, msglen', // 6
      '    call target', // 7
      'end macro', // 8
      '', // 9
      'segment readable executable', // 10
      '', // 11
      'start:', // 12
      '\twrite_msg write_stderr, usage_text, usage_text_len', // 13
      '\tmov edi, 0', // 14
      '\tmov eax, 60', // 15
      '\tsyscall', // 16
      '', // 17
      'write_stderr:', // 18
      '\tret', // 19
      '', // 20
      'segment readable writeable', // 21
      'usage_text db "usage",10', // 22
      'usage_text_len = $ - usage_text', // 23
      '', // 24
    ].join('\n');
    fs.writeFileSync(macroAsmPath, MACRO_SRC, 'utf8');
    const build = spawnSync('fasm2', ['-i', "include 'listing.inc'", macroAsmPath, macroProgramPath], { cwd: macroDir, timeout: 15000 });
    if (build.status !== 0) throw new Error(`fasm2 build failed:\n${build.stdout}\n${build.stderr}`);
    fs.chmodSync(macroProgramPath, 0o755);

    const proc = spawn(process.execPath, [path.join(__dirname, '..', 'dist', 'adapter.js')], { stdio: ['pipe', 'pipe', 'pipe'] });
    const client = new DapClient(proc);
    const stderrChunks: string[] = [];
    proc.stderr.on('data', (c: Buffer) => stderrChunks.push(c.toString('utf8')));

    try {
      await client.sendRequest('initialize', { adapterID: 'fasm2', linesStartAt1: true, columnsStartAt1: true, pathFormat: 'path' });
      await client.waitForEvent('initialized');
      await client.sendRequest('launch', { program: macroProgramPath, asmFile: macroAsmPath, listingFile: macroListingPath, cwd: macroDir });

      const bpResponse = await client.sendRequest<{ breakpoints: Array<{ verified: boolean }> }>('setBreakpoints', {
        source: { path: macroAsmPath },
        breakpoints: [{ line: 13 }], // "write_msg write_stderr, usage_text, usage_text_len"
      });
      assert.strictEqual(bpResponse.breakpoints[0].verified, true);

      await client.sendRequest('configurationDone');
      await client.waitForEvent('stopped', (b) => (b as { reason?: string }).reason === 'breakpoint');

      const hover = await client.sendRequest<{ result: string }>('evaluate', { expression: 'write_msg', context: 'hover' });
      assert.match(hover.result, /no runtime value/i);
      assert.doesNotMatch(hover.result, /no symbol table/i);

      const watch = await client.sendRequest<{ result: string }>('evaluate', { expression: 'write_msg', context: 'watch' });
      assert.strictEqual(watch.result, '(no runtime value) write_msg');

      // The macro's *arguments* are real labels and still resolve normally — this fix is scoped
      // to the macro name itself, not a blanket "give up on this whole line" change.
      const argHover = await client.sendRequest<{ result: string }>('evaluate', { expression: 'write_stderr', context: 'hover' });
      assert.match(argHover.result, /\(label, address 0x/);

      // The other real user-reported regression this fix introduced and then had to un-introduce:
      // an instruction mnemonic (e.g. "js") already has a real hover from the language server's
      // own hover provider, shown *alongside* whatever this debug adapter returns for the same
      // token. A *successful* debug-hover response (the "no runtime value" text above) actually
      // gets displayed and steps on that working language hover; a *failed* one is silently
      // dropped by VS Code, leaving the language hover to stand on its own — so a known mnemonic
      // must keep failing the old way, not succeed with this adapter's own message.
      await assert.rejects(
        client.sendRequest('evaluate', { expression: 'js', context: 'hover' }),
        (err: Error) => !/no runtime value/i.test(err.message),
        'a known instruction mnemonic must not get the "no runtime value" short-circuit',
      );

      await client.sendRequest('continue', { threadId: 1 });
      await client.waitForEvent('terminated');
      await client.sendRequest('disconnect');
    } catch (err) {
      throw new Error(`${(err as Error).message}\n--- adapter stderr ---\n${stderrChunks.join('')}`);
    } finally {
      proc.kill();
      fs.rmSync(macroDir, { recursive: true, force: true });
    }
  });

  it('stepping the exact instruction that exits the program terminates cleanly, with no spurious "step failed: The program is not being run."', async function () {
    this.timeout(30000);

    // Real user-reported bug: waitForNextStop used to resolve `true` for *any* 'stopped' event,
    // including one caused by the inferior exiting (not just gdb's own process exiting). Stepping
    // the program's last instruction (its own exit syscall) hit exactly that: the loop treated the
    // resulting "can't read $pc, no inferior" failure as "landed on an unmapped address, keep
    // stepping", and sent one more step command to an already-dead process.
    const proc = spawn(process.execPath, [path.join(__dirname, '..', 'dist', 'adapter.js')], { stdio: ['pipe', 'pipe', 'pipe'] });
    const client = new DapClient(proc);
    const stderrChunks: string[] = [];
    proc.stderr.on('data', (c: Buffer) => stderrChunks.push(c.toString('utf8')));

    try {
      await client.sendRequest('initialize', { adapterID: 'fasm2', linesStartAt1: true, columnsStartAt1: true, pathFormat: 'path' });
      await client.waitForEvent('initialized');
      await client.sendRequest('launch', { program: programPath, asmFile: asmPath, listingFile: listingPath, cwd: dir });

      // "syscall" (line 13) is the program's very last instruction — it directly exits the process.
      await client.sendRequest('setBreakpoints', { source: { path: asmPath }, breakpoints: [{ line: 13 }] });
      await client.sendRequest('configurationDone');
      await client.waitForEvent('stopped', (b) => (b as { reason?: string }).reason === 'breakpoint');

      await client.sendRequest('next', { threadId: 1 });
      await client.waitForEvent('terminated');

      // The buggy version of this code path fires its spurious second step *after* 'terminated'
      // has already gone out (it's queued on the next microtask via a still-pending
      // waitForNextStop() promise, a separate async chain from the synchronous 'stopped' listener
      // that sends TerminatedEvent) — so this needs a real grace period, not just an immediate
      // check right after 'terminated', to give that straggler command a chance to actually land.
      await new Promise((resolve) => setTimeout(resolve, 500));

      const stepFailedOutput = client.events.find((e) => e.event === 'output' && /step failed/i.test((e.body as { output?: string }).output ?? ''));
      assert.strictEqual(stepFailedOutput, undefined, `expected no spurious step-failed output, got: ${JSON.stringify(stepFailedOutput)}`);

      await client.sendRequest('disconnect');
    } catch (err) {
      throw new Error(`${(err as Error).message}\n--- adapter stderr ---\n${stderrChunks.join('')}`);
    } finally {
      proc.kill();
    }
  });

  it('resolves a symbolic constant (e.g. "FD_STDERR = 2") to its value without ever asking gdb, instead of surfacing "No symbol table is loaded"', async function () {
    this.timeout(30000);

    // The exact user-reported scenario: a plain "NAME = literal" constant (no runtime address at
    // all — fasmg substitutes it at compile time) hovered while stopped. Before this resolved
    // constants itself, evaluateRequest fell through to gdb's own expression evaluator, which
    // correctly — but unhelpfully — rejects it with "No symbol table is loaded. Use the "file"
    // command." (there's no symbol table for gdb to have loaded; fasmg never emits one).
    const constDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fasm2-studio-dap-e2e-const-'));
    const constAsmPath = path.join(constDir, 'const.asm');
    const constProgramPath = path.join(constDir, 'const');
    const constListingPath = path.join(constDir, 'const.lst');
    const CONST_SRC = [
      'format ELF executable 3',
      'entry start',
      '',
      'FD_STDERR = 2',
      'FD_STDOUT equ 1',
      '',
      'segment readable executable',
      '',
      'start:',
      '\tmov eax, FD_STDERR',
      '\tmov ebx, FD_STDOUT',
      '\tnop',
      '\tmov eax, 1',
      '\tmov ebx, 0',
      '\tint 0x80',
      '',
    ].join('\n');
    fs.writeFileSync(constAsmPath, CONST_SRC, 'utf8');
    const build = spawnSync('fasm2', ['-i', "include 'listing.inc'", constAsmPath, constProgramPath], { cwd: constDir, timeout: 15000 });
    if (build.status !== 0) throw new Error(`fasm2 build failed:\n${build.stdout}\n${build.stderr}`);
    fs.chmodSync(constProgramPath, 0o755);

    const proc = spawn(process.execPath, [path.join(__dirname, '..', 'dist', 'adapter.js')], { stdio: ['pipe', 'pipe', 'pipe'] });
    const client = new DapClient(proc);
    const stderrChunks: string[] = [];
    proc.stderr.on('data', (c: Buffer) => stderrChunks.push(c.toString('utf8')));

    try {
      await client.sendRequest('initialize', { adapterID: 'fasm2', linesStartAt1: true, columnsStartAt1: true, pathFormat: 'path' });
      await client.waitForEvent('initialized');
      await client.sendRequest('launch', { program: constProgramPath, asmFile: constAsmPath, listingFile: constListingPath, cwd: constDir });

      const bpResponse = await client.sendRequest<{ breakpoints: Array<{ verified: boolean }> }>('setBreakpoints', {
        source: { path: constAsmPath },
        breakpoints: [{ line: 11 }], // "nop"
      });
      assert.strictEqual(bpResponse.breakpoints[0].verified, true);

      await client.sendRequest('configurationDone');
      await client.waitForEvent('stopped', (b) => (b as { reason?: string }).reason === 'breakpoint');

      const hover = await client.sendRequest<{ result: string }>('evaluate', { expression: 'FD_STDERR', context: 'hover' });
      assert.strictEqual(hover.result, 'FD_STDERR  (constant, defined via "=")\nvalue = 0x2  2');

      const watch = await client.sendRequest<{ result: string }>('evaluate', { expression: 'FD_STDOUT', context: 'watch' });
      assert.strictEqual(watch.result, '0x1  1');

      await client.sendRequest('continue', { threadId: 1 });
      await client.waitForEvent('terminated');
      await client.sendRequest('disconnect');
    } catch (err) {
      throw new Error(`${(err as Error).message}\n--- adapter stderr ---\n${stderrChunks.join('')}`);
    } finally {
      proc.kill();
      fs.rmSync(constDir, { recursive: true, force: true });
    }
  });
});
