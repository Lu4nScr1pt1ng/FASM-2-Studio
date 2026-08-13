// What runs inside the terminal the debugged program gets (see inferiorTerminal.ts for why this is
// a program rather than a shell script).
//
// Its whole job: say which tty this terminal is, then stay alive so the terminal stays open, then
// get out of the way. It deliberately never reads stdin while the session is running — the program
// being debugged is reading that same tty, and two readers would take turns stealing each other's
// keystrokes.

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
 * Runs the agent until the session ends.
 *
 * Ending is the adapter closing the connection, which happens on a clean disconnect and equally on
 * the adapter dying — so the terminal is never left held open by a session that no longer exists.
 * What is left behind on purpose is the program's output: the footer waits for a keypress instead
 * of exiting straight away, because an extension-owned terminal closes when its process exits, and
 * a program that printed its answer and finished deserves better than having the answer disappear.
 */
export async function runTerminalAgent(endpoint: string, out: NodeJS.WritableStream = process.stdout): Promise<number> {
  const socket = await connect(endpoint, Date.now() + CONNECT_TIMEOUT_MS);
  if (!socket) {
    out.write('This terminal could not reach the FASM debug session, so the program is not using it.\n');
    return 1;
  }

  socket.write(`${currentTty() ?? 'not a tty'}\n`);
  out.write('\x1b[2mFASM program — its input and output are here.\x1b[0m\n');

  await new Promise<void>((resolve) => {
    socket.once('close', () => resolve());
    socket.once('error', () => resolve());
  });

  out.write('\n\x1b[2m[the debug session ended — press Enter to close this terminal]\x1b[0m\n');
  // Safe to read stdin now, and only now: the program that was sharing this tty is gone.
  await new Promise<void>((resolve) => {
    process.stdin.on('data', () => resolve());
    process.stdin.on('end', () => resolve());
    process.stdin.resume();
  });
  return 0;
}
