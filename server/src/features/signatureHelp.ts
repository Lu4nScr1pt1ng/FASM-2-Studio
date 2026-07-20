import { ParameterInformation, SignatureHelp, SignatureInformation } from 'vscode-languageserver/node';
import instructionsData from '../data/instructions.json';
import { Dialect, InstructionEntry, SymbolKind } from '../types';
import { Workspace } from '../workspace';

const instructions = instructionsData as InstructionEntry[];

const IDENT_RE = /[A-Za-z_.@$?][A-Za-z0-9_.@$?]*/;

/**
 * Splits a comma-separated parameter/argument list on only its top-level commas — i.e. not ones
 * nested inside (), [], {} or a quoted string. A single forward pass with a depth counter and a
 * quote-state flag; O(n) in the length of the (always short, single-line) text with no
 * backtracking, so it's cheap to re-run on every keystroke while the user is typing a call.
 */
function splitTopLevelCommas(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | undefined;
  let start = 0;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
    } else if (ch === '(' || ch === '[' || ch === '{') {
      depth++;
    } else if (ch === ')' || ch === ']' || ch === '}') {
      depth = Math.max(0, depth - 1);
    } else if (ch === ',' && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

/** How many top-level commas precede the cursor — i.e. the 0-based index of the argument the
 * cursor is currently sitting in. */
function activeParameterIndex(textBeforeCursor: string): number {
  return Math.max(0, splitTopLevelCommas(textBeforeCursor).length - 1);
}

function findCalleeName(lineBeforeCursor: string): { name: string; argsText: string } | undefined {
  const match = IDENT_RE.exec(lineBeforeCursor.trimStart());
  if (!match) return undefined;
  const name = match[0];
  const afterName = lineBeforeCursor.slice(lineBeforeCursor.indexOf(name) + name.length);
  return { name, argsText: afterName };
}

function findMacro(workspace: Workspace, uri: string, dialect: Dialect, name: string) {
  for (const doc of workspace.walkIncludeGraph(uri, dialect)) {
    const macro = doc.symbols.find((s) => s.kind === SymbolKind.Macro && s.name === name);
    if (macro) return macro;
  }
  // Not reachable via this file's own `include` chain — still show the signature (e.g. a shared
  // macro lib the user hasn't included yet) rather than falling all the way back to "unknown".
  return workspace.findSymbolAnywhere(name).find((s) => s.kind === SymbolKind.Macro);
}

export function getSignatureHelp(workspace: Workspace, uri: string, dialect: Dialect, lineBeforeCursor: string): SignatureHelp | undefined {
  const callee = findCalleeName(lineBeforeCursor);
  if (!callee) return undefined;

  const activeParameter = activeParameterIndex(callee.argsText);

  const macro = findMacro(workspace, uri, dialect, callee.name);
  if (macro && macro.params) {
    const paramLabels = splitTopLevelCommas(macro.params).map((p) => p.trim());
    const signature: SignatureInformation = {
      label: `${macro.name} ${paramLabels.join(', ')}`,
      parameters: paramLabels.map((p): ParameterInformation => ({ label: p })),
    };
    return { signatures: [signature], activeSignature: 0, activeParameter };
  }

  const ins = instructions.find((i) => i.mnemonic.toLowerCase() === callee.name.toLowerCase());
  if (ins && ins.operands) {
    const paramLabels = ins.operands.split(',').map((p) => p.trim());
    const signature: SignatureInformation = {
      label: `${ins.mnemonic} ${ins.operands}`,
      documentation: ins.summary,
      parameters: paramLabels.map((p): ParameterInformation => ({ label: p })),
    };
    return { signatures: [signature], activeSignature: 0, activeParameter };
  }

  return undefined;
}
