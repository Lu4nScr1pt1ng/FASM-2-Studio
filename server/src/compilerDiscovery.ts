// Mirrors extension/src/compilerDiscovery.ts. The server is a plain Node process (no vscode API
// access), so it needs its own PATH probe rather than sharing the extension's — but the two must
// resolve to the same answer, hence the identical candidate lists and probing strategy. An empty
// configured path means "auto-detect"; this is what makes that actually work for diagnostics.

import { spawnSync } from 'child_process';
import { Dialect } from './types';

const CANDIDATES: Record<Dialect, string[]> = {
  fasm2: ['fasm2', 'fasmg'],
  fasm1: ['fasm1', 'fasm'],
};

const PROBE_TIMEOUT_MS = 3000;

const cache = new Map<Dialect, string | null>();

function probe(candidate: string): boolean {
  try {
    const result = spawnSync(candidate, [], { shell: true, timeout: PROBE_TIMEOUT_MS, windowsHide: true });
    return !(result.error && (result.error as NodeJS.ErrnoException).code === 'ENOENT') && result.status !== 127;
  } catch {
    return false;
  }
}

export function resolveCompilerOnPath(dialect: Dialect): string | undefined {
  const cached = cache.get(dialect);
  if (cached !== undefined) return cached ?? undefined;

  for (const candidate of CANDIDATES[dialect]) {
    if (probe(candidate)) {
      cache.set(dialect, candidate);
      return candidate;
    }
  }

  cache.set(dialect, null);
  return undefined;
}

export function invalidateCompilerCache(): void {
  cache.clear();
}
