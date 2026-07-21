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
export async function buildLiveShadowRoot(targetFsPath: string, liveFsPath: string, liveContent: string): Promise<LiveShadowRoot | undefined> {
  const targetDir = path.dirname(targetFsPath);
  const rel = path.relative(targetDir, liveFsPath);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return undefined;

  const shadowRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'fasm2-studio-shadow-'));
  try {
    await mirrorWithOverride(targetDir, shadowRoot, rel.split(path.sep), liveContent);
  } catch {
    await fs.promises.rm(shadowRoot, { recursive: true, force: true }).catch(() => undefined);
    return undefined;
  }

  return {
    compileFsPath: path.join(shadowRoot, path.basename(targetFsPath)),
    cwd: shadowRoot,
    cleanup: () => fs.promises.rm(shadowRoot, { recursive: true, force: true }).then(
      () => undefined,
      () => undefined,
    ),
  };
}

async function mirrorWithOverride(realDir: string, shadowDir: string, overrideRelParts: string[], overrideContent: string): Promise<void> {
  await fs.promises.mkdir(shadowDir, { recursive: true });
  const entries = await fs.promises.readdir(realDir, { withFileTypes: true });
  const [next, ...rest] = overrideRelParts;

  for (const entry of entries) {
    const shadowPath = path.join(shadowDir, entry.name);
    if (entry.name !== next) {
      await fs.promises.symlink(path.join(realDir, entry.name), shadowPath, entry.isDirectory() ? 'dir' : 'file');
      continue;
    }
    if (rest.length === 0) {
      await fs.promises.writeFile(shadowPath, overrideContent, 'utf8');
    } else {
      await mirrorWithOverride(path.join(realDir, entry.name), shadowPath, rest, overrideContent);
    }
  }
}
