import { Location, Range as LspRange } from 'vscode-languageserver/node';
import { Dialect, Range } from '../types';
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

  const local = workspace.findDefinitions(uri, word, dialect);
  // Fall back to a workspace-wide lookup only when the include graph has nothing — e.g. jumping
  // to a macro defined in a sibling file so the user can go add the `include` themselves.
  const found = local.length > 0 ? local : workspace.findSymbolAnywhere(word);
  return found.map((sym) => ({
    uri: sym.uri,
    range: toLspRange(sym.nameRange),
  }));
}
