// Two quick fixes for a name that does not resolve, offered together because they are the two
// things that can be wrong with one: the name is right but unreachable (add the `include`), or the
// name is simply misspelled (change it to the one that exists).
//
// Quick fix 1: "the symbol you just wrote exists, but this file cannot see it — add the `include`".
//
// This closes a loop the extension already had half of. definition.ts deliberately falls back to a
// workspace-wide lookup when the include graph turns up nothing, with the comment "so the user can
// go add the `include` themselves" — the information needed to *write* that line was already
// computed, and the user was then left to do it by hand. This offers it as an edit instead.
//
// Both are offered on the cursor position rather than bound to a compiler diagnostic on purpose.
// The diagnostics here come from running the real assembler, which needs a trusted workspace, a
// compiler that was found, and a compile that finished — so binding to one would withdraw the fix
// in exactly the situations where nothing else is going to point at the mistake either. Under
// fasm1 it would also mean the fix is only ever available for whichever mistake happens to be
// first in the file, since that assembler stops there (see diagnostics.ts's noteFirstErrorOnly).

import { CodeAction, CodeActionKind, Range, TextEdit } from 'vscode-languageserver/node';
import * as path from 'path';
import { URI } from 'vscode-uri';
import { detectIsa } from '../isa';
import { Dialect, ParsedDocument } from '../types';
import { Workspace } from '../workspace';
import { staticKeywords } from './completion';
import { literalConversions, NumericLiteral, parseNumericLiteral } from './numericLiteral';
import { closestNames } from './spelling';

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

/**
 * Rewrites a numeric literal into another base — the conversion hover.ts already *shows*, offered
 * as an edit rather than as something to read off a tooltip and retype.
 *
 * Checked before anything symbol-oriented below, for the same reason hover.ts checks it before its
 * own symbol lookups: a fasm identifier may not begin with a digit, so a literal can never also be
 * a name, and letting one fall through to spellingActions meant a short literal like `255` could
 * draw a lightbulb offering to "correct" it into whatever similarly-spelled symbol happened to be
 * in scope.
 */
function literalActions(uri: string, literal: NumericLiteral, wordRange: Range): CodeAction[] {
  return literalConversions(literal).map((conversion) => ({
    title: `Convert '${literal.text}' to ${conversion.label} (${conversion.text})`,
    // RefactorRewrite, not QuickFix: nothing here is wrong. A literal written in the "wrong" base
    // still assembles to the same bytes, so this belongs in the refactor menu rather than among
    // the fixes for a name that does not resolve.
    kind: CodeActionKind.RefactorRewrite,
    edit: { changes: { [uri]: [{ range: wordRange, newText: conversion.text }] } },
  }));
}

export function getCodeActions(
  workspace: Workspace,
  uri: string,
  dialect: Dialect,
  word: string,
  wordRange: Range | undefined,
  documentText: string,
): CodeAction[] {
  // Unconditionally terminal for a literal, even when it yields no conversions: what matters is
  // that a literal never reaches the symbol-oriented actions below, not that it produced an edit.
  const literal = word ? parseNumericLiteral(word) : undefined;
  if (literal) return wordRange ? literalActions(uri, literal, wordRange) : [];

  const doc = workspace.getDocument(uri);
  if (!doc || !word) return [];

  // Already reachable — nothing to fix. This is the check that keeps the action from appearing on
  // every identifier in a healthy file.
  if (workspace.findDefinitions(uri, word, dialect).length > 0) return [];

  // Don't offer to include a file to reach something this very file defines (a macro-`local`, or a
  // definition the include-graph walk skipped for scoping reasons).
  if (doc.symbols.some((s) => s.name === word)) return [];

  const actions = [...includeActions(workspace, uri, doc, word, documentText)];
  if (wordRange) actions.push(...spellingActions(workspace, uri, dialect, word, wordRange));

  // The first suggestion is the one the lightbulb applies with a single keystroke, so mark it —
  // but only when there is exactly one, since preferring an arbitrary member of several equally
  // plausible fixes is a guess dressed up as a recommendation.
  if (actions.length === 1) actions[0].isPreferred = true;

  return actions;
}

function includeActions(workspace: Workspace, uri: string, doc: ParsedDocument, word: string, documentText: string): CodeAction[] {
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

  return actions;
}

/**
 * Quick fix 2: the name is not right anywhere — it is a misspelling of one that is.
 *
 * Deliberately not bound to a compiler diagnostic, for the same reason the include fix is not:
 * diagnostics need a trusted workspace and a working compiler, and this has to keep working in the
 * cases where those are missing — which are exactly the cases where nothing else is going to point
 * at the mistake either.
 *
 * The pool is everything that would actually assemble here: the dialect's and this file's ISA's own
 * keyword tables, plus every symbol reachable through the include graph. A name from an unincluded
 * file is deliberately *not* in it — that is the other quick fix's job, and offering to rewrite a
 * correctly-spelled name into a lookalike would be the worse of the two answers.
 */
function spellingActions(workspace: Workspace, uri: string, dialect: Dialect, word: string, wordRange: Range): CodeAction[] {
  const known = new Set<string>(staticKeywords(dialect, detectIsa(workspace, uri, dialect)));
  if (known.has(word)) return [];

  for (const doc of workspace.walkIncludeGraph(uri, dialect)) {
    for (const sym of doc.symbols) {
      known.add(sym.name);
      // A macro's parameters are the one class of name that is used like a symbol but never
      // defined as one, so every reference to a parameter inside its own macro body looks
      // unresolvable from here. Counting them as known is what keeps `mov dest, src` from drawing
      // a lightbulb offering to "correct" a perfectly good parameter into something else.
      for (const param of macroParameterNames(sym.params)) known.add(param);
    }
  }
  if (known.has(word)) return [];

  return closestNames(word, known).map((suggestion) => ({
    title:
      suggestion.distance === 0
        ? `Change '${word}' to '${suggestion.name}' (this dialect is case-sensitive)`
        : `Change '${word}' to '${suggestion.name}'`,
    kind: CodeActionKind.QuickFix,
    edit: { changes: { [uri]: [{ range: wordRange, newText: suggestion.name }] } },
  }));
}

/** The individual names out of a macro's raw parameter list as written, e.g. "dest*,src&" or
 * "count:8" — fasmg's per-parameter markers (`*` required, `?` optional, `&` greedy) and default
 * values are not part of the name a body refers to. */
export function macroParameterNames(params: string | undefined): string[] {
  if (!params) return [];
  return params
    .split(',')
    .map((part) => /^[A-Za-z_.@$?%][A-Za-z0-9_.@$?%]*/.exec(part.trim())?.[0] ?? '')
    .filter((name) => name.length > 0);
}
