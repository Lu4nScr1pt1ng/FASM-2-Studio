// Locates the fasm2/fasmg and fasm1 compiler executables. Explicit settings always win; failing
// that, a short, platform-appropriate candidate list is probed once per session and cached, so
// normal operation (build, diagnostics) never pays a process-spawn cost just to find the tool.
// Probing always goes through a shell (spawn's `shell: true`) because on Windows the official
// fasm2 distribution ships a `fasm2.cmd` wrapper, which Node cannot exec directly without one.
//
// Probing is async (spawn, not spawnSync): the extension host is a single process shared by
// every installed extension, and a blocking spawnSync here would stall all of them — not just
// this one — for up to PROBE_TIMEOUT_MS on first use.
//
// Detection is based on the tool's own banner text ("flat assembler", printed by every fasm1/
// fasm2 variant with no arguments), not the process exit code: a missing command is reported
// differently per shell (bash: exit 127; cmd.exe: exit 1 with its own "not recognized" message),
// and guessing at exit codes previously caused this to report a nonexistent compiler as found on
// Windows whenever the real exit code didn't happen to be 127.

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { fasmConfig } from './config';
import { quoteForShell } from './shellQuote';
import { COMPILER_PATH_SETTING, Dialect } from './types';

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

export interface CompilerResolution {
  path: string;
  /** True when found via PATH probing rather than an explicit user setting. */
  autoDetected: boolean;
}

const cache = new Map<Dialect, CompilerResolution | null>();
const inFlight = new Map<Dialect, Promise<CompilerResolution | undefined>>();

function configuredPath(dialect: Dialect, resource?: vscode.Uri): string {
  return (fasmConfig(resource).get<string>(COMPILER_PATH_SETTING[dialect]) ?? '').trim();
}

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

async function probeCandidates(dialect: Dialect): Promise<CompilerResolution | undefined> {
  for (const candidate of candidatePaths(dialect)) {
    if (await probe(candidate)) {
      const resolution: CompilerResolution = { path: candidate, autoDetected: true };
      cache.set(dialect, resolution);
      return resolution;
    }
  }
  cache.set(dialect, null);
  return undefined;
}

/**
 * `resource` scopes the *configured path* lookup to that file's own workspace folder (the setting
 * is `machine-overridable`, so a folder may legitimately override it). The auto-detection fallback
 * below is deliberately not scoped: probing PATH is a property of the machine, identical for every
 * folder, so its cache stays keyed by dialect alone.
 */
export async function resolveCompiler(dialect: Dialect, resource?: vscode.Uri): Promise<CompilerResolution | undefined> {
  const explicit = configuredPath(dialect, resource);
  if (explicit) return { path: explicit, autoDetected: false };

  const cached = cache.get(dialect);
  if (cached !== undefined) return cached ?? undefined;

  // Concurrent callers (e.g. the status bar refreshing while a task is being built) share one
  // in-flight probe instead of each kicking off their own redundant process spawns.
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
// Mirrors server/src/compilerDiscovery.ts's probe of the same name — see the long explanation
// there. In short: "fasm2" is the fasmg binary plus a wrapper that preloads the x86 package, the
// two executables are byte-identical, and they print the same banner, so only a functional probe
// can tell a preload-equipped tool from a bare fasmg that will reject every x86 mnemonic.

const PRELOAD_PROBE_TIMEOUT_MS = 5000;
const preloadCache = new Map<string, boolean>();
const preloadInFlight = new Map<string, Promise<boolean>>();

const ILLEGAL_INSTRUCTION_RE = /illegal instruction/i;

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
      child = spawn([compilerPath, src, out].map(quoteForShell).join(' '), { shell: true, windowsHide: true });
    } catch {
      cleanup();
      // Assume a preload is present when the probe itself can't run, so a probe failure never
      // becomes a spurious warning on a working setup.
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

/** Whether `compilerPath` already has an x86 instruction set loaded (fasm1, or fasmg via the
 * fasm2 wrapper) rather than being a bare fasmg that rejects every x86 mnemonic. Cached per path. */
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
