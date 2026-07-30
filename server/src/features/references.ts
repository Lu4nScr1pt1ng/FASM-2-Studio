import { Location } from 'vscode-languageserver/node';
import { toLspRange } from '../lspUtils';
import { SymbolDefinition, SymbolReference } from '../types';
import { isLocalInScope, Workspace } from '../workspace';

/**
 * Resolves every reference to `word` actually in scope at `uri`/`line` — the position-aware
 * counterpart to Workspace.findReferences' plain global name lookup. A `local`-scoped declaration
 * (see SymbolDefinition.localScope) is a fresh, hygienic variable private to its one enclosing
 * macro body — the same name is routinely reused, unrelated, in dozens of other macros (8051.inc
 * alone declares "value" `local` in 40 different macros) — so if `word` resolves to one *here*,
 * results are restricted to just that macro body's own references, the same scoping hover/
 * go-to-definition already apply to declarations (see isLocalInScope). Everything else (an
 * ordinary global symbol, or a local queried from outside any macro that declares it) falls back
 * to the plain workspace-wide lookup, exactly as before.
 */
export function findScopedReferences(
  workspace: Workspace,
  uri: string,
  line: number,
  word: string,
  includeDeclaration: boolean,
): Array<SymbolReference | SymbolDefinition> {
  const doc = workspace.getDocument(uri);
  const localDecl = doc?.symbols.find((s) => s.name === word && isLocalInScope(s, uri, line));
  if (localDecl?.localScope) {
    const scope = localDecl.localScope;
    const refs = doc!.references.filter((r) => r.name === word && r.uri === uri && r.range.startLine >= scope.startLine && r.range.startLine <= scope.endLine);
    return includeDeclaration ? [localDecl, ...refs] : refs;
  }
  return workspace.findReferences(word, includeDeclaration);
}

/**
 * Best-effort find-all-references, backed by Workspace's name-indexed global map: covers every
 * open editor plus the background-indexed workspace plus anything resolved on demand via
 * `include`, but not files outside all of those that nothing has ever touched this session.
 */
export function getReferences(workspace: Workspace, uri: string, line: number, word: string, includeDeclaration: boolean): Location[] {
  return findScopedReferences(workspace, uri, line, word, includeDeclaration).map((entry) => ({
    uri: entry.uri,
    range: toLspRange('nameRange' in entry ? entry.nameRange : entry.range),
  }));
}
