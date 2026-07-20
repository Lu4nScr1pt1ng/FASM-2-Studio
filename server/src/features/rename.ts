import { Range as LspRange, TextEdit, WorkspaceEdit } from 'vscode-languageserver/node';
import { Workspace } from '../workspace';

function toLspRange(r: { startLine: number; startChar: number; endLine: number; endChar: number }): LspRange {
  return {
    start: { line: r.startLine, character: r.startChar },
    end: { line: r.endLine, character: r.endChar },
  };
}

/** True if `word` resolves to a user-defined symbol we actually know how to rename (as opposed
 * to a bare instruction/register/directive keyword, which isn't in the symbol table at all). */
export function isRenameable(workspace: Workspace, word: string): boolean {
  return workspace.findReferences(word, true).length > 0;
}

export function getRenameEdit(workspace: Workspace, word: string, newName: string): WorkspaceEdit | undefined {
  const entries = workspace.findReferences(word, true);
  if (entries.length === 0) return undefined;

  const changes: Record<string, TextEdit[]> = {};
  for (const entry of entries) {
    const range = 'nameRange' in entry ? entry.nameRange : entry.range;
    const edit: TextEdit = { range: toLspRange(range), newText: newName };
    (changes[entry.uri] ??= []).push(edit);
  }
  return { changes };
}
