// Drives gdb (or lldb-mi, which speaks a compatible-enough subset of the same protocol) as a
// child process over its MI interface. One command in, one correlated result out via a
// token-keyed promise map; async records (breakpoint hits, process exit, console chatter) are
// re-emitted as events for the debug session to react to.
import { ChildProcess, spawn } from 'child_process';
import { EventEmitter } from 'events';
import { MIRecord, parseMILine } from './miParser';

export interface GdbDriverOptions {
  gdbPath: string;
  programPath: string;
  programArgs?: string[];
  cwd: string;
}

interface PendingCommand {
  resolve: (record: MIRecord) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const DEFAULT_COMMAND_TIMEOUT_MS = 10_000;

/**
 * Thin async wrapper over a spawned gdb/lldb-mi process's stdin/stdout MI stream.
 *
 * Emits (via the untyped EventEmitter API — annotate the listener's own parameter for type
 * safety at each call site, e.g. `driver.on('stopped', (data: Record<string, unknown>) => ...)`):
 *   'stopped'       (data: Record<string, unknown>) — a *stopped async record
 *   'running'       (data: Record<string, unknown>) — a *running async record
 *   'console'       (text: string)                  — ~"..." stream output
 *   'target-output' (text: string)                  — @"..." stream output (the debuggee's own I/O)
 *   'notify-async'  (record: MIRecord)               — =... records (thread/breakpoint lifecycle)
 *   'exit'          (code: number | null)            — the gdb process itself exited
 *   'error'         (err: Error)                     — the gdb process failed to spawn / errored
 */
export class GdbDriver extends EventEmitter {
  private child: ChildProcess | undefined;
  private nextToken = 1;
  private readonly pending = new Map<number, PendingCommand>();
  private buffer = '';

  start(opts: GdbDriverOptions): void {
    this.child = spawn(
      opts.gdbPath,
      ['--interpreter=mi3', '--nx', '-q', '--args', opts.programPath, ...(opts.programArgs ?? [])],
      { cwd: opts.cwd },
    );

    this.child.stdout?.on('data', (chunk: Buffer) => this.onData(chunk));
    this.child.stderr?.on('data', (chunk: Buffer) => this.emit('stderr', chunk.toString('utf8')));
    this.child.on('exit', (code) => {
      this.rejectAllPending(new Error('gdb process exited'));
      this.emit('exit', code);
    });
    this.child.on('error', (err) => {
      this.rejectAllPending(err);
      this.emit('error', err);
    });
  }

  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString('utf8');
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    let record: MIRecord;
    try {
      record = parseMILine(line);
    } catch {
      return; // one malformed line never takes down the whole session
    }

    switch (record.type) {
      case 'result': {
        if (record.token === undefined) break;
        const p = this.pending.get(record.token);
        if (!p) break;
        this.pending.delete(record.token);
        clearTimeout(p.timer);
        if (record.klass === 'error') {
          const data = record.data;
          const msg = data && typeof data === 'object' && typeof data.msg === 'string' ? data.msg : 'gdb command failed';
          p.reject(new Error(msg));
        } else {
          p.resolve(record);
        }
        break;
      }
      case 'exec-async':
        if (record.klass === 'stopped') this.emit('stopped', record.data ?? {});
        else if (record.klass === 'running') this.emit('running', record.data ?? {});
        break;
      case 'notify-async':
        this.emit('notify-async', record);
        break;
      case 'console':
        if (typeof record.data === 'string') this.emit('console', record.data);
        break;
      case 'target':
        if (typeof record.data === 'string') this.emit('target-output', record.data);
        break;
      default:
        break;
    }
  }

  private rejectAllPending(err: Error): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  /** Sends an MI command (e.g. "-break-insert *0x1000") and resolves with its matching result record. */
  sendCommand(command: string, timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS): Promise<MIRecord> {
    if (!this.child?.stdin) return Promise.reject(new Error('gdb process is not running'));
    const token = this.nextToken++;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(token);
        reject(new Error(`gdb command timed out after ${timeoutMs}ms: ${command}`));
      }, timeoutMs);
      this.pending.set(token, { resolve, reject, timer });
      this.child!.stdin!.write(`${token}${command}\n`);
    });
  }

  async dispose(): Promise<void> {
    if (!this.child) return;
    try {
      await this.sendCommand('-gdb-exit', 2000);
    } catch {
      // best-effort: fall through to a hard kill either way
    }
    this.rejectAllPending(new Error('gdb session disposed'));
    if (!this.child.killed) this.child.kill();
  }
}
