import { Location, Range as LspRange } from 'vscode-languageserver/node';
import { Workspace } from '../workspace';

function toLspRange(r: { startLine: number; startChar: number; endLine: number; endChar: number }): LspRange {
  return {
    start: { line: r.startLine, character: r.startChar },
    end: { line: r.endLine, character: r.endChar },
  };
}

/**
 * Best-effort find-all-references, backed by Workspace's name-indexed global map: covers every
 * open editor plus the background-indexed workspace plus anything resolved on demand via
 * `include`, but not files outside all of those that nothing has ever touched this session.
 */
export function getReferences(workspace: Workspace, word: string, includeDeclaration: boolean): Location[] {
  return workspace.findReferences(word, includeDeclaration).map((entry) => ({
    uri: entry.uri,
    range: toLspRange('nameRange' in entry ? entry.nameRange : entry.range),
  }));
}
