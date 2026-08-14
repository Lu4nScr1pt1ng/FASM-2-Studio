// Turning "this file, dropped there" into the `include` line that actually reaches it.
//
// Pure path arithmetic, kept apart from the VS Code wiring (includeDrop.ts) because the thing that
// can be wrong here is a path that looks plausible and does not resolve — which is invisible until
// the assembler is run, and is exactly what dropping a file is supposed to save you from.
//
// The rules mirror how fasmg itself resolves an include, since a path spelled against a different
// search order is a path that fails to open: the including file's own directory first, then the
// semicolon-separated directories of fasm2Studio.includePath (passed to the assembler as INCLUDE).

import * as path from 'path';

/** Extensions worth writing an `include` for. Anything else dropped into a source file is left to
 * VS Code's own default handling, which inserts the path as plain text — a `.png` is not something
 * an `include` line has any business naming. */
const INCLUDABLE_EXTENSIONS = new Set(['.inc', '.asm', '.fasm', '.fas', '.alm']);

export function isIncludable(fsPath: string): boolean {
  return INCLUDABLE_EXTENSIONS.has(path.extname(fsPath).toLowerCase());
}

/**
 * How a path is written inside a fasm string literal.
 *
 * Separators are forward slashes on every platform: fasm accepts them on Windows, and a backslash
 * written into a source file makes that file non-portable in a way nothing later warns about.
 * A literal quote is doubled, which is how both fasm1 and fasmg escape one inside a string.
 */
function asFasmString(relativePath: string): string {
  return `'${relativePath.split(path.sep).join('/').replace(/'/g, "''")}'`;
}

/** Whether `candidate` is inside `directory` — used to decide whether a search directory can spell
 * this file at all. Compared case-insensitively on Windows, where the same directory reached two
 * ways differs only in case. */
function isInside(directory: string, candidate: string): boolean {
  const relative = path.relative(directory, candidate);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return false;
  return true;
}

export interface IncludePathOptions {
  /** The file being edited — the one that will hold the `include` line. */
  fromFsPath: string;
  /** The file being dropped onto it. */
  droppedFsPath: string;
  /** fasm2Studio.includePath, already split into directories. */
  searchDirs?: readonly string[];
}

/**
 * The path to write inside `include '...'`, or undefined when there is nothing sensible to write.
 *
 * Prefers a path relative to the including file, which is what makes the result survive the project
 * being moved or checked out somewhere else. Falls back to a search directory only when the
 * relative path would have to climb out of the tree — a `'../../../shared/macros.inc'` that a
 * configured include directory can spell as `'macros.inc'` is both shorter and the spelling that
 * keeps working when the two trees are laid out differently on another machine.
 *
 * An absolute path is the last resort, for a file on another Windows drive where no relative path
 * exists at all. It is still better than refusing: it assembles here and now, and it is visibly
 * absolute, so it reads as something to tidy up rather than as a mystery.
 */
export function includePathFor(options: IncludePathOptions): string | undefined {
  const from = path.resolve(options.fromFsPath);
  const dropped = path.resolve(options.droppedFsPath);

  // A file cannot include itself: fasmg follows it, re-enters the same file, and recurses until it
  // gives up. Silently doing nothing is the right answer to a drop onto the file's own tab.
  if (from === dropped) return undefined;

  const relative = path.relative(path.dirname(from), dropped);
  const escapesTree = !relative || relative.startsWith('..') || path.isAbsolute(relative);
  if (!escapesTree) return relative;

  // Longest match first: with both "vendor" and "vendor/fasm/include" configured, the deeper one
  // spells the shortest path, and is also the more specific statement about where the file lives.
  const containing = [...(options.searchDirs ?? [])]
    .map((dir) => path.resolve(dir))
    .filter((dir) => isInside(dir, dropped))
    .sort((a, b) => b.length - a.length)[0];
  if (containing) return path.relative(containing, dropped);

  // path.relative returns an absolute path when there is no route between two Windows drives; on
  // every other platform a `../` chain always exists, and is preferred to an absolute path.
  return path.isAbsolute(relative) ? dropped : relative;
}

/**
 * The complete text to insert for one dropped file, or undefined to leave the drop to VS Code.
 *
 * Written as a whole statement rather than as a bare path: the point of the gesture is to produce a
 * line that assembles, and `include` plus a correctly-spelled path is the entire content of that
 * line.
 */
export function includeDirectiveFor(options: IncludePathOptions): string | undefined {
  if (!isIncludable(options.droppedFsPath)) return undefined;
  const resolved = includePathFor(options);
  return resolved === undefined ? undefined : `include ${asFasmString(resolved)}`;
}

/**
 * The text for a whole dropped selection — one `include` per line, in the order dropped.
 *
 * Files that have nothing to contribute (the target file itself, a `.png`) drop out rather than
 * blocking the rest: dragging a folder's worth of files across is a normal thing to do, and one
 * unusable entry among them is not a reason to insert nothing.
 */
export function includeDirectivesFor(fromFsPath: string, droppedFsPaths: readonly string[], searchDirs?: readonly string[]): string | undefined {
  const lines = droppedFsPaths
    .map((droppedFsPath) => includeDirectiveFor({ fromFsPath, droppedFsPath, searchDirs }))
    .filter((line): line is string => line !== undefined);
  return lines.length > 0 ? lines.join('\n') : undefined;
}
