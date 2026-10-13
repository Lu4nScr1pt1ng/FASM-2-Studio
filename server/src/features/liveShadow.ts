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

// How many ancestor levels of targetDir get mirrored (see mirroredRootOf) before falling back
// to a real, unmirrored directory. Bounded rather than walking to the filesystem root: cheap, and
// generously covers any realistic relative-include depth (the real bug this fixes needed only 2 —
// fasm2's own source/windows/dll/fasmg.asm: "include '../../version.inc'").
const ANCESTOR_LEVELS = 12;

/**
 * Builds a shadow compile root for `targetFsPath` (the file that would normally be handed to the
 * compiler) with `liveFsPath`'s on-disk position replaced by `liveContent`, and every other open
 * document's position by its unsaved text (`otherBuffers`, keyed by real path). Returns undefined
 * if the shadow tree can't be built (e.g. no symlink permission on Windows without Developer Mode)
 * — callers should fall back to compiling the real file from disk. See buildShadowRoot.
 */
export async function buildLiveShadowRoot(
  targetFsPath: string,
  liveFsPath: string,
  liveContent: string,
  otherBuffers: ReadonlyMap<string, string> = new Map(),
): Promise<LiveShadowRoot | undefined> {
  // The live document last, so its own text wins over any stale entry for the same path.
  return buildShadowRoot(targetFsPath, new Map([...otherBuffers, [liveFsPath, liveContent]]));
}

/**
 * Builds a shadow compile root for `targetFsPath` with every buffer in `buffers` (real path → text)
 * in place of its file on disk, wherever the buffer lies in the mirrored tree: next to the target,
 * below it, or in a directory beside one of its ancestors — where `include '../lib/x.inc'` finds
 * it. Returns undefined when no buffer lies in that tree — the real file compiles to exactly the
 * same result, without a temp tree — and when the tree cannot be built; either way the caller
 * compiles the real file.
 *
 * Only the target's own directory used to be overridable. Every other buffer was left to the disk,
 * so in a project laid out as `src/main.asm` + `lib/*.inc` an unsaved edit to a library file was
 * invisible to its program: the errors shown were those of the last saved version until it was
 * saved, and an error fixed in the buffer stayed on screen.
 */
export async function buildShadowRoot(targetFsPath: string, buffers: ReadonlyMap<string, string>): Promise<LiveShadowRoot | undefined> {
  const targetDir = path.dirname(targetFsPath);
  const realRoot = mirroredRootOf(targetDir);
  const overrides: OverrideTree = new Map();
  for (const [fsPath, content] of buffers) {
    const rel = relativeInside(realRoot, fsPath);
    if (rel) addOverride(overrides, rel.split(path.sep), content);
  }
  if (overrides.size === 0) return undefined;
  // The chain down to the target is always mirrored as real directories, buffers or not: the
  // compiler runs inside it, and every `..` it resolves must stay inside the shadow tree.
  const chain = relativeInside(realRoot, targetDir);
  if (chain) addDirectory(overrides, chain.split(path.sep));

  const shadowRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'fasm2-studio-shadow-'));
  try {
    // The target itself must exist: only directories *below* it may be missing (see readDirIfExists).
    await fs.promises.access(targetDir);
    await mirrorWithOverrides(realRoot, shadowRoot, overrides);
  } catch {
    await fs.promises.rm(shadowRoot, { recursive: true, force: true }).catch(() => undefined);
    return undefined;
  }
  const shadowTargetDir = chain ? path.join(shadowRoot, chain) : shadowRoot;

  return {
    compileFsPath: path.join(shadowTargetDir, path.basename(targetFsPath)),
    cwd: shadowTargetDir,
    // The shadow tree is a positional copy of the real one — same directory names, same depth,
    // rooted at shadowRoot instead of realRoot — so the translation is just a swap of that prefix.
    toRealPath: (fsPath: string) => {
      const relToRoot = path.relative(shadowRoot, fsPath);
      if (!relToRoot || relToRoot.startsWith('..') || path.isAbsolute(relToRoot)) return undefined;
      return path.join(realRoot, relToRoot);
    },
    cleanup: () => fs.promises.rm(shadowRoot, { recursive: true, force: true }).then(
      () => undefined,
      () => undefined,
    ),
  };
}

/**
 * The real directory the shadow tree stands for: `targetDir`'s ancestor ANCESTOR_LEVELS up (or the
 * filesystem root, if that comes first). Mirroring from there means a relative `include` that
 * climbs above the target's own directory with ".." (a real, common pattern in multi-directory
 * projects, e.g. fasm2's own source tree) still resolves inside the shadow tree instead of
 * escaping into the temp directory's real, unrelated parent.
 */
function mirroredRootOf(targetDir: string): string {
  const root = path.parse(targetDir).root;
  const segments = targetDir.slice(root.length).split(path.sep).filter(Boolean);
  return path.join(root, ...segments.slice(0, Math.max(0, segments.length - ANCESTOR_LEVELS)));
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

/** Marks `parts` as a directory to mirror, without replacing any file in it. */
function addDirectory(tree: OverrideTree, parts: string[]): void {
  let level = tree;
  for (const part of parts) {
    let sub = level.get(part);
    if (typeof sub !== 'object') {
      sub = new Map();
      level.set(part, sub);
    }
    level = sub;
  }
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

async function isDirectory(entry: fs.Dirent, fsPath: string): Promise<boolean> {
  if (entry.isDirectory()) return true;
  if (!entry.isSymbolicLink()) return false;
  return fs.promises.stat(fsPath).then(
    (stat) => stat.isDirectory(),
    () => false,
  );
}

function linkBack(realDir: string, entry: fs.Dirent, shadowPath: string): Promise<void> {
  return fs.promises.symlink(path.join(realDir, entry.name), shadowPath, entry.isDirectory() ? 'dir' : 'file');
}

async function mirrorWithOverrides(realDir: string, shadowDir: string, overrides: OverrideTree): Promise<void> {
  await fs.promises.mkdir(shadowDir, { recursive: true });
  const entries = await readDirIfExists(realDir);
  const onDisk = new Set(entries.map((entry) => entry.name));

  // Every entry is written to a distinct shadow path, so they can all proceed concurrently.
  // A symlink failure rejects the whole mirror — a missing sibling could silently change which
  // file an `include` resolves to, so the caller's fall-back-to-real-file path is the safe answer.
  await Promise.all([
    ...entries.map((entry) => {
      const shadowPath = path.join(shadowDir, entry.name);
      const override = overrides.get(entry.name);
      if (typeof override === 'string') return fs.promises.writeFile(shadowPath, override, 'utf8');
      if (override) {
        // A directory holding a buffer is mirrored rather than linked, so the buffer can replace
        // its file. That includes a symlink to a directory (`src/lib -> ../shared/lib`): linking it
        // would hand the compiler the real directory, and the buffer of a file opened through the
        // link would be silently ignored.
        return isDirectory(entry, path.join(realDir, entry.name)).then((dir) =>
          dir ? mirrorWithOverrides(path.join(realDir, entry.name), shadowPath, override) : linkBack(realDir, entry, shadowPath),
        );
      }
      return linkBack(realDir, entry, shadowPath);
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
