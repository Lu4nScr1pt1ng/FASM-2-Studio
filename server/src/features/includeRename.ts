// Keeps `include` paths pointing at the file they named after that file — or the file doing the
// including — is renamed or moved.
//
// Without this, the editor's own rename/move gesture is the one operation that silently breaks a
// project: nothing in the source is wrong to look at, every include still *reads* correctly, and
// the first sign of trouble is the assembler failing on a path that no longer exists. fasm has no
// module system to fall back on, so a path in a string literal is the only thing tying two files
// together.
//
// Both directions of the edge move, and both are handled by the single pass below:
//
//   - Something else includes the moved file. `include 'lib/util.inc'` in a file that stayed put
//     has to follow util.inc to wherever it went.
//   - The moved file includes something else. A fragment moved into a subdirectory takes its own
//     relative `include 'macros.inc'` with it, and that path is now resolved from a different
//     directory than the one it was written against.
//
// Treating them as one problem — "for every include edge, where is each end going to be?" — is
// also what makes a rename that moves *both* ends at once (dragging two files into a new folder,
// or renaming the folder itself) come out right, which handling them separately would not.

import * as path from 'path';
import { TextEdit } from 'vscode-languageserver/node';
import { URI } from 'vscode-uri';
import { toLspRange } from '../lspUtils';
import { IncludeDirective } from '../types';
import { Workspace } from '../workspace';

export interface FileRename {
  oldUri: string;
  newUri: string;
}

/**
 * Edits keyed by the URI each file has *now*, before any renaming has happened.
 *
 * That is deliberate, and it is why this is driven from the client's `onWillRenameFiles` rather
 * than after the fact: the edits are applied first and the rename moves the already-corrected
 * contents, so a file that is both being moved and being edited is named here by where it still
 * is. Computing this beforehand also means the include graph is still the one that describes the
 * project as written — asking afterwards races the file watcher, which may already have dropped
 * the old path from the index and taken every "who includes this?" answer with it.
 */
export interface IncludeRenameEdits {
  changes: { [uri: string]: TextEdit[] };
}

/** Re-quotes a path the way the author wrote the original: fasm accepts `'` and `"` equally, and
 * escapes a quote inside a string by doubling it (see the tokenizer's unquoteString). */
function quotePath(pathText: string, quote: string): string {
  const q = quote === '"' ? '"' : "'";
  return `${q}${pathText.split(q).join(q + q)}${q}`;
}

/** The written form of `relativePath` using the separator the original include used. fasmg accepts
 * either separator on any host ("the format of the path may depend on the operating system", per
 * its manual), so a Windows-authored `include 'api\kernel32.inc'` stays backslashed rather than
 * becoming the one line in that file written the other way round. */
function withSeparatorStyleOf(original: string, relativePath: string): string {
  const backslashed = original.includes('\\') && !original.includes('/');
  return relativePath.split(path.sep).join(backslashed ? '\\' : '/');
}

/** Spells `targetFsPath` relative to whichever include search directory contains it, or undefined
 * when none does. The shortest such path wins, which is the one the deepest matching directory
 * produces — the same "most specific wins" answer a reader would give. */
function spellViaSearchDirectory(targetFsPath: string, searchDirs: string[]): string | undefined {
  let best: string | undefined;
  for (const dir of searchDirs) {
    const relative = path.relative(dir, targetFsPath);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) continue;
    if (best === undefined || relative.length < best.length) best = relative;
  }
  return best;
}

/**
 * How the include should read once both ends have landed where they are going.
 *
 * An include that resolves through fasm2Studio.includePath today is kept that way if it still can
 * be: those paths are written against a search directory rather than against the including file,
 * so they are unaffected by either file moving, and rewriting one into a long `../../..` relative
 * path would be a strictly worse line than the one already there. Everything else is relative to
 * the including file's new directory, which is where the assembler resolves it from.
 */
function rewrittenPath(
  include: IncludeDirective,
  includerOldDir: string,
  includerNewDir: string,
  targetOldFsPath: string,
  targetNewFsPath: string,
  searchDirs: string[],
): string | undefined {
  const written = include.path.replace(/\\/g, '/');
  const wasRelativeToIncluder = path.resolve(includerOldDir, written) === targetOldFsPath;

  const spelled = wasRelativeToIncluder
    ? path.relative(includerNewDir, targetNewFsPath)
    : (spellViaSearchDirectory(targetNewFsPath, searchDirs) ?? path.relative(includerNewDir, targetNewFsPath));
  if (!spelled) return undefined;

  const rewritten = withSeparatorStyleOf(include.path, spelled);
  return rewritten === include.path ? undefined : rewritten;
}

/**
 * Every include line that has to change for `renames` to leave the project building as it did.
 *
 * Includes that do not resolve today are left alone. A path that already points at nothing cannot
 * be repointed — there is no way to tell which of the renamed files (if any) it was reaching for —
 * and rewriting it would replace a broken line the user can recognize with a broken line they
 * cannot.
 */
export function includeRenameEdits(workspace: Workspace, renames: FileRename[]): IncludeRenameEdits {
  const movedTo = new Map<string, string>();
  for (const { oldUri, newUri } of renames) {
    const from = URI.parse(oldUri).fsPath;
    const to = URI.parse(newUri).fsPath;
    if (from !== to) movedTo.set(from, to);
  }
  if (movedTo.size === 0) return { changes: {} };

  const searchDirs = workspace.includeSearchDirectories();
  const changes: { [uri: string]: TextEdit[] } = {};

  for (const doc of workspace.allKnownDocuments()) {
    if (doc.includes.length === 0) continue;

    const includerOldFsPath = URI.parse(doc.uri).fsPath;
    const includerNewFsPath = movedTo.get(includerOldFsPath) ?? includerOldFsPath;
    const includerOldDir = path.dirname(includerOldFsPath);
    const includerNewDir = path.dirname(includerNewFsPath);

    const edits: TextEdit[] = [];
    for (const include of doc.includes) {
      const targetUri = workspace.resolveIncludeUri(doc.uri, include.path);
      if (!targetUri) continue;

      const targetOldFsPath = URI.parse(targetUri).fsPath;
      const targetNewFsPath = movedTo.get(targetOldFsPath) ?? targetOldFsPath;
      // Neither end of this edge is moving, so whatever it says today it will still say correctly.
      if (includerNewFsPath === includerOldFsPath && targetNewFsPath === targetOldFsPath) continue;

      const rewritten = rewrittenPath(
        include,
        includerOldDir,
        includerNewDir,
        targetOldFsPath,
        targetNewFsPath,
        searchDirs,
      );
      if (rewritten === undefined) continue;

      edits.push({ range: toLspRange(include.range), newText: quotePath(rewritten, include.quote) });
    }

    if (edits.length > 0) changes[doc.uri] = edits;
  }

  return { changes };
}
