import { TextEdit, WorkspaceEdit } from 'vscode-languageserver/node';
import { findScopedReferences } from './references';
import { toLspRange } from '../lspUtils';
import { Workspace } from '../workspace';

/** True if `word` resolves to a user-defined symbol we actually know how to rename (as opposed
 * to a bare instruction/register/directive keyword, which isn't in the symbol table at all).
 * Position-aware via findScopedReferences so a `local`-scoped name only counts as renameable
 * where it's actually in scope — see getRenameEdit. */
export function isRenameable(workspace: Workspace, uri: string, line: number, word: string): boolean {
  return findScopedReferences(workspace, uri, line, word, true).length > 0;
}

export function getRenameEdit(workspace: Workspace, uri: string, line: number, word: string, newName: string): WorkspaceEdit | undefined {
  const entries = findScopedReferences(workspace, uri, line, word, true);
  if (entries.length === 0) return undefined;

  const changes: Record<string, TextEdit[]> = {};
  for (const entry of entries) {
    const range = 'nameRange' in entry ? entry.nameRange : entry.range;
    const edit: TextEdit = { range: toLspRange(range), newText: newName };
    (changes[entry.uri] ??= []).push(edit);
  }
  return { changes };
}
