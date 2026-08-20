// Mirrors extension/src/compilerDiscovery.ts. The server is a plain Node process (no vscode API
// access), so it needs its own PATH probe rather than sharing the extension's — but the two must
// resolve to the same answer, hence the identical candidate lists and probing strategy. An empty
// configured path means "auto-detect"; this is what makes that actually work for diagnostics.
//
// Probing is async (spawn, not spawnSync): this runs inside the language server's own single
// process, so a blocking spawnSync here would stall hover/completion/every other in-flight
// request for up to PROBE_TIMEOUT_MS on first use, not just diagnostics.
//
// Detection is based on the tool's own banner text ("flat assembler"), not the process exit
// code — see the longer explanation in extension/src/compilerDiscovery.ts for why exit-code
// guessing is unreliable across shells (it previously misreported a missing compiler as found on
// Windows).

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Dialect } from './types';

const CANDIDATES: Record<Dialect, string[]> = {
  fasm2: ['fasm2', 'fasmg'],
  fasm1: ['fasm1', 'fasm'],
};

const PROBE_TIMEOUT_MS = 3000;
const BANNER_MARKER = 'flat assembler';

// GUI-launched apps (desktop launchers, app menus, some window-manager-driven session setups)
// often don't inherit the PATH additions an interactive shell's rc file adds — most commonly
// ~/.local/bin, a conventional install location for user-installed CLI tools that a bare command
// name lookup won't find in that leaner environment. Checked directly by full path, after the
// plain PATH-based candidates. Windows generally propagates the registry-based user/system PATH
// to GUI apps regardless of how they're launched, so this matters less there — but package-manager
// shim directories (scoop, chocolatey) are common install locations that aren't always on it.
function extraSearchDirs(): string[] {
  const home = os.homedir();
  if (process.platform === 'darwin') return [path.join(home, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin'];
  if (process.platform === 'win32') return [path.join(home, 'scoop', 'shims'), 'C:\\ProgramData\\chocolatey\\bin'];
  return [path.join(home, '.local', 'bin')];
}

function candidatePaths(dialect: Dialect): string[] {
  const names = CANDIDATES[dialect];
  return [...names, ...extraSearchDirs().flatMap((dir) => names.map((name) => path.join(dir, name)))];
}

const cache = new Map<Dialect, string | null>();
const inFlight = new Map<Dialect, Promise<string | undefined>>();

function probe(candidate: string): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (found: boolean) => {
      if (settled) return;
      settled = true;
      resolve(found);
    };

    let child;
    try {
      child = spawn(candidate, [], { shell: true, windowsHide: true });
    } catch {
      finish(false);
      return;
    }

    let output = '';
    const timer = setTimeout(() => {
      child.kill();
      finish(false);
    }, PROBE_TIMEOUT_MS);

    child.stdout?.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
    child.stderr?.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
    child.on('error', () => {
      clearTimeout(timer);
      finish(false);
    });
    child.on('close', () => {
      clearTimeout(timer);
      finish(output.toLowerCase().includes(BANNER_MARKER));
    });
  });
}

async function probeCandidates(dialect: Dialect): Promise<string | undefined> {
  for (const candidate of candidatePaths(dialect)) {
    if (await probe(candidate)) {
      cache.set(dialect, candidate);
      return candidate;
    }
  }
  cache.set(dialect, null);
  return undefined;
}

export function resolveCompilerOnPath(dialect: Dialect): Promise<string | undefined> {
  const cached = cache.get(dialect);
  if (cached !== undefined) return Promise.resolve(cached ?? undefined);

  const existing = inFlight.get(dialect);
  if (existing) return existing;

  const promise = probeCandidates(dialect).finally(() => inFlight.delete(dialect));
  inFlight.set(dialect, promise);
  return promise;
}

export function invalidateCompilerCache(): void {
  cache.clear();
  preloadCache.clear();
  bundledIncludeDirCache.clear();
}

// --- bundled include directory detection -----------------------------------------------------
//
// The official fasm2 distribution ships one zip for every platform, unpacked wherever the user
// puts it: the binary (fasm2.cmd/fasmg.exe on Windows, fasm2/fasmg.x64 elsewhere) sits directly
// beside an `include/` directory holding win64a.inc, fasm2.inc and everything else fasm2 bundles —
// confirmed against a real install, not assumed from documentation. fasm2's own wrapper script
// already relies on exactly this layout (`set include=%~dp0include;...` in fasm2.cmd, the `$DIR`
// equivalent in the POSIX fasm2 script) to find its own includes at *build* time, on both
// platforms, which is why `include 'win64a.inc'` already just works when the extension runs the
// real compiler. Analysis (hover/definition/completion) never shells out to that wrapper, though —
// it walks the include graph itself (workspace.ts) — so without this, the exact same layout the
// build already resolves silently is invisible to the editor unless the user duplicates it by hand
// into fasm2Studio.includePath.

/** Resolves a bare command name to the absolute path a shell would actually run, the way `where`
 * (Windows) or `which` (POSIX) would — needed because a compiler found via plain PATH lookup
 * (candidatePaths above) is often just the bare name "fasm2", which has no directory to derive
 * "beside the binary" from. An already-absolute path (found via extraSearchDirs, or configured by
 * the user) is returned as-is once confirmed to exist. */
export function resolveAbsolutePath(command: string): string | undefined {
  if (path.isAbsolute(command)) return fs.existsSync(command) ? command : undefined;
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter((d) => d.length > 0);
  // PATHEXT is what cmd.exe itself consults to turn a bare "fasm2" into "fasm2.cmd" — mirroring it
  // here (rather than trying every extension) is what keeps this landing on the same file the
  // shell-based probe above actually ran. POSIX has no such notion: an exact name match is the
  // whole of it.
  const exts = process.platform === 'win32' ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';') : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, command + ext);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

const bundledIncludeDirCache = new Map<string, string | undefined>();

/**
 * The `include` directory fasm2 ships beside `compilerPath`, or undefined where there isn't one —
 * `compilerPath` may be a bare command name (resolved via resolveAbsolutePath first), an absolute
 * path the user configured, or one of extraSearchDirs's own absolute candidates.
 *
 * Verified by content, not just by the directory existing: fasm2.inc is the one file this whole
 * extension already treats as fasm2's own signature (it's literally what fasm2Studio.fasm2Preload
 * defaults readers toward), so requiring it here is what stops a same-named but unrelated
 * "include" folder next to some other tool from being handed to the analysis as a search path.
 */
export function detectBundledIncludeDir(compilerPath: string): string | undefined {
  const cached = bundledIncludeDirCache.get(compilerPath);
  if (cached !== undefined) return cached;

  const absolute = resolveAbsolutePath(compilerPath);
  const dir = absolute ? path.join(path.dirname(absolute), 'include') : undefined;
  const result = dir && fs.existsSync(path.join(dir, 'fasm2.inc')) ? dir : undefined;
  bundledIncludeDirCache.set(compilerPath, result);
  return result;
}

// --- x86 preload detection ------------------------------------------------------------------
//
// "fasm2" is not a separate assembler: it is the fasmg binary plus a wrapper script that preloads
// the standard x86 package, and the two ship byte-identical executables. Both print the very same
// banner ("flat assembler  version g.…", "Usage: fasmg source [output]"), so the banner probe
// above cannot tell them apart at all.
//
// The difference is nonetheless drastic in practice. fasmg on its own has no instruction set
// whatsoever, so pointing this extension at a raw `fasmg` binary makes every single x86 line in a
// project fail with "illegal instruction" — up to the -e limit, i.e. a wall of 200 errors, none of
// which name the real cause. Since the distinction is invisible in the banner, it is established
// functionally instead: assemble a one-line source and see whether the tool knows what `nop` is.
//
// This deliberately does not decide anything on its own. It is evidence handed to diagnostics.ts,
// which uses it to explain the failure rather than to silently "fix" it — auto-preloading the x86
// package would corrupt genuine non-x86 fasmg projects, including fasmg's own bundled aarch64 and
// webassembly examples, which are valid programs that must not have x86 forced into them.

const PRELOAD_PROBE_TIMEOUT_MS = 5000;
const preloadCache = new Map<string, boolean>();
const preloadInFlight = new Map<string, Promise<boolean>>();

/** Quotes one argument of a `shell: true` command line. Needed because spawn merely concatenates
 * arguments in shell mode: the system temp directory contains a space on any Windows account whose
 * user name has one ("C:\Users\First Last\AppData\Local\Temp"), which would otherwise split into
 * two bogus arguments and make the probe report a working compiler as preload-less.
 *
 * Exported for diagnostics.ts's execCompiler, which needs the same treatment on Windows and for the
 * same reason (see its own comment). */
export function quoteArg(value: string): string {
  return /[\s"]/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
}

function runPreloadProbe(compilerPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const stem = path.join(os.tmpdir(), `fasm2-studio-preload-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const src = `${stem}.asm`;
    const out = `${stem}.bin`;
    const cleanup = () => {
      fs.promises.unlink(src).catch(() => undefined);
      fs.promises.unlink(out).catch(() => undefined);
    };

    let child;
    try {
      fs.writeFileSync(src, 'nop\n', 'utf8');
      // Passed as one pre-quoted command line rather than an args array: in shell mode Node only
      // concatenates the array without escaping it, which it warns about (DEP0190) precisely
      // because the result is whatever the shell makes of it.
      child = spawn([compilerPath, src, out].map(quoteArg).join(' '), { shell: true, windowsHide: true });
    } catch {
      cleanup();
      // Unable to probe (unwritable temp dir, un-spawnable command). Assume a preload is present:
      // that is the historical behaviour, so a probe failure can never turn into a spurious
      // "your compiler has no instruction set" message on a perfectly working setup.
      resolve(true);
      return;
    }

    let output = '';
    let settled = false;
    const finish = (hasPreload: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      resolve(hasPreload);
    };

    const timer = setTimeout(() => {
      child.kill();
      finish(true);
    }, PRELOAD_PROBE_TIMEOUT_MS);

    child.stdout?.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
    child.stderr?.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
    child.on('error', () => finish(true));
    child.on('close', () => finish(!ILLEGAL_INSTRUCTION_RE.test(output)));
  });
}

/** fasmg's wording when a mnemonic resolves to nothing — the exact symptom of an absent
 * instruction-set package. Shared with diagnostics.ts, which recognizes the same text in a real
 * build's output. */
export const ILLEGAL_INSTRUCTION_RE = /illegal instruction/i;

/**
 * Whether `compilerPath` already has an x86 instruction set loaded (fasm1, or fasmg via the fasm2
 * wrapper) as opposed to being a bare fasmg binary that will reject every x86 mnemonic. Cached per
 * path — the answer is a property of the installed tool, not of any one document.
 */
export function hasX86Preload(compilerPath: string): Promise<boolean> {
  const cached = preloadCache.get(compilerPath);
  if (cached !== undefined) return Promise.resolve(cached);

  const existing = preloadInFlight.get(compilerPath);
  if (existing) return existing;

  const promise = runPreloadProbe(compilerPath)
    .then((result) => {
      preloadCache.set(compilerPath, result);
      return result;
    })
    .finally(() => preloadInFlight.delete(compilerPath));
  preloadInFlight.set(compilerPath, promise);
  return promise;
}
