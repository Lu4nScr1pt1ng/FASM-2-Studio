// Highlights every occurrence of the symbol under the cursor, within the current file only.
//
// Deliberately reuses findScopedReferences rather than doing its own name scan, so it inherits the
// macro-`local` scoping for free: putting the cursor on a `local value` inside one macro highlights
// that macro's own uses of it, not the 40 unrelated `value` locals other macros in the same file
// declare (8051.inc really does that). A plain textual match would highlight all of them, which is
// worse than no highlighting — it asserts a relationship that does not exist.

import { DocumentHighlight, DocumentHighlightKind } from 'vscode-languageserver/node';
import { toLspRange } from '../lspUtils';
import { Workspace } from '../workspace';
import { findScopedReferences } from './references';

export function getDocumentHighlights(workspace: Workspace, uri: string, line: number, word: string): DocumentHighlight[] {
  return findScopedReferences(workspace, uri, line, word, true)
    .filter((entry) => entry.uri === uri)
    .map((entry) => {
      const isDefinition = 'nameRange' in entry;
      return {
        range: toLspRange(isDefinition ? entry.nameRange : entry.range),
        // Write vs Text is the distinction VS Code themes actually render differently; a
        // definition is the only thing here that writes the symbol.
        kind: isDefinition ? DocumentHighlightKind.Write : DocumentHighlightKind.Read,
      };
    });
}
