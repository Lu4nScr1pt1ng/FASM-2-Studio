import { DocumentSymbol } from 'vscode-languageserver/node';
import { toLspRange } from '../lspUtils';
import { ParsedDocument, SymbolKind } from '../types';
import { SYMBOL_KIND_MAP } from './symbolKindMap';

export function getDocumentSymbols(doc: ParsedDocument): DocumentSymbol[] {
  const globals: DocumentSymbol[] = [];
  const byGlobalName = new Map<string, DocumentSymbol>();

  for (const sym of doc.symbols) {
    // VS Code's own DocumentSymbol validation throws ("name must not be falsy") and fails the
    // whole request over a single bad entry — defense in depth against a parser edge case
    // producing an empty name, on top of the parser itself never doing so intentionally.
    if (!sym.name) continue;

    const lspSym: DocumentSymbol = {
      name: sym.name,
      kind: SYMBOL_KIND_MAP[sym.kind],
      range: toLspRange(sym.range),
      selectionRange: toLspRange(sym.nameRange),
      detail: sym.params ?? sym.value,
      children: [],
    };

    if (sym.kind === SymbolKind.LocalLabel && sym.parentLabel && byGlobalName.has(sym.parentLabel)) {
      byGlobalName.get(sym.parentLabel)!.children!.push(lspSym);
    } else {
      globals.push(lspSym);
      if (sym.kind === SymbolKind.Label) byGlobalName.set(sym.name, lspSym);
    }
  }

  return globals;
}
