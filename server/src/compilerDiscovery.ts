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
 * two bogus arguments and make the probe report a working compiler as preload-less. */
function quoteArg(value: string): string {
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
