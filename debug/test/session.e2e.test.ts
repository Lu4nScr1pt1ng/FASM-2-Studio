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
      this.handleMessage(JSON.parse(body));
    }
  }

  private handleMessage(msg: any): void {
    if (msg.type === 'response') {
      const p = this.pending.get(msg.request_seq);
      if (p) {
        this.pending.delete(msg.request_seq);
        if (msg.success) p.resolve(msg.body);
        else p.reject(new Error(msg.message ?? 'request failed'));
      }
    } else if (msg.type === 'event') {
      this.events.push({ event: msg.event, body: msg.body });
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

      const stoppedBody = (await client.waitForEvent('stopped', (b: any) => b.reason === 'breakpoint')) as { threadId: number };
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
});
