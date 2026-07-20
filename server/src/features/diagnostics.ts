// Drives the real fasm1/fasm2 compiler as the source of truth for diagnostics rather than
// hand-rolling a semantic checker: it is always exactly as correct as the assembler itself.
// The invocation is defensive by construction: bounded run time (SIGKILL on timeout), bounded
// output buffering, and a guaranteed temp-file cleanup, so a hung or runaway compiler process can
// never wedge the language server or leak disk/OS resources.

import { execFile, spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Diagnostic, DiagnosticSeverity } from 'vscode-languageserver/node';

export interface CompileResult {
  diagnostics: Diagnostic[];
  /** Set when the compiler could not be run at all (missing binary, spawn failure, timeout). */
  toolError?: string;
}

const HEADER_RE = /^(.+) \[(\d+)\]:$/;
// fasmg emits "Error: ..." for built-in assembler errors and "Custom error: ..." for errors
// raised by an `err` instruction — which is how virtually all of fasmg's own instruction-encoding
// validation (wrong operand size, illegal addressing mode, ...) reports problems, so missing this
// prefix would silently drop most everyday mistakes. fasmg has no warning concept; "Warning: " is
// fasm1's.
const MESSAGE_RE = /^(Error|Custom error|Warning):\s*(.*)$/;
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_REPORTED_ERRORS = 200;

export interface RunCompilerOptions {
  compilerPath: string;
  /** The file actually handed to the compiler — the project's entry point when `sourceFsPath`
   * is a fragment included by it, or `sourceFsPath` itself otherwise. */
  sourceFsPath: string;
  cwd: string;
  timeoutMs?: number;
  /** The file diagnostics should be reported for, if different from `sourceFsPath` (compiling an
   * entry point on behalf of a fragment file it includes). Defaults to `sourceFsPath`. */
  reportForFsPath?: string;
}

export async function runDiagnostics(opts: RunCompilerOptions): Promise<CompileResult> {
  const tmpOut = path.join(os.tmpdir(), `fasm2-studio-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.out`);

  try {
    const { stdout, timedOut, spawnError } = await execCompiler(
      opts.compilerPath,
      [opts.sourceFsPath, tmpOut, '-e', String(MAX_REPORTED_ERRORS)],
      opts.cwd,
      opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );

    if (spawnError) {
      return { diagnostics: [], toolError: spawnError };
    }
    if (timedOut) {
      return { diagnostics: [], toolError: 'Compiler timed out' };
    }

    return { diagnostics: parseDiagnostics(stdout, opts.reportForFsPath ?? opts.sourceFsPath) };
  } finally {
    fs.promises.unlink(tmpOut).catch(() => undefined);
  }
}

const KILL_GRACE_PERIOD_MS = 2000;

/**
 * Kills `child` and anything it spawned, not just the single direct process. This matters
 * because fasm2's own official distribution wraps the real binary in a shell script that invokes
 * it as a plain (not `exec`'d) subprocess — so on a hang, killing only the wrapper leaves the
 * real compiler process orphaned and still holding the stdout pipe open, and `close` never fires.
 * On POSIX this is a process-group kill (spawned detached, killed via the negated pid); on
 * Windows, `taskkill /T` walks the process tree since there's no equivalent process-group signal.
 */
function killProcessTree(child: ReturnType<typeof spawn>): void {
  if (process.platform === 'win32') {
    if (child.pid) execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => undefined);
    return;
  }
  try {
    if (child.pid) process.kill(-child.pid, 'SIGKILL');
  } catch {
    // The process group may already be empty/gone; fall back to just the direct child.
    child.kill('SIGKILL');
  }
}

function execCompiler(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<{ stdout: string; timedOut: boolean; spawnError?: string }> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { cwd, windowsHide: true, detached: process.platform !== 'win32' });
    } catch (err) {
      resolve({ stdout: '', timedOut: false, spawnError: (err as Error).message });
      return;
    }

    let out = '';
    let settled = false;
    let timedOut = false;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;

    const finish = (result: { stdout: string; timedOut: boolean; spawnError?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(graceTimer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child);
      // A process-tree kill is not a hard guarantee in every edge case (e.g. a grandchild that
      // detached itself from the group) — give up after a short grace period regardless, so a
      // hung compiler can never wedge the diagnostics pipeline indefinitely either way.
      graceTimer = setTimeout(() => finish({ stdout: out, timedOut: true }), KILL_GRACE_PERIOD_MS);
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      if (out.length < MAX_OUTPUT_BYTES) out += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (out.length < MAX_OUTPUT_BYTES) out += chunk.toString('utf8');
    });
    child.on('error', (err) => finish({ stdout: out, timedOut: false, spawnError: err.message }));
    child.on('close', () => finish({ stdout: out, timedOut }));
  });
}

/**
 * Parses fasmg/fasm1 error output of the form:
 *   <file> [<line>]:
 *       <source snippet>
 *   <macro call-stack trace, optional>
 *   Error: <message>
 * Multiple such blocks can appear back-to-back (one per reported error, up to -e's limit).
 * Only blocks whose file matches the source being diagnosed are reported for that document
 * (an error surfaced from a distinct include file is out of scope for this document's diagnostics).
 */
export function parseDiagnostics(output: string, sourceFsPath: string): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const lines = output.split(/\r\n|\r|\n/);
  const sourceBase = path.basename(sourceFsPath);

  let pendingLine: number | undefined;
  let pendingIsCurrentFile = false;

  for (const line of lines) {
    const header = HEADER_RE.exec(line);
    if (header) {
      const file = header[1].trim();
      pendingLine = parseInt(header[2], 10) - 1; // fasm reports 1-based lines
      pendingIsCurrentFile = file === sourceFsPath || path.basename(file) === sourceBase;
      continue;
    }

    const message = MESSAGE_RE.exec(line);
    if (message && pendingLine !== undefined) {
      if (pendingIsCurrentFile) {
        const lineNo = Math.max(0, pendingLine);
        diagnostics.push({
          severity: message[1] === 'Warning' ? DiagnosticSeverity.Warning : DiagnosticSeverity.Error,
          range: { start: { line: lineNo, character: 0 }, end: { line: lineNo, character: Number.MAX_SAFE_INTEGER } },
          message: message[2],
          source: 'fasm',
        });
      }
      pendingLine = undefined;
    }
  }

  return diagnostics;
}
