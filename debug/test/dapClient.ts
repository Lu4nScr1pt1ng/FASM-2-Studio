// A DAP client that speaks the real wire protocol (Content-Length framing over stdio) to a spawned
// adapter process — exactly what VS Code itself does, with nothing mocked. Shared by every
// end-to-end test here; it started as a copy in each of them, which is how the two copies had
// already drifted apart in small ways before this file existed.
//
// Not named *.test.ts on purpose: mocha's glob would otherwise load it as a suite of its own.
import { ChildProcessWithoutNullStreams, spawnSync } from 'child_process';

export interface RawDapMessage {
  type: 'response' | 'event' | 'request';
  seq?: number;
  request_seq?: number;
  success?: boolean;
  message?: string;
  event?: string;
  command?: string;
  arguments?: unknown;
  body?: unknown;
}

/** Whether a command exists at all, so a suite can skip rather than fail on a machine without gdb
 * or a compiler installed. */
export function isAvailable(command: string): boolean {
  const result = spawnSync(command, ['--version'], { timeout: 5000 });
  return !(result.error && (result.error as NodeJS.ErrnoException).code === 'ENOENT');
}

/** Answers a reverse request (adapter → client). Returning a body accepts it; throwing rejects it,
 * which is how a client that cannot honour the request is simulated. */
export type ReverseRequestHandler = (args: unknown) => unknown;

export class DapClient {
  private buffer = Buffer.alloc(0);
  private seq = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private readonly eventWaiters: Array<{ event: string; predicate?: (body: unknown) => boolean; resolve: (body: unknown) => void }> = [];
  private readonly reverseHandlers = new Map<string, ReverseRequestHandler>();
  readonly events: Array<{ event: string; body: unknown }> = [];
  /** Reverse requests the adapter sent, in order — so a test can assert one was made at all. */
  readonly reverseRequests: Array<{ command: string; arguments: unknown }> = [];

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
    } else if (msg.type === 'request') {
      this.handleReverseRequest(msg);
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

  private handleReverseRequest(msg: RawDapMessage): void {
    this.reverseRequests.push({ command: msg.command!, arguments: msg.arguments });
    const handler = this.reverseHandlers.get(msg.command!);
    let response: RawDapMessage;
    if (!handler) {
      // An unhandled reverse request is refused rather than ignored — a client that stays silent
      // would only ever be distinguishable from a slow one by a timeout.
      response = { seq: this.seq++, type: 'response', request_seq: msg.seq, success: false, command: msg.command, message: 'unsupported request' };
    } else {
      try {
        response = { seq: this.seq++, type: 'response', request_seq: msg.seq, success: true, command: msg.command, body: handler(msg.arguments) };
      } catch (err) {
        response = { seq: this.seq++, type: 'response', request_seq: msg.seq, success: false, command: msg.command, message: (err as Error).message };
      }
    }
    this.write(response);
  }

  /** Registers the answer to a reverse request such as `runInTerminal`. */
  onReverseRequest(command: string, handler: ReverseRequestHandler): void {
    this.reverseHandlers.set(command, handler);
  }

  private write(message: RawDapMessage): void {
    const payload = JSON.stringify(message);
    this.proc.stdin.write(`Content-Length: ${Buffer.byteLength(payload, 'utf8')}\r\n\r\n${payload}`);
  }

  sendRequest<T = unknown>(command: string, args?: unknown): Promise<T> {
    const seq = this.seq++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(seq, { resolve: resolve as (v: unknown) => void, reject });
      this.write({ seq, type: 'request', command, arguments: args } as RawDapMessage);
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

  /** Every console/stdout OutputEvent seen so far, concatenated. */
  output(): string {
    return this.events
      .filter((e) => e.event === 'output')
      .map((e) => (e.body as { output?: string }).output ?? '')
      .join('');
  }
}
