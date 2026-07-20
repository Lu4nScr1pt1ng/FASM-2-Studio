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
import { Dialect } from './types';

const CANDIDATES: Record<Dialect, string[]> = {
  fasm2: ['fasm2', 'fasmg'],
  fasm1: ['fasm1', 'fasm'],
};

const PROBE_TIMEOUT_MS = 3000;
const BANNER_MARKER = 'flat assembler';

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
  for (const candidate of CANDIDATES[dialect]) {
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
}
