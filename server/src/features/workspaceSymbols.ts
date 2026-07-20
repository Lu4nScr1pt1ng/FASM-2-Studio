import { Range as LspRange, SymbolInformation, SymbolKind as LspSymbolKind } from 'vscode-languageserver/node';
import { SymbolKind } from '../types';
import { Workspace } from '../workspace';

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

export function getWorkspaceSymbols(workspace: Workspace, query: string): SymbolInformation[] {
  return workspace.findWorkspaceSymbols(query).map((sym) => ({
    name: sym.name,
    kind: KIND_MAP[sym.kind],
    location: { uri: sym.uri, range: toLspRange(sym.nameRange) },
    containerName: sym.parentLabel,
  }));
}
