// What runs inside the terminal the debugged program gets (see inferiorTerminal.ts for why this is
// a program rather than a shell script).
//
// Its whole job: say which tty this terminal is, then stay alive so the terminal stays open, then
// get out of the way. It deliberately never reads its *own* stdin on POSIX while the session is
// running — the program being debugged is reading that same tty directly, and two readers would
// take turns stealing each other's keystrokes. Windows is different: there's no tty for the
// program to read directly at all, so this process reads its own stdin *for* it and relays every
// byte over a private pipe instead — see listenForInferior below and inferiorTerminal.ts's own
// top comment for why that's the Windows equivalent rather than a second reader of the same thing.

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';

/** How long to keep trying to reach the adapter. The terminal can be opened before the adapter is
 * listening — the extension opens it while resolving the launch configuration — so the first
 * attempts are expected to fail. */
const CONNECT_TIMEOUT_MS = 20_000;
const CONNECT_RETRY_MS = 100;

/**
 * This terminal's tty device path, or undefined where there is no tty (Windows, or a client that
 * ran the agent somewhere without one).
 *
 * `/proc/self/fd/0` answers on Linux without running anything. Elsewhere `tty` is the POSIX-defined
 * way to ask, and it reports on *its own* stdin — which is this terminal's, inherited. No shell is
 * involved in either, so nothing here depends on quoting.
 */
export function currentTty(): string | undefined {
  if (process.platform === 'win32') return undefined;
  try {
    const link = fs.readlinkSync('/proc/self/fd/0');
    if (link.startsWith('/dev/')) return link;
  } catch {
    // No /proc (macOS, BSD) — fall through to tty(1).
  }
  try {
    const reported = execFileSync('tty', [], { stdio: ['inherit', 'pipe', 'ignore'], encoding: 'utf8', timeout: 5000 }).trim();
    return reported.startsWith('/dev/') ? reported : undefined;
  } catch {
    return undefined;
  }
}

/** Connects to the adapter, retrying while it may still be starting up. */
function connect(endpoint: string, deadline: number): Promise<net.Socket | undefined> {
  return new Promise((resolve) => {
    const attempt = (): void => {
      const socket = net.connect(endpoint);
      socket.once('connect', () => resolve(socket));
      socket.once('error', () => {
        socket.destroy();
        if (Date.now() >= deadline) return resolve(undefined);
        setTimeout(attempt, CONNECT_RETRY_MS);
      });
    };
    attempt();
  });
}

/**
 * Hosts the pipe gdb's debuggee connects its own stdin/stdout/stderr to (Windows only — see
 * inferiorTerminal.ts's top comment), relaying it directly to this terminal. Resolves once the
 * pipe is actually listening, which the caller has to wait for: gdb does not retry
 * `-inferior-tty-set`'s target if it isn't there yet when the program starts.
 *
 * A fresh connection arrives per run — once for the initial launch, and again for every Restart,
 * since gdb reopens that target each time it starts a new copy of the program — so each one
 * replaces whichever came before it rather than adding a second reader to a run that has already
 * ended.
 */
function listenForInferior(ioEndpoint: string, out: NodeJS.WritableStream): Promise<{ close: () => void }> {
  return new Promise((resolve, reject) => {
    let current: net.Socket | undefined;
    const server = net.createServer((conn) => {
      if (current) {
        process.stdin.unpipe(current);
        current.destroy();
      }
      current = conn;
      conn.pipe(out);
      // { end: false }: stdin ending (e.g. Ctrl+Z) must not end *this* connection while a later
      // run might still reuse it — the server, not one connection's lifetime, is what owns that.
      process.stdin.pipe(conn, { end: false });
      conn.once('close', () => {
        process.stdin.unpipe(conn);
        if (current === conn) current = undefined;
      });
    });
    server.on('error', reject);
    server.listen(ioEndpoint, () => {
      server.removeListener('error', reject);
      resolve({
        close: () => {
          server.close();
          if (current) {
            process.stdin.unpipe(current);
            current.destroy();
          }
        },
      });
    });
  });
}

/**
 * Runs the agent until the session ends.
 *
 * Ending is the adapter closing the connection, which happens on a clean disconnect and equally on
 * the adapter dying — so the terminal is never left held open by a session that no longer exists.
 * What is left behind on purpose is the program's output: the footer waits for a keypress instead
 * of exiting straight away, because an extension-owned terminal closes when its process exits, and
 * a program that printed its answer and finished deserves better than having the answer disappear.
 *
 * `ioEndpoint`, present only on Windows, is where this agent hosts the pipe the debuggee's own
 * stdio gets pointed at — see listenForInferior.
 */
export async function runTerminalAgent(endpoint: string, ioEndpoint?: string, out: NodeJS.WritableStream = process.stdout): Promise<number> {
  const socket = await connect(endpoint, Date.now() + CONNECT_TIMEOUT_MS);
  if (!socket) {
    out.write('This terminal could not reach the FASM debug session, so the program is not using it.\n');
    return 1;
  }

  // Has to be listening *before* the handshake line below is sent — see listenForInferior's own
  // doc comment for why the adapter treats that line as "the pipe is ready", not just "hello".
  const ioServer = ioEndpoint !== undefined ? await listenForInferior(ioEndpoint, out) : undefined;

  socket.write(`${currentTty() ?? 'not a tty'}\n`);
  out.write('\x1b[2mFASM program — its input and output are here.\x1b[0m\n');

  await new Promise<void>((resolve) => {
    socket.once('close', () => resolve());
    socket.once('error', () => resolve());
  });
  ioServer?.close();

  out.write('\n\x1b[2m[the debug session ended — press Enter to close this terminal]\x1b[0m\n');
  // Safe to read our own stdin now, and only now: on POSIX the program that was reading this tty
  // directly is gone, and on Windows the pipe relaying our stdin to it has just been closed above.
  await new Promise<void>((resolve) => {
    process.stdin.on('data', () => resolve());
    process.stdin.on('end', () => resolve());
    process.stdin.resume();
  });
  return 0;
}
