import { DocumentSymbol, Range as LspRange, SymbolKind as LspSymbolKind } from 'vscode-languageserver/node';
import { ParsedDocument, SymbolKind } from '../types';

const KIND_MAP: Record<SymbolKind, LspSymbolKind> = {
  [SymbolKind.Label]: LspSymbolKind.Function,
  [SymbolKind.LocalLabel]: LspSymbolKind.Field,
  [SymbolKind.Constant]: LspSymbolKind.Constant,
  [SymbolKind.Macro]: LspSymbolKind.Method,
  [SymbolKind.Struct]: LspSymbolKind.Struct,
  [SymbolKind.Section]: LspSymbolKind.Namespace,
};

function toLspRange(r: { startLine: number; startChar: number; endLine: number; endChar: number }): LspRange {
  return {
    start: { line: r.startLine, character: r.startChar },
    end: { line: r.endLine, character: r.endChar },
  };
}

export function getDocumentSymbols(doc: ParsedDocument): DocumentSymbol[] {
  const globals: DocumentSymbol[] = [];
  const byGlobalName = new Map<string, DocumentSymbol>();

  for (const sym of doc.symbols) {
    const lspSym: DocumentSymbol = {
      name: sym.name,
      kind: KIND_MAP[sym.kind],
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
