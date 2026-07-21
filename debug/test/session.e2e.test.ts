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
