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
// The grammar also cannot colour a *reference*. It can see `start:` and know it defines a label,
// but `jmp start`, `dd table` and `mov ecx, BUF_SIZE` are just identifiers in operand position --
// whether each one names a label, a constant, a struct or nothing at all is a question about the
// whole include graph, which is exactly what this server has already walked. Left to the grammar
// alone that operand mass is the single largest block of uncoloured text in a real file: over half
// the non-whitespace characters in fasmg's own packages/x86/projects/challenger/challenger.asm.
//
// Semantic tokens do not have either limitation. They are layered over the grammar's output by the
// editor, so anything not classified here keeps whatever colour the grammar gave it -- this only
// has to answer the questions the grammar cannot, not re-highlight the language from scratch.

import { SemanticTokens, SemanticTokensLegend } from 'vscode-languageserver/node';
import instructionsData from '../data/instructions.json';
import registersData from '../data/registers.json';
import { detectIsa } from '../isa';
import { Token, TokenType, tokenizeDocument } from '../parser/tokenizer';
import { Dialect, InstructionEntry, Range, RegisterEntry, SymbolKind } from '../types';
import { Workspace } from '../workspace';

/**
 * Token types, in the order the client will refer to them by index. All are standard types, chosen
 * so that a theme which knows nothing about assembly still renders them sensibly: `keyword` is what
 * mnemonics already look like under the grammar, `variable.defaultLibrary` is how themes render
 * built-in globals (a good match for a CPU register), `macro` distinguishes user-defined
 * instruction-like macros from the instruction set itself, and `function`/`property`/`struct` are
 * how every language's labels-as-callables, fields and type names are already coloured.
 *
 * `label` looks like the obvious type for a label and is deliberately not used: VS Code registers
 * it with no fallback scopes at all, so under any theme that doesn't name it explicitly -- which is
 * nearly all of them -- it renders with no colour whatsoever. `function` is what a label actually
 * behaves like anyway, and it is the scope family the grammar puts label definitions in.
 *
 * The first three entries must keep their positions: the client refers to types by index into this
 * array, so reordering them silently recolours every existing token.
 */
export const SEMANTIC_TOKEN_TYPES = ['keyword', 'variable', 'macro', 'function', 'property', 'struct'] as const;

/**
 * `declaration` is deliberately absent. VS Code ships fallback scopes for the `defaultLibrary` and
 * `readonly` modifiers but for no others, so a `declaration` modifier would be invisible under any
 * theme that doesn't style it by name -- and definition sites are already the one place the grammar
 * colours correctly on its own.
 */
export const SEMANTIC_TOKEN_MODIFIERS = ['defaultLibrary', 'readonly'] as const;

export const SEMANTIC_TOKENS_LEGEND: SemanticTokensLegend = {
  tokenTypes: [...SEMANTIC_TOKEN_TYPES],
  tokenModifiers: [...SEMANTIC_TOKEN_MODIFIERS],
};

const TYPE_KEYWORD = 0;
const TYPE_VARIABLE = 1;
const TYPE_MACRO = 2;
const TYPE_FUNCTION = 3;
const TYPE_PROPERTY = 4;
const TYPE_STRUCT = 5;
const MODIFIER_DEFAULT_LIBRARY = 1; // bit 0 of the modifier set
const MODIFIER_READONLY = 2; // bit 1

const x86Mnemonics: ReadonlySet<string> = new Set((instructionsData as InstructionEntry[]).map((i) => i.mnemonic.toLowerCase()));
const x86Registers: ReadonlySet<string> = new Set((registersData as RegisterEntry[]).map((r) => r.name.toLowerCase()));

interface Classification {
  type: number;
  modifiers: number;
  /**
   * Whether this only counts at the start of a statement. An instruction-like name is an
   * instruction only where an instruction can appear; a label, constant or field is most often
   * referenced as an operand, which is precisely where it must still be coloured.
   */
  statementOnly?: boolean;
}

/** A classification plus the slice of the identifier it applies to, since a qualified name like
 * `Point.x` names two different things and is one token to the tokenizer. */
interface Piece extends Classification {
  offset: number;
  length: number;
}

/**
 * Everything the current file's include graph defines, split into the categories worth colouring.
 * Built once per request rather than per token: a large project's graph runs to thousands of
 * symbols (13 279 for KolibriOS's kernel.asm, across 129 documents) and a document has thousands of
 * identifiers, so every lookup below has to be a set membership test and nothing more.
 */
interface ScopeIndex {
  /** Macro-like definitions — in fasmg an instruction *is* a macro, so this is the instruction set. */
  macros: Set<string>;
  /** `element` declarations, which is how instruction-set packages declare register names. */
  elements: Set<string>;
  labels: Set<string>;
  constants: Set<string>;
  structs: Set<string>;
  /** Struct fields under their qualified `Type.field` name, the form they are referenced by. */
  fields: Set<string>;
  /** Declared struct instances (`buf Point`), mapped to the struct type each one confirmed to. */
  instances: Map<string, string>;
}

/**
 * `macros` and `elements` are matched case-insensitively and the rest case-sensitively, which looks
 * inconsistent and is not. Instruction and register spellings are conventionally case-blind and
 * real code writes `MOV`/`Mov`/`mov` interchangeably, but fasmg symbols are genuinely
 * case-sensitive: folding label names would light up every `start` in a project merely because some
 * include happens to define `Start`, which is a different symbol the compiler would not resolve.
 */
function buildScopeIndex(workspace: Workspace, uri: string, dialect: Dialect): ScopeIndex {
  const index: ScopeIndex = {
    macros: new Set<string>(),
    elements: new Set<string>(),
    labels: new Set<string>(),
    constants: new Set<string>(),
    structs: new Set<string>(),
    fields: new Set<string>(),
    instances: new Map<string, string>(),
  };
  const candidateInstances: Array<{ name: string; typeName: string }> = [];

  for (const doc of workspace.walkIncludeGraph(uri, dialect)) {
    for (const sym of doc.symbols) {
      // A macro-local name is private to one macro body and must not colour the whole file.
      if (sym.localScope) continue;
      if (sym.kind === SymbolKind.Macro) index.macros.add(sym.name.toLowerCase());
      else if (sym.kind === SymbolKind.Struct) index.structs.add(sym.name);
      else if (sym.definedVia === 'element') index.elements.add(sym.name.toLowerCase());
      else if (sym.kind === SymbolKind.Constant) index.constants.add(sym.name);
      else if (sym.isStructField) {
        // Only the qualified form is useful from outside the struct, and it is the only one that
        // can't collide with an unrelated struct's field of the same name.
        if (sym.name.includes('.')) index.fields.add(sym.name);
      } else if (sym.kind === SymbolKind.Label) index.labels.add(sym.name);
    }
    for (const instance of doc.possibleInstances) candidateInstances.push(instance);
  }

  // `possibleInstances` are recorded unconditionally by the parser, because "name Type" and an
  // ordinary one-argument macro call are the same shape; only now, with every struct in the graph
  // known, can the real ones be told apart. Done as one pass afterwards rather than a query per
  // candidate, each of which would re-walk the whole graph.
  for (const instance of candidateInstances) {
    if (index.structs.has(instance.typeName)) index.instances.set(instance.name, instance.typeName);
  }
  return index;
}

/**
 * What the file being coloured defines itself, which outranks the include graph and the bundled
 * tables alike — the same carve-outs hover makes, for the same reason: a user's own `macro mov`
 * wrapper is unambiguously what they meant, and a `local` name is private to one macro body.
 */
interface DocIndex {
  /** This document's own non-local, non-field definitions. */
  ownKinds: Map<string, Classification>;
  /** `local` declarations, with the macro body each one is confined to. */
  localsByName: Map<string, Range[]>;
  /** Global label -> the local labels declared under it. */
  localLabelsByParent: Map<string, Set<string>>;
  /** This document's own struct fields, under their bare in-struct name. */
  fieldNames: Set<string>;
  /** Every global label's declaration line, ascending, for resolving `.local` references. */
  globalLabelLines: Array<{ line: number; name: string }>;
}

function classificationForKind(kind: SymbolKind, definedVia: string | undefined): Classification | undefined {
  if (kind === SymbolKind.Macro) return { type: TYPE_MACRO, modifiers: 0, statementOnly: true };
  if (kind === SymbolKind.Struct) return { type: TYPE_STRUCT, modifiers: 0 };
  if (kind === SymbolKind.Label) return { type: TYPE_FUNCTION, modifiers: 0 };
  if (kind === SymbolKind.Constant) {
    if (definedVia === 'element') return { type: TYPE_VARIABLE, modifiers: MODIFIER_DEFAULT_LIBRARY };
    return { type: TYPE_VARIABLE, modifiers: MODIFIER_READONLY };
  }
  return undefined;
}

function buildDocIndex(workspace: Workspace, uri: string): DocIndex {
  const index: DocIndex = {
    ownKinds: new Map<string, Classification>(),
    localsByName: new Map<string, Range[]>(),
    localLabelsByParent: new Map<string, Set<string>>(),
    fieldNames: new Set<string>(),
    globalLabelLines: [],
  };

  for (const sym of workspace.getDocument(uri)?.symbols ?? []) {
    if (sym.localScope) {
      const ranges = index.localsByName.get(sym.name) ?? [];
      ranges.push(sym.localScope);
      index.localsByName.set(sym.name, ranges);
      continue;
    }
    if (sym.kind === SymbolKind.LocalLabel) {
      if (!sym.parentLabel) continue;
      const siblings = index.localLabelsByParent.get(sym.parentLabel) ?? new Set<string>();
      siblings.add(sym.name);
      index.localLabelsByParent.set(sym.parentLabel, siblings);
      continue;
    }
    if (sym.isStructField) {
      if (!sym.name.includes('.')) index.fieldNames.add(sym.name);
      continue;
    }
    if (sym.kind === SymbolKind.Label) index.globalLabelLines.push({ line: sym.nameRange.startLine, name: sym.name });
    const classification = classificationForKind(sym.kind, sym.definedVia);
    if (classification && !index.ownKinds.has(sym.name)) index.ownKinds.set(sym.name, classification);
  }

  index.globalLabelLines.sort((a, b) => a.line - b.line);
  return index;
}

/** Whether `line` falls inside any of the macro bodies `name` was declared `local` in. */
function isLocalInScopeAt(doc: DocIndex, name: string, line: number): boolean {
  const ranges = doc.localsByName.get(name);
  return ranges !== undefined && ranges.some((r) => line >= r.startLine && line <= r.endLine);
}

/**
 * Decides what an identifier is, in the same precedence order hover uses, so the colour a token
 * gets always agrees with the explanation hovering it produces: an in-scope `local` first, then a
 * struct field, then this document's own definitions, then the include graph, and only then the
 * bundled x86 tables. The graph's macros and elements stay ahead of those tables, as they always
 * have — in a file whose graph brings its own instruction set, they are the instruction set.
 *
 * `enclosingLabel` is the global label the reference sits under, which is the whole scope a
 * `.local` name has.
 */
function classify(word: string, isa: 'x86' | 'foreign', scope: ScopeIndex, doc: DocIndex, line: number, enclosingLabel: string | undefined): Piece[] {
  const lower = word.toLowerCase();
  const whole = (c: Classification | undefined): Piece[] => (c ? [{ ...c, offset: 0, length: word.length }] : []);

  // fasmg gives every macro invocation a fresh, private instance of each `local` name, so one of
  // these outranks even the instruction set: `local neg` then `neg = mode` (fasmg's own
  // packages/x86/include/macro/if.inc) uses `neg` as a value, not the NEG instruction.
  if (isLocalInScopeAt(doc, word, line)) return whole({ type: TYPE_VARIABLE, modifiers: 0 });

  // A struct field can never mean anything else, so it outranks a directive or register of the
  // same spelling — challenger.asm really does have fields named "segment" and "offset".
  if (doc.fieldNames.has(word)) return whole({ type: TYPE_PROPERTY, modifiers: 0 });

  const own = doc.ownKinds.get(word);
  if (own) return whole(own);

  // The file's own instruction set always wins over the bundled tables: in a non-x86 file these are
  // the only real mnemonics, and in an x86 file a package-defined macro of the same name is what
  // actually runs.
  if (scope.macros.has(lower)) {
    const builtIn = isa === 'x86' && x86Mnemonics.has(lower);
    return whole({ type: builtIn ? TYPE_KEYWORD : TYPE_MACRO, modifiers: builtIn ? MODIFIER_DEFAULT_LIBRARY : 0, statementOnly: true });
  }
  if (scope.elements.has(lower)) return whole({ type: TYPE_VARIABLE, modifiers: MODIFIER_DEFAULT_LIBRARY });

  // The bundled x86 tables are a fallback for the common case where the instruction set is
  // preloaded on the command line and so invisible in the source. They must not apply to a file
  // whose graph brings its own instruction set — that is the whole point of this provider.
  if (isa === 'x86') {
    if (x86Mnemonics.has(lower)) return whole({ type: TYPE_KEYWORD, modifiers: MODIFIER_DEFAULT_LIBRARY, statementOnly: true });
    if (x86Registers.has(lower)) return whole({ type: TYPE_VARIABLE, modifiers: MODIFIER_DEFAULT_LIBRARY });
  }

  if (scope.labels.has(word)) return whole({ type: TYPE_FUNCTION, modifiers: 0 });
  if (scope.constants.has(word)) return whole({ type: TYPE_VARIABLE, modifiers: MODIFIER_READONLY });
  if (scope.structs.has(word)) return whole({ type: TYPE_STRUCT, modifiers: 0 });
  // A confirmed struct instance is an ordinary variable, and has to be coloured as one on the line
  // that declares it too — `buf Point` otherwise sat uncoloured right above the `buf.x` that this
  // same index resolves.
  if (scope.instances.has(word)) return whole({ type: TYPE_VARIABLE, modifiers: 0 });

  // Everything below is a qualified name. The tokenizer treats "." as an identifier character, so
  // ".exit", "start.exit" and "Point.x" each arrive here as a single token to be taken apart.
  if (!word.includes('.')) return [];

  // ".name" — a local label, valid only under the global label it was declared beneath. Colouring
  // one under a different parent would be a claim the compiler wouldn't honour.
  if (word.startsWith('.')) {
    if (enclosingLabel && doc.localLabelsByParent.get(enclosingLabel)?.has(word)) return whole({ type: TYPE_FUNCTION, modifiers: 0 });
    return [];
  }

  // "parent.name" — the same local label written in full, which is how it is referenced from
  // under a different parent.
  const firstDot = word.indexOf('.');
  const parent = word.slice(0, firstDot);
  if (scope.labels.has(parent) && doc.localLabelsByParent.get(parent)?.has(word.slice(firstDot))) {
    return whole({ type: TYPE_FUNCTION, modifiers: 0 });
  }

  // "Type.field" / "instance.field" — two things in one token, so two tokens come back out.
  const lastDot = word.lastIndexOf('.');
  const prefix = word.slice(0, lastDot);
  const tail = word.slice(lastDot + 1);
  const split = (prefixType: number): Piece[] => [
    { type: prefixType, modifiers: 0, offset: 0, length: prefix.length },
    { type: TYPE_PROPERTY, modifiers: 0, offset: lastDot + 1, length: tail.length },
  ];
  if (scope.structs.has(prefix) && scope.fields.has(word)) return split(TYPE_STRUCT);
  const instanceType = scope.instances.get(prefix);
  if (instanceType && scope.fields.has(`${instanceType}.${tail}`)) return split(TYPE_VARIABLE);

  return [];
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
  const doc = buildDocIndex(workspace, uri);

  const data: number[] = [];
  let lastLine = 0;
  let lastChar = 0;

  // LSP encodes each token relative to the previous one: five integers per token, with the
  // character offset relative to the line start only when the line changed. Kept in one place
  // because a single identifier can now emit two tokens, and getting the running position wrong
  // between them corrupts every token after it.
  const emit = (line: number, startChar: number, length: number, type: number, modifiers: number): void => {
    const deltaLine = line - lastLine;
    const deltaStart = deltaLine === 0 ? startChar - lastChar : startChar;
    data.push(deltaLine, deltaStart, length, type, modifiers);
    lastLine = line;
    lastChar = startChar;
  };

  // The global label a line sits under. Lines arrive in ascending order, so this only ever moves
  // forward — one cursor, rather than a search per token.
  let labelCursor = 0;
  let enclosingLabel: string | undefined;

  for (const line of tokenizeDocument(text)) {
    const tokens = line.filter((t) => t.type !== TokenType.Comment);
    if (tokens.length) {
      while (labelCursor < doc.globalLabelLines.length && doc.globalLabelLines[labelCursor].line <= tokens[0].line) {
        enclosingLabel = doc.globalLabelLines[labelCursor].name;
        labelCursor++;
      }
    }

    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      if (token.type !== TokenType.Ident) continue;

      const pieces = classify(token.text, isa, scope, doc, token.line, enclosingLabel);
      for (const piece of pieces) {
        if (piece.statementOnly && !isInstructionPosition(tokens, i)) continue;
        emit(token.line, token.startChar + piece.offset, piece.length, piece.type, piece.modifiers);
      }
    }
  }

  return { data };
}
