import { Location, Range as LspRange } from 'vscode-languageserver/node';
import { Dialect, Range, SymbolDefinition } from '../types';
import { Workspace } from '../workspace';

function toLspRange(r: { startLine: number; startChar: number; endLine: number; endChar: number }): LspRange {
  return {
    start: { line: r.startLine, character: r.startChar },
    end: { line: r.endLine, character: r.endChar },
  };
}

function positionInRange(position: { line: number; character: number }, range: Range): boolean {
  return position.line === range.startLine && position.character >= range.startChar && position.character <= range.endChar;
}

/**
 * Filters `candidates` down to what's actually visible from `uri`/`line`: a `local`-scoped
 * candidate (see SymbolDefinition.localScope) is a fresh, hygienic variable private to its one
 * enclosing macro, so a same-named local from a different macro — even in the same file — is
 * never a valid jump target. If the query position is inside the one macro body that declared it,
 * that's the unambiguous answer; otherwise every local-scoped candidate is dropped, leaving
 * whatever globally-visible definitions remain (0, 1, or several legitimate same-name overloads
 * like the dialect-specific "movsd" pair).
 */
function filterToInScope(candidates: SymbolDefinition[], uri: string, line: number | undefined): SymbolDefinition[] {
  if (line !== undefined) {
    const inScope = candidates.find((s) => s.localScope && s.uri === uri && line >= s.localScope.startLine && line <= s.localScope.endLine);
    if (inScope) return [inScope];
  }
  return candidates.filter((s) => !s.localScope);
}

export function getDefinitions(
  workspace: Workspace,
  uri: string,
  dialect: Dialect,
  word: string,
  position?: { line: number; character: number },
): Location[] {
  if (position) {
    const doc = workspace.getDocument(uri);
    const include = doc?.includes.find((inc) => positionInRange(position, inc.range));
    if (include) {
      const target = workspace.resolveIncludeUri(uri, include.path);
      if (target) return [{ uri: target, range: toLspRange({ startLine: 0, startChar: 0, endLine: 0, endChar: 0 }) }];
    }
  }

  const local = filterToInScope(workspace.findDefinitions(uri, word, dialect), uri, position?.line);
  // Fall back to a workspace-wide lookup only when the include graph has nothing — e.g. jumping
  // to a macro defined in a sibling file so the user can go add the `include` themselves.
  // (findSymbolAnywhere already never returns local-scoped symbols — see Workspace.addToGlobalIndex.)
  const found = local.length > 0 ? local : workspace.findSymbolAnywhere(word);
  return found.map((sym) => ({
    uri: sym.uri,
    range: toLspRange(sym.nameRange),
  }));
}
