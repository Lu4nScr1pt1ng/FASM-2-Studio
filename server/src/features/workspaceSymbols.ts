import { SymbolInformation } from 'vscode-languageserver/node';
import { toLspRange } from '../lspUtils';
import { Workspace } from '../workspace';
import { SYMBOL_KIND_MAP } from './symbolKindMap';

export function getWorkspaceSymbols(workspace: Workspace, query: string): SymbolInformation[] {
  // Same defensive filter as documentSymbols.ts — VS Code's client-side validation rejects a
  // falsy name outright and fails the whole request over a single bad entry.
  return workspace
    .findWorkspaceSymbols(query)
    .filter((sym) => sym.name)
    .map((sym) => ({
      name: sym.name,
      kind: SYMBOL_KIND_MAP[sym.kind],
      location: { uri: sym.uri, range: toLspRange(sym.nameRange) },
      containerName: sym.parentLabel,
    }));
}
