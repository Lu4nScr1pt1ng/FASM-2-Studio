// Giving the debugged program a terminal of its own.
//
// By default the program's output arrives as DAP output events and lands in the Debug Console,
// which is fine for a program that only prints — and useless for one that reads. The Debug Console
// has no stdin to offer, so a program blocked in a `read` syscall just sits there with nothing
// explaining why, and "read a number, print it back" is most of what people write while learning
// assembly.
//
// The fix is the one every real debugger uses: run the program on a terminal, and tell gdb about
// it. DAP's runInTerminal request asks the *client* to open a terminal (VS Code's integrated one,
// or an external window) and run a command in it; that command reports which tty it landed on, and
// gdb's `-inferior-tty-set` points the inferior's stdin/stdout/stderr at that same tty. From then
// on the program talks to the terminal directly and this adapter is not in the middle of it at all.
//
// The holder process stays alive so the terminal keeps its pty open, and exits on its own when the
// adapter deletes the handshake file at the end of the session — rather than being killed, which
// for an integrated terminal would close the panel and take the program's output with it.

import * as fs from 'fs';
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

/** Distinguishes handshakes started within the same millisecond, which a timestamp alone does not —
 * uniqueness here must not depend on how fast the clock happens to tick. */
let handshakeCounter = 0;

/** A private path for one session's tty handshake. Not in the workspace: this is adapter
 * bookkeeping, and a stray file appearing next to someone's source would be a bug report. */
export function handshakeFilePath(): string {
  return path.join(os.tmpdir(), `fasm2-studio-tty-${process.pid}-${Date.now().toString(36)}-${handshakeCounter++}`);
}

/** How long the holder keeps a terminal alive after the handshake file disappears, at the outside —
 * a session that crashes hard never gets to delete the file, and an `sh` sleeping until the machine
 * is rebooted would be a poor way to find that out. */
const HOLDER_MAX_SECONDS = 12 * 60 * 60;

/**
 * The command the client is asked to run in the terminal: report this terminal's tty, then hold
 * the terminal open until the session is over.
 *
 * `tty` names the terminal attached to stdin, which in a client-opened terminal is the pty we are
 * after. The wait loop is a poll on the handshake file rather than anything cleverer because this
 * has to be portable /bin/sh — no bashisms, no coreutils beyond `tty` and `sleep`.
 */
export function holderCommand(handshakeFile: string): string[] {
  const quoted = `'${handshakeFile.replace(/'/g, `'\\''`)}'`;
  const script = [
    `tty > ${quoted}`,
    'i=0',
    `while [ -e ${quoted} ] && [ $i -lt ${HOLDER_MAX_SECONDS} ]; do sleep 1; i=$((i+1)); done`,
  ].join('; ');
  return ['/bin/sh', '-c', script];
}

/** A tty path the holder wrote, or undefined if it never got that far. `tty` prints "not a tty"
 * when the client ran the command somewhere without one, which is not a path and not usable. */
export function parseTtyPath(contents: string): string | undefined {
  const line = contents.trim();
  if (!line.startsWith('/dev/')) return undefined;
  return line;
}

/** Waits for the holder to report its tty. Polled because the handshake is a file the client's
 * terminal writes on its own schedule — there is no event to wait on. */
export async function waitForTty(handshakeFile: string, timeoutMs = 5000, pollMs = 50): Promise<string | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const tty = parseTtyPath(fs.readFileSync(handshakeFile, 'utf8'));
      if (tty) return tty;
    } catch {
      // Not written yet — the terminal may still be starting up.
    }
    if (Date.now() >= deadline) return undefined;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

/** Ends the holder's wait loop, which closes out the terminal without closing the terminal panel
 * the program's output is still sitting in. */
export function releaseTerminal(handshakeFile: string | undefined): void {
  if (!handshakeFile) return;
  try {
    fs.unlinkSync(handshakeFile);
  } catch {
    // Already gone (the holder never started, or the session is being torn down twice).
  }
}
