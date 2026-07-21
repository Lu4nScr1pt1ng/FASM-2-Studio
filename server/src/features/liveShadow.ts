// Lets diagnostics compile the in-editor buffer for a file that already exists on disk, not
// whatever was last saved. fasmg resolves relative `include`s against the process cwd (verified
// empirically, not documented), so this builds a same-shaped temp directory next to nothing real:
// every sibling of the compiled file is a symlink back to its real path (so untouched includes
// resolve exactly as they would for real), except the live document's own position in that tree,
// which gets a real temp file holding its current buffer text instead. The real project directory
// is never written to.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface LiveShadowRoot {
  /** Path to hand the compiler in place of the real target file. */
  compileFsPath: string;
  /** cwd to run the compiler with, so its relative `include`s resolve inside the shadow tree. */
  cwd: string;
  cleanup: () => Promise<void>;
}

/**
 * Builds a shadow compile root for `targetFsPath` (the file that would normally be handed to the
 * compiler) with `liveFsPath`'s on-disk position replaced by `liveContent`. Returns undefined if
 * `liveFsPath` isn't inside `targetFsPath`'s directory (nothing to safely override) or if the
 * shadow tree can't be built (e.g. no symlink permission on Windows without Developer Mode) —
 * callers should fall back to compiling the real file from disk in either case.
 */
// How many ancestor levels of targetDir get mirrored (see mirrorAncestorChain) before falling back
// to a real, unmirrored directory. Bounded rather than walking to the filesystem root: cheap, and
// generously covers any realistic relative-include depth (the real bug this fixes needed only 2 —
// fasm2's own source/windows/dll/fasmg.asm: "include '../../version.inc'").
const ANCESTOR_LEVELS = 12;

export async function buildLiveShadowRoot(targetFsPath: string, liveFsPath: string, liveContent: string): Promise<LiveShadowRoot | undefined> {
  const targetDir = path.dirname(targetFsPath);
  const rel = path.relative(targetDir, liveFsPath);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return undefined;

  const shadowRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'fasm2-studio-shadow-'));
  let shadowTargetDir: string;
  try {
    shadowTargetDir = await mirrorAncestorChain(targetDir, shadowRoot);
    await mirrorWithOverride(targetDir, shadowTargetDir, rel.split(path.sep), liveContent);
  } catch {
    await fs.promises.rm(shadowRoot, { recursive: true, force: true }).catch(() => undefined);
    return undefined;
  }

  return {
    compileFsPath: path.join(shadowTargetDir, path.basename(targetFsPath)),
    cwd: shadowTargetDir,
    cleanup: () => fs.promises.rm(shadowRoot, { recursive: true, force: true }).then(
      () => undefined,
      () => undefined,
    ),
  };
}

/**
 * Mirrors up to ANCESTOR_LEVELS real ancestor directories of `targetDir` into `shadowRoot`, so a
 * relative `include` that climbs above targetDir's own directory with ".." (a real, common pattern
 * in multi-directory projects, e.g. fasm2's own source tree) still resolves correctly instead of
 * escaping into the shadow temp dir's real, unrelated parent. At every level of the walk, every
 * sibling of the real ancestor other than the one continuing the chain is symlinked back to its
 * real path — exactly what mirrorWithOverride already does for targetDir's own siblings, just
 * repeated one level at a time on the way down. Returns the shadow path corresponding to targetDir.
 */
async function mirrorAncestorChain(targetDir: string, shadowRoot: string): Promise<string> {
  const root = path.parse(targetDir).root;
  const allSegments = targetDir.slice(root.length).split(path.sep).filter(Boolean);
  const segments = allSegments.slice(-ANCESTOR_LEVELS);

  let realDir = path.join(root, ...allSegments.slice(0, allSegments.length - segments.length));
  let shadowDir = shadowRoot;
  for (const segment of segments) {
    await fs.promises.mkdir(shadowDir, { recursive: true });
    const entries = await fs.promises.readdir(realDir, { withFileTypes: true });
    // Symlinks within one directory are independent — created concurrently, since this runs on
    // every debounced diagnostics pass and an ancestor directory can easily hold hundreds of
    // entries (each level mirrors all of that ancestor's siblings).
    await Promise.all(
      entries
        .filter((entry) => entry.name !== segment)
        .map((entry) =>
          fs.promises
            .symlink(path.join(realDir, entry.name), path.join(shadowDir, entry.name), entry.isDirectory() ? 'dir' : 'file')
            .catch(() => undefined),
        ),
    );
    realDir = path.join(realDir, segment);
    shadowDir = path.join(shadowDir, segment);
  }
  return shadowDir;
}

async function mirrorWithOverride(realDir: string, shadowDir: string, overrideRelParts: string[], overrideContent: string): Promise<void> {
  await fs.promises.mkdir(shadowDir, { recursive: true });
  const entries = await fs.promises.readdir(realDir, { withFileTypes: true });
  const [next, ...rest] = overrideRelParts;

  // Every entry is written to a distinct shadow path, so they can all proceed concurrently.
  // A symlink failure still rejects the whole mirror (unlike mirrorAncestorChain's best-effort
  // links) — a missing sibling here could silently change which file an `include` resolves to,
  // so the caller's fall-back-to-real-file path is the safe answer.
  await Promise.all(
    entries.map((entry) => {
      const shadowPath = path.join(shadowDir, entry.name);
      if (entry.name !== next) {
        return fs.promises.symlink(path.join(realDir, entry.name), shadowPath, entry.isDirectory() ? 'dir' : 'file');
      }
      if (rest.length === 0) {
        return fs.promises.writeFile(shadowPath, overrideContent, 'utf8');
      }
      return mirrorWithOverride(path.join(realDir, entry.name), shadowPath, rest, overrideContent);
    }),
  );
}
