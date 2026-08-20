// Runs a previously built output binary in the integrated terminal. fasm2 (like fasm1) never
// sets the executable bit on the files it produces, so POSIX platforms need an explicit chmod
// before exec — skipping it would surface a confusing "Permission denied" on every first run.
//
// The program is the terminal's own process (via runner.ts), not a line typed into a shell running
// in one — see runner.ts for why the typed version ran nothing at all on a freshly opened terminal.

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { MESSAGE_PREFIX, stringArraySetting } from './config';

const TERMINAL_NAME = 'FASM';

async function ensureExecutable(outputFsPath: string): Promise<void> {
  if (os.platform() === 'win32') return;
  try {
    await fs.chmod(outputFsPath, 0o755);
  } catch {
    // Output may not exist yet if the build failed; let the run itself surface that.
  }
}

/** The runner bundle (see esbuild.js), resolved from this bundled module's own location so it works
 * wherever the extension is installed — same as taskProvider.ts's bundledListingIncPath. */
function runnerModulePath(): string {
  return path.join(__dirname, 'runner.js');
}

/** The terminal the last run went to, so a new one replaces it rather than stacking up a tab per
 * run. */
let previousTerminal: vscode.Terminal | undefined;

/**
 * A terminal running `argv` in `cwd`, replacing whatever the previous run left behind.
 *
 * Never reused: this terminal has a program in it, not a shell, so there is nothing in it to give a
 * second command to. That is the point — the command reaches the program directly as argv instead of
 * being escaped for, and typed into, whichever shell the user's terminal profile opens (see
 * runner.ts). A terminal's cwd is fixed when it is created anyway, so a run of a different program
 * always needed a new one.
 */
function openRunTerminal(cwd: string, argv: string[]): vscode.Terminal {
  previousTerminal?.dispose();
  // Also anything left named "FASM" by an earlier window state — a stale tab holding a program that
  // is still running would keep writing over the one this run opens.
  for (const terminal of vscode.window.terminals) {
    if (terminal.name === TERMINAL_NAME) terminal.dispose();
  }
  previousTerminal = vscode.window.createTerminal({
    name: TERMINAL_NAME,
    cwd,
    // process.execPath is VS Code's own binary, which runs plain Node when told to — so this needs
    // no Node installed on the user's machine, same as the debug adapter itself.
    shellPath: process.execPath,
    shellArgs: [runnerModulePath(), ...argv],
    // The full environment, not just the one variable that matters here: TerminalOptions.env is
    // documented as being merged into the terminal's environment, but on Windows specifically that
    // merge silently did not happen — a terminal created this way got only ELECTRON_RUN_AS_NODE and
    // nothing else, missing SystemRoot in particular, which is what a Windows process needs to load
    // kernel32 and the rest of its own runtime at all. The failure is total and silent: Code.exe
    // launched that way never gets far enough to run runner.js, so the terminal just sits there
    // empty — no echoed command, no output, nothing, exactly the shape this surfaced as. Spreading
    // process.env here first removes the dependency on that merge happening at all.
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    iconPath: new vscode.ThemeIcon('play'),
    isTransient: true,
  });
  return previousTerminal;
}

/** Closes the run terminal, for when the extension itself is going away. */
export function disposeRunTerminal(): void {
  previousTerminal?.dispose();
  previousTerminal = undefined;
}

/**
 * Runs the built binary, with `cwd` as its working directory.
 *
 * Defaulted to the binary's own directory to match what Debug does (see debugAdapter.ts, which
 * defaults a launch config's "cwd" to the source file's directory). Left to the terminal's default
 * these two disagreed, so a program that opens a relative data file worked under F5 and failed
 * under Run — with nothing on screen to suggest why.
 */
export async function runOutputBinary(outputFsPath: string, cwd = path.dirname(outputFsPath), entryFsPath?: string): Promise<void> {
  // "FASM: Run" deliberately does not build first — it runs whatever was built last. When there is
  // nothing there, sending the command anyway produced a bare shell error ("no such file or
  // directory") against an absolute path the user never typed, which reads as a broken extension
  // rather than "you haven't built this yet". Name the actual situation and offer the fix.
  if (!(await exists(outputFsPath))) {
    const build = 'Build it now';
    const choice = await vscode.window.showWarningMessage(
      `${MESSAGE_PREFIX}nothing built at ${outputFsPath} yet.`,
      build,
      'Cancel',
    );
    if (choice !== build) return;
    // Named explicitly: Run can be invoked on a file that is not the active editor's (from the
    // explorer, or the entry points view), and a bare re-dispatch would build and run whatever
    // happened to be focused instead of the file the user just asked about.
    await vscode.commands.executeCommand('fasm2Studio.buildAndRun', entryFsPath ? vscode.Uri.file(entryFsPath) : undefined);
    return;
  }

  await ensureExecutable(outputFsPath);
  // Focused, unlike the debugged program's terminal: nothing else is going on here, and the program
  // may well be waiting to be typed into — as, at the end, is the runner's own prompt to close.
  openRunTerminal(cwd, [outputFsPath, ...runArgs(outputFsPath)]).show();
}

/**
 * `fasm2Studio.runArgs` — the command line to run the program with.
 *
 * The debugger has taken arguments since launch configurations existed (`"args"` in launch.json),
 * so a program that reads argv could be debugged but not simply *run*, which is the more common of
 * the two. Each element becomes one argv entry, so an argument containing a space — or a glob, or a
 * `;` — reaches the program as written, with no shell in the way to re-split or expand it.
 *
 * An empty element is kept, unlike in fasm2Studio.compilerArgs: an empty string is a perfectly
 * ordinary argv entry for a program to receive, where for the assembler it would only ever be a
 * stray positional.
 */
function runArgs(outputFsPath: string): string[] {
  return stringArraySetting('runArgs', vscode.Uri.file(outputFsPath));
}

async function exists(fsPath: string): Promise<boolean> {
  try {
    await fs.access(fsPath);
    return true;
  } catch {
    return false;
  }
}
