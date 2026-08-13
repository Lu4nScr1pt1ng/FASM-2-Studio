// Locates the MI-speaking debugger that FASM: Debug drives — gdb on Linux/Windows, lldb-mi on
// macOS — so that a missing one is reported before a launch starts, instead of arriving as a raw
// spawn error from inside the debug adapter.
//
// This exists because the assembler and the debugger were held to very different standards. A
// missing assembler gets a status bar warning, a "Find a compiler" quick pick and a walkthrough
// step. A missing debugger got `gdb error: spawn gdb ENOENT` written to the Debug Console — after
// a successful build, in a panel that may not even be focused, with nothing anywhere saying that
// gdb is a separate install this extension deliberately does not bundle.
//
// Presence is what's checked, not identity. compilerDiscovery.ts probes for a banner because
// "fasm2" and "fasmg" are byte-identical executables that differ only in behaviour, so only a
// functional probe can tell them apart. Nothing here has to tell two debuggers apart — and a
// banner check would be actively wrong here, because the "not found" message a shell prints
// ("gdb: command not found") contains the very name that would be searched for, so any probe
// matching on the command name reports a missing debugger as present.

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { fasmConfig } from './config';
import { defaultDebuggerCommand } from './debuggerChoices';

/** How long to wait for a `--version` to come back before giving up on the probe. */
const PROBE_TIMEOUT_MS = 3000;

/**
 * What a launch will actually spawn: the launch config's own `gdbPath`, else the `gdbPath`
 * setting, else the platform default. Kept in one place so the preflight below and the message it
 * shows always name the same binary the adapter is about to try.
 */
export function resolveDebuggerCommand(configured?: string): string {
  const explicit = (configured ?? fasmConfig().get<string>('gdbPath') ?? '').trim();
  return explicit || defaultDebuggerCommand();
}

/** Whether `command` names a location on disk rather than a bare name to be looked up on PATH.
 * Both separators are checked regardless of platform: a Windows user may well have typed a
 * forward-slash path into the setting, and treating that as a bare command name would send it
 * through a PATH lookup that can only fail. */
function looksLikePath(command: string): boolean {
  return path.isAbsolute(command) || command.includes('/') || command.includes(path.sep);
}

/**
 * Whether `command` can actually be run.
 *
 * An explicit path is a filesystem question and is answered as one — no process is spawned just to
 * find out whether a file exists. A bare name is a PATH question, and spawning it without a shell
 * asks precisely that: Node performs the same PATH lookup the adapter's own spawn will, and
 * reports a miss as ENOENT. That is the one unambiguous signal available here, which is why it is
 * the only one treated as "missing": exit codes are not usable (a debugger invoked with an
 * unsupported flag exits non-zero while being perfectly present), and neither is output text.
 */
function probe(command: string): Promise<boolean> {
  if (looksLikePath(command)) {
    return fs.promises.access(command, fs.constants.X_OK).then(
      () => true,
      () => false,
    );
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = (found: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(found);
    };

    let child;
    try {
      child = spawn(command, ['--version'], { windowsHide: true });
    } catch {
      finish(false);
      return;
    }

    // Assume present on a probe that fails to answer in time: a slow filesystem is not evidence of
    // a missing debugger, and a spurious "not installed" modal in front of a working setup is a
    // worse failure than the silence this replaces. Same stance as compilerDiscovery.ts's own
    // preload probe.
    const timer = setTimeout(() => {
      child.kill();
      finish(true);
    }, PROBE_TIMEOUT_MS);

    child.on('error', (err: NodeJS.ErrnoException) => finish(err.code !== 'ENOENT'));
    child.on('close', () => finish(true));
  });
}

const cache = new Map<string, boolean>();
const inFlight = new Map<string, Promise<boolean>>();

/**
 * Whether the debugger at `command` is present, cached per command string for the session.
 *
 * Cached because this runs on the launch path, where it sits between pressing F5 and the program
 * starting — a repeated debug-edit-debug loop should not pay a process spawn every time. Installing
 * a debugger mid-session is what invalidateDebuggerCache below is for, reached from the "Look
 * again" entry in FASM: Select Debugger.
 */
export function debuggerAvailable(command: string): Promise<boolean> {
  const cached = cache.get(command);
  if (cached !== undefined) return Promise.resolve(cached);

  const existing = inFlight.get(command);
  if (existing) return existing;

  const promise = probe(command)
    .then((found) => {
      cache.set(command, found);
      return found;
    })
    .finally(() => inFlight.delete(command));
  inFlight.set(command, promise);
  return promise;
}

export function invalidateDebuggerCache(): void {
  cache.clear();
}
