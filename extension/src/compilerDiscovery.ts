// Locates the fasm2/fasmg and fasm1 compiler executables. Explicit settings always win; failing
// that, a short, platform-appropriate candidate list is probed once per session and cached, so
// normal operation (build, diagnostics) never pays a process-spawn cost just to find the tool.
// Probing always goes through a shell (spawn's `shell: true`) because on Windows the official
// fasm2 distribution ships a `fasm2.cmd` wrapper, which Node cannot exec directly without one.

import { spawnSync } from 'child_process';
import * as vscode from 'vscode';
import { Dialect } from './types';

const CANDIDATES: Record<Dialect, string[]> = {
  fasm2: ['fasm2', 'fasmg'],
  fasm1: ['fasm1', 'fasm'],
};

const PROBE_TIMEOUT_MS = 3000;

export interface CompilerResolution {
  path: string;
  /** True when found via PATH probing rather than an explicit user setting. */
  autoDetected: boolean;
}

const cache = new Map<Dialect, CompilerResolution | null>();

function configuredPath(dialect: Dialect): string {
  const config = vscode.workspace.getConfiguration('fasm2Studio');
  const key = dialect === 'fasm1' ? 'fasm1CompilerPath' : 'fasm2CompilerPath';
  return (config.get<string>(key) ?? '').trim();
}

function probe(candidate: string): boolean {
  try {
    const result = spawnSync(candidate, [], { shell: true, timeout: PROBE_TIMEOUT_MS, windowsHide: true });
    // ENOENT (no such command) is the only outcome that means "not found"; any exit code,
    // including non-zero, means the shell found and ran something at that name.
    return !(result.error && (result.error as NodeJS.ErrnoException).code === 'ENOENT') && result.status !== 127;
  } catch {
    return false;
  }
}

export function resolveCompiler(dialect: Dialect): CompilerResolution | undefined {
  const explicit = configuredPath(dialect);
  if (explicit) return { path: explicit, autoDetected: false };

  const cached = cache.get(dialect);
  if (cached !== undefined) return cached ?? undefined;

  for (const candidate of CANDIDATES[dialect]) {
    if (probe(candidate)) {
      const resolution: CompilerResolution = { path: candidate, autoDetected: true };
      cache.set(dialect, resolution);
      return resolution;
    }
  }

  cache.set(dialect, null);
  return undefined;
}

export function invalidateCompilerCache(): void {
  cache.clear();
}
