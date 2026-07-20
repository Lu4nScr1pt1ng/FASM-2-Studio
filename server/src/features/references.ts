import { Location, Range as LspRange } from 'vscode-languageserver/node';
import { Workspace } from '../workspace';

function toLspRange(r: { startLine: number; startChar: number; endLine: number; endChar: number }): LspRange {
  return {
    start: { line: r.startLine, character: r.startChar },
    end: { line: r.endLine, character: r.endChar },
  };
}

/**
 * Best-effort find-all-references: see the doc comment on Workspace.allKnownDocuments for the
 * scope limit (open documents + their resolved includes, not a full workspace crawl).
 */
export function getReferences(workspace: Workspace, word: string, includeDeclaration: boolean): Location[] {
  return workspace.findReferences(word, includeDeclaration).map((entry) => ({
    uri: entry.uri,
    range: toLspRange('nameRange' in entry ? entry.nameRange : entry.range),
  }));
}
