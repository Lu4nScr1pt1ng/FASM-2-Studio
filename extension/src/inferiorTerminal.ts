// The terminal the debugged program's stdin/stdout live on, opened by the extension rather than by
// asking VS Code to run a command for us.
//
// DAP's runInTerminal — which the adapter still uses for any other client, see debug's
// inferiorTerminal.ts — asks the *client* to run a command vector in a terminal, and VS Code does
// that by opening a terminal running the user's shell and typing the command into it. That is one
// hand-off too many: the command has to be escaped for whichever shell that is, and a shell still
// busy with its own startup discards typed-ahead input outright (both readline and fish put the
// terminal into raw mode with TCSAFLUSH, which throws away anything typed before they were ready).
// The result is a terminal showing an escaped command that was never run, a program that never got
// its tty, and a several-second wait before the session gives up and falls back.
//
// A terminal created with an explicit shellPath runs that program directly — no shell, no quoting,
// no startup race, and identical on every platform and with every terminal profile the user has
// configured. The program started this way is the debug adapter's own agent, which reports the tty
// back to the session over the endpoint named here.

import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

/** Kept in step with the adapter's own flag (debug/src/inferiorTerminal.ts) — the two packages are
 * independent, so this is a copy rather than an import. */
const TERMINAL_AGENT_FLAG = '--terminal-agent';

const TERMINAL_NAME = 'FASM program';

/** Distinguishes endpoints created within the same millisecond. */
let endpointCounter = 0;

/** A private address for one session's tty handshake: a named pipe on Windows, a unix socket
 * elsewhere. Mirrors endpointPath() in debug/src/inferiorTerminal.ts. */
export function inferiorEndpointPath(tmpDir: string = os.tmpdir()): string {
  const name = `fasm2-studio-tty-${process.pid}-${Date.now().toString(36)}-${endpointCounter++}`;
  return process.platform === 'win32' ? `\\\\.\\pipe\\${name}` : path.join(tmpDir, `${name}.sock`);
}

/** The terminal from the previous session, if its agent is still sitting in it waiting to be
 * dismissed. One at a time: a new run replaces it rather than stacking up a tab per launch. */
let previousTerminal: vscode.Terminal | undefined;

/**
 * Opens the program's terminal and returns the endpoint the session should listen on, or undefined
 * where this route does not apply and the adapter's own fallback should handle it: an external
 * terminal (not ours to open), or Windows (no tty for gdb to be pointed at either way — the adapter
 * gives the program its own console there instead).
 */
export function openInferiorTerminal(context: vscode.ExtensionContext, console: string | undefined, cwd: string): string | undefined {
  if (console !== 'integratedTerminal' || process.platform === 'win32') return undefined;

  const endpoint = inferiorEndpointPath();
  const adapterPath = context.asAbsolutePath(path.join('dist', 'adapter.js'));

  previousTerminal?.dispose();
  const terminal = vscode.window.createTerminal({
    name: TERMINAL_NAME,
    cwd,
    // process.execPath is VS Code's own binary, which runs plain Node when told to — so this needs
    // no Node installed on the user's machine, same as the debug adapter itself.
    shellPath: process.execPath,
    shellArgs: [adapterPath, TERMINAL_AGENT_FLAG, endpoint],
    env: { ELECTRON_RUN_AS_NODE: '1' },
    iconPath: new vscode.ThemeIcon('debug-console'),
    isTransient: true,
  });
  // Visible, because the program's output and its prompt for input are both in there — but not
  // focused, because the editor is where stepping through the program happens.
  terminal.show(true);

  previousTerminal = terminal;
  return endpoint;
}

/** Closes the program's terminal, for when the extension itself is going away — a terminal whose
 * agent can never be answered again is just a dead tab. */
export function disposeInferiorTerminal(): void {
  previousTerminal?.dispose();
  previousTerminal = undefined;
}
