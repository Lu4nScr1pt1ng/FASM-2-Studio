// Quick fix: "the symbol you just wrote exists, but this file cannot see it — add the `include`".
//
// This closes a loop the extension already had half of. definition.ts deliberately falls back to a
// workspace-wide lookup when the include graph turns up nothing, with the comment "so the user can
// go add the `include` themselves" — the information needed to *write* that line was already
// computed, and the user was then left to do it by hand. This offers it as an edit instead.
//
// It is offered on the cursor position rather than bound to a compiler diagnostic on purpose. The
// diagnostics here come from the real assembler, and fasm stops at its first error, so binding to
// one would mean the fix is only ever available for whichever missing symbol happens to be first
// in the file.

import { CodeAction, CodeActionKind, TextEdit } from 'vscode-languageserver/node';
import * as path from 'path';
import { URI } from 'vscode-uri';
import { Dialect, ParsedDocument } from '../types';
import { Workspace } from '../workspace';

/** Cap on how many alternative files are offered for one symbol. A name defined in a dozen places
 * is almost always a macro-package convention rather than a real choice, and a lightbulb menu with
 * a dozen near-identical entries is not a menu anyone reads. */
const MAX_SUGGESTIONS = 5;

/**
 * The path to write inside `include '...'`, relative to the including file's own directory and
 * always with forward slashes — fasm accepts them on every platform, whereas a Windows backslash
 * inside a fasm string is ambiguous with an escape in other contexts and reads badly in a file
 * that is meant to build on Linux too.
 */
export function includePathFor(fromUri: string, targetUri: string): string | undefined {
  let fromFsPath: string;
  let targetFsPath: string;
  try {
    fromFsPath = URI.parse(fromUri).fsPath;
    targetFsPath = URI.parse(targetUri).fsPath;
  } catch {
    return undefined;
  }
  const relative = path.relative(path.dirname(fromFsPath), targetFsPath);
  if (!relative) return undefined;
  const normalized = relative.split(path.sep).join('/');
  // A sibling file reads better (and is what a person would type) without a "./" prefix; fasm
  // resolves a bare name against the including file's own directory first either way.
  return normalized.startsWith('../') ? normalized : normalized.replace(/^\.\//, '');
}

/**
 * Where a new `include` should go: on the line after the last existing top-level `include`, so
 * they stay grouped. Failing that, after the file's header directives (`format`, `entry`, `use`),
 * which must stay first. Failing that, the top of the file.
 */
export function includeInsertLine(doc: ParsedDocument, text: string): number {
  const lastInclude = doc.includes.reduce((max, inc) => Math.max(max, inc.range.endLine), -1);
  if (lastInclude >= 0) return lastInclude + 1;

  const lines = text.split(/\r\n|\r|\n/);
  let afterHeader = 0;
  for (let i = 0; i < lines.length; i++) {
    const keyword = /^\s*([A-Za-z_][A-Za-z0-9_]*)/.exec(lines[i])?.[1]?.toLowerCase();
    if (keyword === 'format' || keyword === 'entry' || keyword === 'use' || keyword === 'org') {
      afterHeader = i + 1;
      continue;
    }
    // Keep scanning past blank lines and comments so a commented header block does not stop this
    // one line too early, but stop at the first line of real code.
    if (lines[i].trim() === '' || lines[i].trimStart().startsWith(';')) continue;
    break;
  }
  return afterHeader;
}

export function getCodeActions(workspace: Workspace, uri: string, dialect: Dialect, word: string, documentText: string): CodeAction[] {
  const doc = workspace.getDocument(uri);
  if (!doc || !word) return [];

  // Already reachable — nothing to fix. This is the check that keeps the action from appearing on
  // every identifier in a healthy file.
  if (workspace.findDefinitions(uri, word, dialect).length > 0) return [];

  // Don't offer to include a file to reach something this very file defines (a macro-`local`, or a
  // definition the include-graph walk skipped for scoping reasons).
  if (doc.symbols.some((s) => s.name === word)) return [];

  const candidates = workspace.findSymbolAnywhere(word);
  if (candidates.length === 0) return [];

  const seen = new Set<string>();
  const actions: CodeAction[] = [];
  const insertLine = includeInsertLine(doc, documentText);

  for (const candidate of candidates) {
    if (candidate.uri === uri) continue;
    if (seen.has(candidate.uri)) continue;
    seen.add(candidate.uri);

    const includePath = includePathFor(uri, candidate.uri);
    if (!includePath) continue;
    // Already included yet still unreachable (e.g. behind conditional assembly) — adding a second,
    // identical `include` would not help and would be a duplicate line.
    if (doc.includes.some((inc) => inc.path === includePath)) continue;

    const edit: TextEdit = {
      range: { start: { line: insertLine, character: 0 }, end: { line: insertLine, character: 0 } },
      newText: `include '${includePath}'\n`,
    };

    actions.push({
      title: `Add include '${includePath}' for ${candidate.kind} '${word}'`,
      kind: CodeActionKind.QuickFix,
      edit: { changes: { [uri]: [edit] } },
    });
    if (actions.length >= MAX_SUGGESTIONS) break;
  }

  // The first suggestion is the one the lightbulb applies with a single keystroke, so mark it —
  // but only when there is exactly one, since preferring an arbitrary member of several equally
  // plausible files is a guess dressed up as a recommendation.
  if (actions.length === 1) actions[0].isPreferred = true;

  return actions;
}
