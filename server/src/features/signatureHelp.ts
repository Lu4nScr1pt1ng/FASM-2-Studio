import { ParameterInformation, SignatureHelp, SignatureInformation } from 'vscode-languageserver/node';
import instructionsData from '../data/instructions.json';
import { detectIsa } from '../isa';
import { Dialect, InstructionEntry, SymbolKind } from '../types';
import { Workspace } from '../workspace';

const instructions = instructionsData as InstructionEntry[];

// Signature help re-fires on every typed character of an argument list — look mnemonics up by Map
// instead of re-scanning the ~1300-entry instruction array each time. First entry per mnemonic
// wins, matching the Array.find this replaces.
const instructionByMnemonic = new Map<string, InstructionEntry>();
for (const ins of instructions) {
  const key = ins.mnemonic.toLowerCase();
  if (!instructionByMnemonic.has(key)) instructionByMnemonic.set(key, ins);
}

const IDENT_RE = /[A-Za-z_.@$?][A-Za-z0-9_.@$?]*/;

interface ArgumentScan {
  /** The argument list split on its top-level commas. Always at least one element. */
  parts: string[];
  /** Bracket nesting depth at the end of the text: above zero, the cursor is inside a group. */
  depth: number;
  /** Whether the text ends inside an unterminated quoted string. */
  inQuote: boolean;
}

/**
 * Splits a comma-separated parameter/argument list on only its top-level commas — i.e. not ones
 * nested inside (), [], {}, <> or a quoted string — and reports whether the text ends inside such
 * a group. "<" and ">" are tracked alongside the other bracket pairs because manual.txt section 8
 * documents them as fasmg's own way to pass a single macro argument that itself contains a comma
 * ("data example, <'abc',10>" is two arguments, not three) — without this, the cursor sitting
 * inside such a group counted as a later parameter than it really is. A single forward pass with a
 * depth counter and a quote-state flag; O(n) in the length of the (always short, single-line) text
 * with no backtracking, so it's cheap to re-run on every keystroke while the user is typing a call.
 */
function scanArgumentList(text: string): ArgumentScan {
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
    } else if (ch === '(' || ch === '[' || ch === '{' || ch === '<') {
      depth++;
    } else if (ch === ')' || ch === ']' || ch === '}' || ch === '>') {
      depth = Math.max(0, depth - 1);
    } else if (ch === ',' && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return { parts, depth, inQuote: quote !== undefined };
}

function splitTopLevelCommas(text: string): string[] {
  return scanArgumentList(text).parts;
}

/** How many top-level commas precede the cursor — i.e. the 0-based index of the argument the
 * cursor is currently sitting in. */
function activeParameterIndex(textBeforeCursor: string): number {
  return Math.max(0, splitTopLevelCommas(textBeforeCursor).length - 1);
}

/**
 * Where this line's `;` comment begins, or -1. Quoted text is skipped, since a semicolon inside a
 * string is an ordinary character rather than the start of a comment.
 */
function commentStart(line: string): number {
  let quote: string | undefined;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === "'" || ch === '"') quote = ch;
    else if (ch === ';') return i;
  }
  return -1;
}

/**
 * Operators an unfinished argument can end on. An operand left dangling after one ("dd 1 + ",
 * "mov rax, ';' + ") is mid-expression however much whitespace follows it. The word forms are
 * fasm's own spellings for the bitwise operators.
 */
const TRAILING_OPERATOR_RE = /(?:[-+*/%&|^~<>=:!]|\b(?:and|or|xor|not|shl|shr|mod|rva)\b)$/i;

/**
 * Whether the cursor sits in whitespace that follows an argument the user has finished writing.
 * fasmg separates arguments with commas, so a space after a complete argument does not begin the
 * next one — there is nothing left for the signature to point at. This is what keeps the box shut
 * for the alignment padding assembly is written with ("test rax, rax        ") and for anywhere
 * further along a line whose operands are already spelled out. Space being one of the trigger
 * characters, without this every space typed anywhere on the line re-opened it.
 *
 * Whitespace inside a bracketed group or a string is still part of the argument being written, so
 * an unclosed one means the cursor has not left it.
 */
function cursorIsPastAnArgument(argsText: string): boolean {
  const scan = scanArgumentList(argsText);
  if (scan.depth > 0 || scan.inQuote) return false;
  const current = scan.parts[scan.parts.length - 1];
  if (!/\s$/.test(current)) return false;
  const written = current.trimEnd();
  return written.trim().length > 0 && !TRAILING_OPERATOR_RE.test(written);
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
  // Past a `;` the rest of the line is prose, not a call being written, however well-formed the
  // code before it reads.
  if (commentStart(lineBeforeCursor) !== -1) return undefined;

  for (const callee of findCalleeCandidates(lineBeforeCursor)) {
    if (cursorIsPastAnArgument(callee.argsText)) continue;

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

    // Reached only when no macro of this name is in scope, or one is but declares no parameters.
    // Gated on the ISA for the same reason as hover/completion: in a file whose include graph
    // brings its own instruction set, x86's operand list for a coincidentally-shared spelling
    // describes a different instruction on a different CPU.
    const ins = detectIsa(workspace, uri, dialect) === 'x86' ? instructionByMnemonic.get(callee.name.toLowerCase()) : undefined;
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
