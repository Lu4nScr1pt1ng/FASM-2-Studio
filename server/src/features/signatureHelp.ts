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

/**
 * Returns the possible callee-name readings of the line, in priority order: the ordinary "NAME
 * args" call shape first, then — since a "struc"-defined labeled instruction (including "struct"'s
 * own instances, e.g. "wc WNDCLASS") is invoked as "LABEL struc-name args", not a plain call — the
 * second identifier, treating the first as a label. Without the second reading, signature help for
 * a labeled instruction's own parameters (a real, if less common, case per manual.txt section 9)
 * never triggers at all, since the first token ("LABEL") is never a real macro name.
 */
function findCalleeCandidates(lineBeforeCursor: string): Array<{ name: string; argsText: string }> {
  const first = IDENT_RE.exec(lineBeforeCursor.trimStart());
  if (!first) return [];
  const name = first[0];
  const afterName = lineBeforeCursor.slice(lineBeforeCursor.indexOf(name) + name.length);
  const candidates = [{ name, argsText: afterName }];

  const second = IDENT_RE.exec(afterName.trimStart());
  if (second) {
    const afterSecond = afterName.slice(afterName.indexOf(second[0]) + second[0].length);
    candidates.push({ name: second[0], argsText: afterSecond });
  }
  return candidates;
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
  for (const callee of findCalleeCandidates(lineBeforeCursor)) {
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
  }

  return undefined;
}
