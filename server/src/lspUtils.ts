import { Range as LspRange } from 'vscode-languageserver/node';
import { Range } from './types';

/** Converts this parser's own `Range` (plain startLine/startChar/endLine/endChar) to the LSP
 * wire shape every feature needs to actually return to the client. */
export function toLspRange(r: Range): LspRange {
  return {
    start: { line: r.startLine, character: r.startChar },
    end: { line: r.endLine, character: r.endChar },
  };
}
