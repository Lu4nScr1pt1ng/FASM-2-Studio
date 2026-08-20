// Giving the debugged program a terminal of its own.
//
// By default the program's output arrives as DAP output events and lands in the Debug Console,
// which is fine for a program that only prints — and useless for one that reads. The Debug Console
// has no stdin to offer, so a program blocked in a `read` syscall just sits there with nothing
// explaining why, and "read a number, print it back" is most of what people write while learning
// assembly.
//
// The fix is the one every real debugger uses: run the program on a terminal, and tell gdb about
// it. Something has to run *in* that terminal to report which tty it landed on and to keep the
// terminal open for as long as the session lasts; gdb's `-inferior-tty-set` then points the
// inferior's stdin/stdout/stderr at that tty, and from then on the program talks to the terminal
// directly with this adapter not in the middle of it at all.
//
// Windows has no pty for `-inferior-tty-set` to be pointed at — but the command does accept an
// ordinary Windows named pipe path there and wires the debuggee's stdio to it just the same
// (confirmed against a real gdb, GDB for MinGW-W64; not documented anywhere obvious). So on
// Windows the agent hosts a second pipe of its own — see ioEndpoint in session.ts's
// attachInferiorTerminal and listenForInferior in terminalAgent.ts — and relays it to this
// terminal directly, playing the same role a pty plays on POSIX. The one thing that pipe can't
// carry is liveness the way a tty path can (there's nothing to "hold open"), which is why the
// handshake connection below still exists on Windows too, purely to report readiness and keep
// the session and the terminal's lifetime tied together.
//
// That "something" is this adapter's own binary, re-invoked as `--terminal-agent` (terminalAgent.ts)
// — deliberately not a shell script. A shell script has to survive being *quoted for* and *typed
// into* whichever interactive shell the user happens to run, and that is not a battle worth
// fighting: a `while [ -e '...' ] && [ $i -lt 43200 ]; do sleep 1; done` reaches fish as a
// backslash-escaped wall of text, reaches cmd.exe as something else again, and a shell still busy
// with its own startup discards typed-ahead input outright (readline and fish both switch the
// terminal to raw mode with TCSAFLUSH, which drops whatever was typed before they were ready) —
// leaving the command echoed on screen, never run, and the launch waiting on a handshake that will
// never arrive. An argv of nothing but a path, a flag and an endpoint has no metacharacters for any
// shell to mangle, and the extension avoids the shell entirely (extension/src/inferiorTerminal.ts).
//
// The handshake is a socket rather than a file so it also carries liveness: the agent's connection
// drops when the adapter exits for any reason, including a crash, so the agent never outlives the
// session that started it and no terminal is left with something sleeping in it.

import * as net from 'net';
import * as os from 'os';
import * as path from 'path';

/** Where the debugged program's stdin/stdout go. */
export type ConsoleKind = 'debugConsole' | 'integratedTerminal' | 'externalTerminal';

export function isTerminalConsole(kind: ConsoleKind | undefined): boolean {
  return kind === 'integratedTerminal' || kind === 'externalTerminal';
}

/** The DAP `runInTerminal` "kind" for each of ours. */
export function runInTerminalKind(kind: ConsoleKind): 'integrated' | 'external' {
  return kind === 'externalTerminal' ? 'external' : 'integrated';
}

/** The flag that turns this adapter binary into the thing that runs inside the terminal. */
export const TERMINAL_AGENT_FLAG = '--terminal-agent';

/** Distinguishes endpoints created within the same millisecond, which a timestamp alone does not —
 * uniqueness here must not depend on how fast the clock happens to tick. */
let endpointCounter = 0;

/**
 * A private address for one session's handshake: a named pipe on Windows, a unix socket elsewhere.
 *
 * Not in the workspace, and not a TCP port: a loopback listener is a second thing on the machine
 * that can be connected to, and on Windows it is also a firewall prompt. Both forms here are
 * reachable only through the filesystem namespace.
 */
export function endpointPath(): string {
  const name = `fasm2-studio-tty-${process.pid}-${Date.now().toString(36)}-${endpointCounter++}`;
  return process.platform === 'win32' ? `\\\\.\\pipe\\${name}` : path.join(os.tmpdir(), `${name}.sock`);
}

/**
 * The command the terminal is asked to run: this adapter's own binary, as the agent.
 *
 * `execPath` is the Node (or Electron-as-Node) binary already running this adapter, so the agent
 * needs no Node on PATH — and `env` carries the one variable that makes an Electron binary behave
 * as Node, since the terminal starts with the user's environment rather than this process's.
 *
 * `ioEndpoint`, only ever set on Windows, is where the agent should host the pipe gdb's debuggee
 * connects its own stdio to — see this file's own top comment. Left off entirely rather than
 * passed as an empty string so a POSIX argv looks exactly as it always has.
 */
export function agentCommand(agentModule: string, endpoint: string, execPath: string = process.execPath, ioEndpoint?: string): string[] {
  const args = [execPath, agentModule, TERMINAL_AGENT_FLAG, endpoint];
  if (ioEndpoint !== undefined) args.push(ioEndpoint);
  return args;
}

/** The file to start the agent from: this adapter's own bundle, which is what argv[1] names in the
 * process the extension spawned. */
export function agentModulePath(): string {
  return process.argv[1];
}

/** The environment the agent has to be started with, on top of whatever the terminal already has. */
export function agentEnv(): Record<string, string> {
  return process.env.ELECTRON_RUN_AS_NODE ? { ELECTRON_RUN_AS_NODE: '1' } : {};
}

/** A tty path the agent reported, or undefined if what arrived is not one. The agent says
 * "not a tty" when the client ran it somewhere without one, which is not a path and not usable. */
export function parseTtyPath(contents: string): string | undefined {
  const line = contents.trim();
  if (!line.startsWith('/dev/')) return undefined;
  return line;
}

/**
 * The adapter's side of the handshake: listens for the agent, learns the tty, and holds the
 * connection open for the rest of the session because that connection is what keeps the agent —
 * and so the terminal — alive.
 */
export class TerminalHandshake {
  private server: net.Server | undefined;
  private connection: net.Socket | undefined;
  private received = '';
  private tty: string | undefined;
  private waiters: Array<(tty: string | undefined) => void> = [];
  private closed = false;
  private reportedLine = false;

  /** Whether the agent actually sent its line, as opposed to `waitForTty` settling on a timeout or
   * an early close. `waitForTty`'s own `undefined` can't tell those apart — it means the same thing
   * for "no tty" (a legitimate report, e.g. Windows, which never has one) as for "nothing arrived
   * at all" — so a Windows caller, which never gets a tty either way, reads this instead. */
  get reported(): boolean {
    return this.reportedLine;
  }

  constructor(readonly endpoint: string) {}

  /** Starts listening. Resolves once the endpoint is actually accepting connections, so a caller
   * can only ask the client to start the agent after there is something for it to connect to. */
  listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = net.createServer((socket) => this.onConnection(socket));
      server.on('error', reject);
      server.listen(this.endpoint, () => {
        this.server = server;
        server.removeListener('error', reject);
        // A later listener error (the socket file being removed underneath us, say) must not take
        // the adapter process down with it — the handshake failing is a fallback, not a crash.
        server.on('error', () => undefined);
        resolve();
      });
    });
  }

  private onConnection(socket: net.Socket): void {
    // One agent per session. A second connection is not something that happens in normal use, and
    // accepting it would mean two terminals both believing they own the program's I/O.
    if (this.connection) {
      socket.destroy();
      return;
    }
    this.connection = socket;
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      if (this.tty) return;
      this.received += chunk;
      const newline = this.received.indexOf('\n');
      if (newline < 0) return;
      this.tty = parseTtyPath(this.received.slice(0, newline));
      this.reportedLine = true;
      this.settle(this.tty);
    });
    // The terminal being closed by the user drops the connection. Nothing to do about the program's
    // I/O at that point, but a launch still waiting on the handshake should stop waiting.
    socket.on('close', () => this.settle(this.tty));
    socket.on('error', () => this.settle(this.tty));
  }

  private settle(tty: string | undefined): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const waiter of waiters) waiter(tty);
  }

  /** Waits for the agent to report its tty. Bounded: a terminal that never starts the agent, or
   * starts one that cannot connect back, must not hang the launch. */
  waitForTty(timeoutMs = 10_000): Promise<string | undefined> {
    if (this.tty) return Promise.resolve(this.tty);
    if (this.closed) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        resolve(undefined);
      }, timeoutMs);
      const waiter = (tty: string | undefined): void => {
        clearTimeout(timer);
        resolve(tty);
      };
      this.waiters.push(waiter);
    });
  }

  /** Ends the session's hold on the terminal. The agent notices the connection closing and stops
   * holding the terminal open on its own, rather than being killed — which for an integrated
   * terminal would close the panel and take the program's output with it. */
  release(): void {
    if (this.closed) return;
    this.closed = true;
    this.settle(this.tty);
    this.connection?.end();
    this.connection = undefined;
    this.server?.close();
    this.server = undefined;
  }
}
