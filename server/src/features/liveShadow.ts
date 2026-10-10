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
  /**
   * The real project path a compiler-reported shadow path stands for, or undefined for a path
   * outside the shadow tree (already real, or somewhere else entirely).
   *
   * The compiler only ever sees shadow paths, so every location it prints for an *included* file
   * names a temp directory that will be deleted moments later. Diagnostics reported against those
   * files have to be translated back before they can be attached to anything the user can open.
   */
  toRealPath: (fsPath: string) => string | undefined;
  cleanup: () => Promise<void>;
}

// How many ancestor levels of targetDir get mirrored (see mirrorAncestorChain) before falling back
// to a real, unmirrored directory. Bounded rather than walking to the filesystem root: cheap, and
// generously covers any realistic relative-include depth (the real bug this fixes needed only 2 —
// fasm2's own source/windows/dll/fasmg.asm: "include '../../version.inc'").
const ANCESTOR_LEVELS = 12;

/**
 * Builds a shadow compile root for `targetFsPath` (the file that would normally be handed to the
 * compiler) with `liveFsPath`'s on-disk position replaced by `liveContent`. Returns undefined if
 * `liveFsPath` isn't inside `targetFsPath`'s directory (nothing to safely override) or if the
 * shadow tree can't be built (e.g. no symlink permission on Windows without Developer Mode) —
 * callers should fall back to compiling the real file from disk in either case.
 *
 * `otherBuffers` are the unsaved texts of every other open document, keyed by real path. A program
 * is a whole include tree, so compiling it with only one file's buffer and every other file as last
 * saved assembles a program that does not exist: an unsaved `include` added to the entry point, or
 * an include path a rename rewrote in a buffer nobody has saved yet, was invisible to every other
 * file's compile, which then reported errors the user's actual code does not have. Buffers outside
 * the target's directory are left to the disk, exactly as before (their positions are symlinked
 * ancestors, not mirrored directories).
 */
export async function buildLiveShadowRoot(
  targetFsPath: string,
  liveFsPath: string,
  liveContent: string,
  otherBuffers: ReadonlyMap<string, string> = new Map(),
): Promise<LiveShadowRoot | undefined> {
  if (!relativeInside(path.dirname(targetFsPath), liveFsPath)) return undefined;
  // The live document last, so its own text wins over any stale entry for the same path.
  return buildShadowRoot(targetFsPath, new Map([...otherBuffers, [liveFsPath, liveContent]]));
}

/**
 * Builds a shadow compile root for `targetFsPath` with every buffer in `buffers` (real path → text)
 * that lies inside the target's directory in place of its file on disk. Returns undefined when no
 * buffer lies there — the real file compiles to exactly the same result, without a temp tree — and
 * when the tree cannot be built; either way the caller compiles the real file.
 */
export async function buildShadowRoot(targetFsPath: string, buffers: ReadonlyMap<string, string>): Promise<LiveShadowRoot | undefined> {
  const targetDir = path.dirname(targetFsPath);
  const overrides: OverrideTree = new Map();
  for (const [fsPath, content] of buffers) {
    const rel = relativeInside(targetDir, fsPath);
    if (rel) addOverride(overrides, rel.split(path.sep), content);
  }
  if (overrides.size === 0) return undefined;

  const shadowRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'fasm2-studio-shadow-'));
  let mirrored: MirroredChain;
  try {
    // The target itself must exist: only directories *below* it may be missing (see readDirIfExists).
    await fs.promises.access(targetDir);
    mirrored = await mirrorAncestorChain(targetDir, shadowRoot);
    await mirrorWithOverrides(targetDir, mirrored.shadowTargetDir, overrides);
  } catch {
    await fs.promises.rm(shadowRoot, { recursive: true, force: true }).catch(() => undefined);
    return undefined;
  }

  return {
    compileFsPath: path.join(mirrored.shadowTargetDir, path.basename(targetFsPath)),
    cwd: mirrored.shadowTargetDir,
    // The shadow tree is a positional copy of the real one — same directory names, same depth,
    // rooted at shadowRoot instead of realRoot — so the translation is just a swap of that prefix.
    toRealPath: (fsPath: string) => {
      const relToRoot = path.relative(shadowRoot, fsPath);
      if (!relToRoot || relToRoot.startsWith('..') || path.isAbsolute(relToRoot)) return undefined;
      return path.join(mirrored.realRoot, relToRoot);
    },
    cleanup: () => fs.promises.rm(shadowRoot, { recursive: true, force: true }).then(
      () => undefined,
      () => undefined,
    ),
  };
}

interface MirroredChain {
  /** Shadow path corresponding to the real `targetDir`. */
  shadowTargetDir: string;
  /** Real directory that `shadowRoot` itself stands for — the base of the positional copy. */
  realRoot: string;
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
async function mirrorAncestorChain(targetDir: string, shadowRoot: string): Promise<MirroredChain> {
  const root = path.parse(targetDir).root;
  const allSegments = targetDir.slice(root.length).split(path.sep).filter(Boolean);
  const segments = allSegments.slice(-ANCESTOR_LEVELS);

  const realRoot = path.join(root, ...allSegments.slice(0, allSegments.length - segments.length));
  let realDir = realRoot;
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
  return { shadowTargetDir: shadowDir, realRoot };
}

/** Files to replace in the shadow tree, as a directory tree: a string is a file's content, a map
 * is a directory holding further overrides. */
type OverrideTree = Map<string, OverrideTree | string>;

/** `fsPath` relative to `dir` when it lies strictly inside it, otherwise undefined. */
function relativeInside(dir: string, fsPath: string): string | undefined {
  const rel = path.relative(dir, fsPath);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return undefined;
  return rel;
}

function addOverride(tree: OverrideTree, parts: string[], content: string): void {
  const [head, ...rest] = parts;
  if (rest.length === 0) {
    tree.set(head, content);
    return;
  }
  let sub = tree.get(head);
  if (typeof sub !== 'object') {
    sub = new Map();
    tree.set(head, sub);
  }
  addOverride(sub, rest, content);
}

async function readDirIfExists(dir: string): Promise<fs.Dirent[]> {
  try {
    return await fs.promises.readdir(dir, { withFileTypes: true });
  } catch (err) {
    // A buffer whose file (or directory) was deleted on disk is still open and still the text the
    // user is working on: it gets a fresh directory in the shadow rather than failing the compile.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

async function mirrorWithOverrides(realDir: string, shadowDir: string, overrides: OverrideTree): Promise<void> {
  await fs.promises.mkdir(shadowDir, { recursive: true });
  const entries = await readDirIfExists(realDir);
  const onDisk = new Set(entries.map((entry) => entry.name));

  // Every entry is written to a distinct shadow path, so they can all proceed concurrently.
  // A symlink failure still rejects the whole mirror (unlike mirrorAncestorChain's best-effort
  // links) — a missing sibling here could silently change which file an `include` resolves to,
  // so the caller's fall-back-to-real-file path is the safe answer.
  await Promise.all([
    ...entries.map((entry) => {
      const shadowPath = path.join(shadowDir, entry.name);
      const override = overrides.get(entry.name);
      if (typeof override === 'string') return fs.promises.writeFile(shadowPath, override, 'utf8');
      if (override && entry.isDirectory()) return mirrorWithOverrides(path.join(realDir, entry.name), shadowPath, override);
      return fs.promises.symlink(path.join(realDir, entry.name), shadowPath, entry.isDirectory() ? 'dir' : 'file');
    }),
    // Open buffers whose file is not on disk (deleted, or renamed away, while still open).
    ...[...overrides]
      .filter(([name]) => !onDisk.has(name))
      .map(([name, override]) =>
        typeof override === 'string'
          ? fs.promises.writeFile(path.join(shadowDir, name), override, 'utf8')
          : mirrorWithOverrides(path.join(realDir, name), path.join(shadowDir, name), override),
      ),
  ]);
}
