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

      const variables = await client.sendRequest<{ variables: Array<{ name: string; value: string }> }>('variables', {
        variablesReference: registersScope.variablesReference,
      });
      const eax = variables.variables.find((v) => v.name === 'rax');
      assert.ok(eax && /\b1\b/.test(eax.value), `expected rax to read back as 1 before "add eax,ebx" executes, got: ${eax?.value}`);

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
      // rax reads back zero-extended from the eax write (standard x86-64 semantics).
      const scopes = await client.sendRequest<{ scopes: Array<{ variablesReference: number }> }>('scopes', { frameId: 1 });
      const variables = await client.sendRequest<{ variables: Array<{ name: string; value: string }> }>('variables', {
        variablesReference: scopes.scopes[0].variablesReference,
      });
      const rax = variables.variables.find((v) => v.name === 'rax');
      assert.strictEqual(rax?.value, 'rax = 0x00000000ffffffff  4294967295  0b0000_0000_0000_0000_0000_0000_0000_0000_1111_1111_1111_1111_1111_1111_1111_1111');

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
      const registersRef = scopes.scopes[0].variablesReference;

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

      await client.sendRequest('continue', { threadId: 1 });
      await client.waitForEvent('terminated');
      await client.sendRequest('disconnect');
    } catch (err) {
      throw new Error(`${(err as Error).message}\n--- adapter stderr ---\n${stderrChunks.join('')}`);
    } finally {
      proc.kill();
    }
  });
});
