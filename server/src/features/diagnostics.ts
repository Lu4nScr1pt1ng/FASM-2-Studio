// Drives the real fasm1/fasm2 compiler as the source of truth for diagnostics rather than
// hand-rolling a semantic checker: it is always exactly as correct as the assembler itself.
// The invocation is defensive by construction: bounded run time (SIGKILL on timeout), bounded
// output buffering, and a guaranteed temp-file cleanup, so a hung or runaway compiler process can
// never wedge the language server or leak disk/OS resources.

import { spawn } from 'child_process';
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
const MESSAGE_RE = /^(Error|Warning):\s*(.*)$/;
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_REPORTED_ERRORS = 200;

export interface RunCompilerOptions {
  compilerPath: string;
  sourceFsPath: string;
  cwd: string;
  timeoutMs?: number;
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

    return { diagnostics: parseDiagnostics(stdout, opts.sourceFsPath) };
  } finally {
    fs.promises.unlink(tmpOut).catch(() => undefined);
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
      child = spawn(command, args, { cwd, windowsHide: true });
    } catch (err) {
      resolve({ stdout: '', timedOut: false, spawnError: (err as Error).message });
      return;
    }

    let out = '';
    let settled = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    const finish = (result: { stdout: string; timedOut: boolean; spawnError?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

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
          severity: message[1] === 'Error' ? DiagnosticSeverity.Error : DiagnosticSeverity.Warning,
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
