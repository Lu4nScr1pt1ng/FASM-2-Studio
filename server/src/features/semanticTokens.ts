// ISA-aware syntax colouring.
//
// The TextMate grammar cannot do this job. It matches one file at a time with no knowledge of what
// that file includes, but in fasmg an identifier's meaning depends entirely on which instruction-set
// package is in scope: `bl` is a register in x86 and a branch-with-link instruction in aarch64,
// `at` is a core directive in both, and `mov` is a different instruction on every CPU that has one.
// A grammar can only pick one answer for the whole language, so the shipped one commits to x86 --
// which is right for the overwhelming majority of files and wrong for the rest, with no way to tell
// them apart.
//
// Semantic tokens do not have that limitation: the server has already walked the include graph, so
// it knows what this particular file's instruction set actually is. These tokens are layered over
// the grammar's output by the editor, so anything not classified here keeps whatever colour the
// grammar gave it -- this only has to correct the cases the grammar cannot know about, not
// re-highlight the language from scratch.

import { SemanticTokens, SemanticTokensLegend } from 'vscode-languageserver/node';
import instructionsData from '../data/instructions.json';
import registersData from '../data/registers.json';
import { detectIsa } from '../isa';
import { Token, TokenType, tokenizeDocument } from '../parser/tokenizer';
import { Dialect, InstructionEntry, RegisterEntry, SymbolKind } from '../types';
import { Workspace } from '../workspace';

/**
 * Token types, in the order the client will refer to them by index. Chosen so that a theme which
 * knows nothing about assembly still renders them sensibly: `keyword` is what mnemonics already
 * look like under the grammar, `variable.defaultLibrary` is how themes render built-in globals
 * (a good match for a CPU register), and `macro` distinguishes user-defined instruction-like
 * macros from the instruction set itself.
 */
export const SEMANTIC_TOKEN_TYPES = ['keyword', 'variable', 'macro'] as const;
export const SEMANTIC_TOKEN_MODIFIERS = ['defaultLibrary'] as const;

export const SEMANTIC_TOKENS_LEGEND: SemanticTokensLegend = {
  tokenTypes: [...SEMANTIC_TOKEN_TYPES],
  tokenModifiers: [...SEMANTIC_TOKEN_MODIFIERS],
};

const TYPE_KEYWORD = 0;
const TYPE_VARIABLE = 1;
const TYPE_MACRO = 2;
const MODIFIER_DEFAULT_LIBRARY = 1; // bit 0 of the modifier set

const x86Mnemonics: ReadonlySet<string> = new Set((instructionsData as InstructionEntry[]).map((i) => i.mnemonic.toLowerCase()));
const x86Registers: ReadonlySet<string> = new Set((registersData as RegisterEntry[]).map((r) => r.name.toLowerCase()));

interface Classification {
  type: number;
  modifiers: number;
}

/**
 * Everything the current file's include graph defines, split into the two categories worth
 * colouring. Built once per request rather than per token: a large project's graph runs to
 * thousands of symbols, and a document has thousands of identifiers.
 */
interface ScopeIndex {
  /** Macro-like definitions — in fasmg an instruction *is* a macro, so this is the instruction set. */
  macros: Set<string>;
  /** `element` declarations, which is how instruction-set packages declare register names. */
  elements: Set<string>;
}

function buildScopeIndex(workspace: Workspace, uri: string, dialect: Dialect): ScopeIndex {
  const macros = new Set<string>();
  const elements = new Set<string>();

  for (const doc of workspace.walkIncludeGraph(uri, dialect)) {
    for (const sym of doc.symbols) {
      // A macro-local name is private to one macro body and must not colour the whole file.
      if (sym.localScope) continue;
      if (sym.kind === SymbolKind.Macro) macros.add(sym.name.toLowerCase());
      else if (sym.definedVia === 'element') elements.add(sym.name.toLowerCase());
    }
  }
  return { macros, elements };
}

/**
 * Decides what an identifier is, in the same precedence order hover uses, so the colour a token
 * gets always agrees with the explanation hovering it produces.
 */
function classify(word: string, isa: 'x86' | 'foreign', scope: ScopeIndex): Classification | undefined {
  const lower = word.toLowerCase();

  // The file's own instruction set always wins: in a non-x86 file these are the only real
  // mnemonics, and in an x86 file a package-defined macro of the same name is what actually runs.
  if (scope.macros.has(lower)) {
    const builtIn = isa === 'x86' && x86Mnemonics.has(lower);
    return { type: builtIn ? TYPE_KEYWORD : TYPE_MACRO, modifiers: builtIn ? MODIFIER_DEFAULT_LIBRARY : 0 };
  }
  if (scope.elements.has(lower)) return { type: TYPE_VARIABLE, modifiers: MODIFIER_DEFAULT_LIBRARY };

  // The bundled x86 tables are a fallback for the common case where the instruction set is
  // preloaded on the command line and so invisible in the source. They must not apply to a file
  // whose graph brings its own instruction set — that is the whole point of this provider.
  if (isa === 'x86') {
    if (x86Mnemonics.has(lower)) return { type: TYPE_KEYWORD, modifiers: MODIFIER_DEFAULT_LIBRARY };
    if (x86Registers.has(lower)) return { type: TYPE_VARIABLE, modifiers: MODIFIER_DEFAULT_LIBRARY };
  }
  return undefined;
}

/**
 * Whether `token` sits where an instruction can appear — either first on the line, or immediately
 * after a label. Mnemonics are only coloured in that position so that a name used as an ordinary
 * operand (aarch64's `mov x0, add_handler`, or a data label spelled like an instruction) is not
 * lit up as an instruction where it plainly is not one.
 */
function isInstructionPosition(line: Token[], index: number): boolean {
  if (index === 0) return true;
  const prev = line[index - 1];
  // "label: mnemonic ..." — the colon ends the label, so what follows starts a statement.
  return prev.type === TokenType.Punct && prev.text === ':';
}

export function getSemanticTokens(workspace: Workspace, uri: string, dialect: Dialect, text: string): SemanticTokens {
  const isa = detectIsa(workspace, uri, dialect);
  const scope = buildScopeIndex(workspace, uri, dialect);

  const data: number[] = [];
  let lastLine = 0;
  let lastChar = 0;

  for (const line of tokenizeDocument(text)) {
    const tokens = line.filter((t) => t.type !== TokenType.Comment);
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      if (token.type !== TokenType.Ident) continue;

      const classification = classify(token.text, isa, scope);
      if (!classification) continue;
      // Registers and other operands may appear anywhere; instruction-like names only count in
      // statement position.
      if (classification.type !== TYPE_VARIABLE && !isInstructionPosition(tokens, i)) continue;

      // LSP encodes each token relative to the previous one: five integers per token, with the
      // character offset relative to the line start only when the line changed.
      const deltaLine = token.line - lastLine;
      const deltaStart = deltaLine === 0 ? token.startChar - lastChar : token.startChar;
      data.push(deltaLine, deltaStart, token.endChar - token.startChar, classification.type, classification.modifiers);
      lastLine = token.line;
      lastChar = token.startChar;
    }
  }

  return { data };
}
