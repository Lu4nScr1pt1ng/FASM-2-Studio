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
}
