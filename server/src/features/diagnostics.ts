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
import { hasX86Preload, ILLEGAL_INSTRUCTION_RE } from '../compilerDiscovery';
import { Dialect } from '../types';

export interface CompileResult {
  diagnostics: Diagnostic[];
  /**
   * Errors belonging to *other* files of the same project, keyed by their absolute real path.
   *
   * fasm projects are include trees, so the file holding the mistake is very often not the file
   * being edited. Reporting these only as a status-bar sentence left the actual broken line
   * unmarked in a file the user could open — so they are handed back as ordinary diagnostics for
   * the caller to publish against those files' own URIs.
   */
  foreignDiagnostics?: Map<string, Diagnostic[]>;
  /** Set when the compiler could not be run at all (missing binary, spawn failure, timeout). */
  toolError?: string;
}

const HEADER_RE = /^(.+) \[(\d+)\]:$/;
/**
 * A header with no trailing colon, which fasmg emits when it has no source line to quote beneath
 * it — as with the "Custom error: NO OUTPUT FILE." raised past the end of the file. Requiring the
 * colon dropped those errors entirely, leaving a failing build looking clean.
 *
 * Deliberately allows only a single "file [line]" pair: the macro call-stack trace fasmg prints
 * between a header and its message ("movzx? [30] x86.store_instruction@src [77]
 * x86.require.bits64? [6]") also ends in "[number]", and treating that as a header replaced the
 * real one and discarded the diagnostic. Excluding brackets from the file part is what separates
 * them, since a trace always has earlier bracketed groups.
 */
const BARE_HEADER_RE = /^([^[\]]+) \[(\d+)\]$/;
// fasmg emits "Error: ..." for built-in assembler errors and "Custom error: ..." for errors
// raised by an `err` instruction — which is how virtually all of fasmg's own instruction-encoding
// validation (wrong operand size, illegal addressing mode, ...) reports problems, so missing this
// prefix would silently drop most everyday mistakes. fasmg has no warning concept; "Warning: " is
// fasm1's.
// Case-insensitive because the two assemblers disagree on capitalization: fasmg writes
// "Error: ...", fasm1 writes "error: ..." (verified against flat assembler 1.73.32). Matching only
// the capitalized form meant every fasm1 error was parsed as zero diagnostics.
const MESSAGE_RE = /^(Error|Custom error|Warning):\s*(.*)$/i;
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
  /** fasm2Studio.includePath, forwarded as the compiler's INCLUDE environment variable — a
   * semicolon-separated list of extra directories to search for a bare `include 'foo.inc'` that
   * isn't found next to the including file (fasmg's own official examples rely on exactly this,
   * e.g. packages/x86/examples/windows/make.bat does `set include=..\..\include` before building;
   * without it, every `include` reaching outside its own directory fails with "source file not
   * found" even though the project is entirely correct). Left unset, the compiler only gets
   * whatever INCLUDE (if any) this extension's own host process already inherited. */
  includePath?: string;
  /** fasm2Studio.fasm2Preload — an include file to load before the source itself, passed via
   * fasmg's own `-i` (assemble this line first) flag. Lets a raw `fasmg` binary be used where a
   * fasm2 one is expected, by supplying the very preload the fasm2 wrapper script hardcodes.
   * Never set implicitly: see the comment on preloadMissingError. */
  preload?: string;
  /** Which assembler `compilerPath` is. The two take genuinely different command lines — fasm1
   * rejects every flag fasmg takes — so getting this wrong silently disables diagnostics. Defaults
   * to fasm2, the dialect this extension is primarily built around. */
  dialect?: Dialect;
  /** Translates a path the compiler printed back to the real project file it stands for, for
   * callers that compile a positional copy rather than the project itself (see liveShadow.ts).
   * Returning undefined means "not one of mine", and the path is used as-is. */
  toRealPath?: (fsPath: string) => string | undefined;
  /** Directories (absolute paths) whose files may carry diagnostics of their own — the open
   * workspace folders. Errors located outside them are summarized rather than marked up; see
   * placeForeignErrors. Leave unset to accept any file that exists. */
  workspaceFolders?: readonly string[];
}

/**
 * The advice shown when the compiler turns out to have no instruction set at all. Kept as one
 * message instead of up to 200 per-line "illegal instruction" errors, none of which name the real
 * cause: with a bare fasmg every mnemonic in the file is rejected, so the error list is pure noise
 * that buries the single fact the user needs.
 *
 * The fix is deliberately offered rather than applied. Preloading x86 automatically would be wrong
 * for a genuine fasmg project — fasmg's own bundled aarch64 and webassembly examples are valid
 * programs for other targets, and forcing x86 into them would break code that is entirely correct.
 */
export const PRELOAD_MISSING_MESSAGE =
  'The configured compiler is a bare fasmg binary, which has no instruction set of its own: every ' +
  'x86 mnemonic in this file is rejected as an illegal instruction. Point ' +
  'fasm2Studio.fasm2CompilerPath at the "fasm2" wrapper script instead (it preloads the x86 ' +
  'package), or set fasm2Studio.fasm2Preload to an include that defines your instruction set ' +
  '(e.g. "fasm2.inc", with fasm2Studio.includePath pointing at the directory holding it).';

/**
 * Fewest "illegal instruction" errors that can indicate a missing instruction set rather than
 * ordinary mistakes. A compiler with no instruction set rejects every mnemonic in the file, so even
 * a hello-world clears this easily; requiring more than a couple keeps an isolated typo in a
 * genuine foreign-ISA project (whose compiler legitimately has no x86 preload) from being blamed
 * on the toolchain.
 */
const MIN_MISSING_INSTRUCTION_SET_ERRORS = 3;

/**
 * Whether enough errors are "illegal instruction" to suggest the compiler recognizes no mnemonics
 * at all. Counts them rather than requiring every error to be one: a bare fasmg is missing its
 * format packages too, so a real x86 program also draws "invalid argument" from `format`/`segment`
 * lines, and demanding uniformity missed the very case this exists to catch.
 */
function looksLikeMissingInstructionSet(diagnostics: Diagnostic[]): boolean {
  const illegal = diagnostics.filter((d) => typeof d.message === 'string' && ILLEGAL_INSTRUCTION_RE.test(d.message));
  return illegal.length >= MIN_MISSING_INSTRUCTION_SET_ERRORS;
}

export async function runDiagnostics(opts: RunCompilerOptions): Promise<CompileResult> {
  const tmpOut = path.join(os.tmpdir(), `fasm2-studio-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.out`);

  try {
    // fasm1 accepts none of these: its whole option set is -m/-p/-d/-s (flat assembler 1.73.32),
    // so passing fasmg's flags to it makes it print its usage banner and exit without ever
    // assembling anything — which parsed as zero diagnostics, silently disabling error reporting
    // for every fasm1 file. It also stops at the first error on its own, so it needs no -e.
    const fasm2OnlyArgs =
      (opts.dialect ?? 'fasm2') === 'fasm1'
        ? []
        : ['-e', String(MAX_REPORTED_ERRORS), ...(opts.preload ? ['-i', `include '${opts.preload}'`] : [])];
    const { stdout, timedOut, spawnError } = await execCompiler(
      opts.compilerPath,
      [opts.sourceFsPath, tmpOut, ...fasm2OnlyArgs],
      opts.cwd,
      opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      opts.includePath,
    );

    if (spawnError) {
      return { diagnostics: [], toolError: spawnError };
    }
    if (timedOut) {
      return { diagnostics: [], toolError: 'Compiler timed out' };
    }

    const { diagnostics, foreignErrors } = parseOutput(stdout, opts.reportForFsPath ?? opts.sourceFsPath);
    // Two independent signals must agree before blaming the compiler. The flood on its own is
    // ambiguous — a foreign-ISA project assembled with the right compiler produces the identical
    // symptom if its own mnemonics are misspelled — so it only decides anything once the compiler
    // is separately confirmed to have no instruction set. The probe runs only here, on an already
    // failing build, and is cached per compiler path.
    if (looksLikeMissingInstructionSet(diagnostics) && !(await hasX86Preload(opts.compilerPath))) {
      return { diagnostics: [], toolError: PRELOAD_MISSING_MESSAGE };
    }
    // The build failed somewhere else entirely — typically a bad `include`, which stops the
    // assembler before it ever reaches a line belonging to this document. Reporting nothing here
    // would show a clean file for a project that does not build, with no hint of why; validating
    // against real projects, this was every single case where the compiler and the editor
    // disagreed (a missing include in kbdasm, in bitRAKE's playground, in microcaml).
    //
    // Whichever of those errors can be pinned to a file that exists on disk becomes a real
    // diagnostic on that file, so the broken line is marked where it actually is. The rest — a
    // path that resolves to nothing, which is exactly what a *missing* include reports — have
    // nowhere to be shown, and still need the summary below to avoid vanishing.
    const { foreignDiagnostics, unplaceable } = placeForeignErrors(foreignErrors, opts);
    if (diagnostics.length === 0 && unplaceable.length > 0) {
      const first = unplaceable[0];
      const more = unplaceable.length > 1 ? ` (+${unplaceable.length - 1} more)` : '';
      return {
        diagnostics: [],
        foreignDiagnostics,
        toolError: `Build failed in ${path.basename(first.file)} line ${first.line}: ${first.message}${more}`,
      };
    }
    return { diagnostics, foreignDiagnostics };
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
  includePath?: string,
): Promise<{ stdout: string; timedOut: boolean; spawnError?: string }> {
  return new Promise((resolve) => {
    let child;
    // Spread process.env rather than omitting `env` entirely: an explicit env object replaces
    // the inherited environment wholesale, which would drop PATH and everything else the
    // compiler needs, not just add INCLUDE to what's already there.
    const env = includePath ? { ...process.env, INCLUDE: includePath } : process.env;
    try {
      child = spawn(command, args, { cwd, env, windowsHide: true, detached: process.platform !== 'win32' });
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
  return parseOutput(output, sourceFsPath).diagnostics;
}

/** An error the compiler reported against some other file in the build — most often an `include`
 * that this document pulls in. */
export interface ForeignError {
  file: string;
  /** 1-based, as the compiler prints it. */
  line: number;
  message: string;
}

interface ParsedOutput {
  diagnostics: Diagnostic[];
  foreignErrors: ForeignError[];
}

function parseOutput(output: string, sourceFsPath: string): ParsedOutput {
  const diagnostics: Diagnostic[] = [];
  const foreignErrors: ForeignError[] = [];
  const lines = output.split(/\r\n|\r|\n/);
  const sourceBase = path.basename(sourceFsPath);

  let pendingLine: number | undefined;
  let pendingFile = '';
  let pendingIsCurrentFile = false;

  for (const line of lines) {
    const header = HEADER_RE.exec(line) ?? BARE_HEADER_RE.exec(line);
    if (header) {
      // A header can name a whole include chain ("prog.asm [18] support/win64.inc [14]:"); the
      // location that matters is the innermost one, which is the last file/line pair on the line.
      const chain = [...header[0].matchAll(/(\S(?:[^[]*\S)?) \[(\d+)\]/g)];
      const innermost = chain[chain.length - 1];
      pendingFile = innermost ? innermost[1].trim() : header[1].trim();
      pendingLine = parseInt(innermost ? innermost[2] : header[2], 10) - 1; // fasm reports 1-based lines
      pendingIsCurrentFile = pendingFile === sourceFsPath || path.basename(pendingFile) === sourceBase;
      continue;
    }

    const message = MESSAGE_RE.exec(line);
    if (message && pendingLine !== undefined) {
      if (pendingIsCurrentFile) {
        const lineNo = Math.max(0, pendingLine);
        diagnostics.push({
          severity: message[1].toLowerCase() === 'warning' ? DiagnosticSeverity.Warning : DiagnosticSeverity.Error,
          range: { start: { line: lineNo, character: 0 }, end: { line: lineNo, character: Number.MAX_SAFE_INTEGER } },
          message: message[2],
          source: 'fasm',
        });
      } else if (message[1].toLowerCase() !== 'warning') {
        foreignErrors.push({ file: pendingFile, line: pendingLine + 1, message: message[2] });
      }
      pendingLine = undefined;
    }
  }

  return { diagnostics, foreignErrors };
}

/**
 * Splits the errors that belong to other files into ones that can be shown where they happened and
 * ones that cannot.
 *
 * A file must both exist and belong to the workspace to be marked up. Existence rules out a path
 * the compiler only tried to open. The workspace check rules out the assembler's own library, which
 * a single mistake reaches surprisingly easily: a missing `include` leaves a package macro holding
 * an impossible value, and fasmg reports that consequence against a line of
 * `<fasm2>/include/format/elfexe.inc` — a file the user did not write, cannot fix, and would not
 * expect to see turn red. Both kinds fall through to the summary message instead of disappearing.
 */
function placeForeignErrors(
  foreignErrors: readonly ForeignError[],
  opts: RunCompilerOptions,
): { foreignDiagnostics: Map<string, Diagnostic[]> | undefined; unplaceable: ForeignError[] } {
  const foreignDiagnostics = new Map<string, Diagnostic[]>();
  const unplaceable: ForeignError[] = [];

  for (const error of foreignErrors) {
    const fsPath = resolveReportedPath(error.file, opts);
    if (!fsPath) {
      unplaceable.push(error);
      continue;
    }
    const lineNo = Math.max(0, error.line - 1); // ForeignError.line is 1-based, LSP lines are not
    const forFile = foreignDiagnostics.get(fsPath) ?? [];
    forFile.push({
      severity: DiagnosticSeverity.Error,
      range: { start: { line: lineNo, character: 0 }, end: { line: lineNo, character: Number.MAX_SAFE_INTEGER } },
      message: error.message,
      source: 'fasm',
    });
    foreignDiagnostics.set(fsPath, forFile);
  }

  return { foreignDiagnostics: foreignDiagnostics.size > 0 ? foreignDiagnostics : undefined, unplaceable };
}

/** A path as the compiler printed it — relative to the directory it ran in, and naming the compile
 * tree rather than the project when those differ — resolved to a real workspace file, or undefined
 * if it doesn't name one. */
function resolveReportedPath(rawPath: string, opts: RunCompilerOptions): string | undefined {
  const absolute = path.isAbsolute(rawPath) ? rawPath : path.resolve(opts.cwd, rawPath);
  const real = opts.toRealPath?.(absolute) ?? absolute;
  if (opts.workspaceFolders?.length && !opts.workspaceFolders.some((folder) => isInside(folder, real))) {
    return undefined;
  }
  try {
    return fs.statSync(real).isFile() ? real : undefined;
  } catch {
    return undefined;
  }
}

function isInside(folder: string, fsPath: string): boolean {
  const rel = path.relative(folder, fsPath);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}
