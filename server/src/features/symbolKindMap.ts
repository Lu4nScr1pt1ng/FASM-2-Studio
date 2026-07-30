import { SymbolKind as LspSymbolKind } from 'vscode-languageserver/node';
import { SymbolKind } from '../types';

/** Shared by documentSymbols.ts and workspaceSymbols.ts — both report the same parser
 * SymbolKind against the same LSP SymbolKind vocabulary, so there's exactly one right mapping. */
export const SYMBOL_KIND_MAP: Record<SymbolKind, LspSymbolKind> = {
  [SymbolKind.Label]: LspSymbolKind.Function,
  [SymbolKind.LocalLabel]: LspSymbolKind.Field,
  [SymbolKind.Constant]: LspSymbolKind.Constant,
  [SymbolKind.Macro]: LspSymbolKind.Method,
  [SymbolKind.Struct]: LspSymbolKind.Struct,
  [SymbolKind.Section]: LspSymbolKind.Namespace,
};
