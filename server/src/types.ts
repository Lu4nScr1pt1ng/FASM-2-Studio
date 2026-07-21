export type Dialect = 'fasm2' | 'fasm1';

export enum SymbolKind {
  Label = 'label',
  LocalLabel = 'localLabel',
  Constant = 'constant',
  Macro = 'macro',
  Struct = 'struct',
  Section = 'section',
}

export interface Range {
  startLine: number;
  startChar: number;
  endLine: number;
  endChar: number;
}

export interface SymbolDefinition {
  name: string;
  kind: SymbolKind;
  range: Range;
  /** Range of just the name token, for hover/rename targeting. */
  nameRange: Range;
  /** For macros/structs: raw parameter list as written, e.g. "dest*,src*". */
  params?: string;
  /** Parent global label for local labels (dot-prefixed). */
  parentLabel?: string;
  /** Raw value expression for constants (right-hand side of = or equ). */
  value?: string;
  /** How a constant was defined — "=" is a stored, evaluated value; "equ" is textual substitution
   * (the expression is re-substituted, unevaluated, at every place the name is used). Undefined
   * for non-constant symbol kinds. */
  definedVia?: '=' | 'equ';
  /** URI of the document this symbol was defined in. */
  uri: string;
}

export interface SymbolReference {
  name: string;
  range: Range;
  uri: string;
}

export interface IncludeDirective {
  /** The literal path as written in the source, e.g. 'win64a.inc'. */
  path: string;
  range: Range;
  uri: string;
}

export interface ParsedDocument {
  uri: string;
  version: number;
  dialect: Dialect;
  symbols: SymbolDefinition[];
  references: SymbolReference[];
  includes: IncludeDirective[];
  /** format/use directives found at top level, useful for diagnostics context and hover. */
  formatDirective?: string;
  /**
   * Whether a top-level `org`/`section` directive appears in this file. fasmg doesn't require a
   * `format` directive at all for flat-binary output — `org 100h` alone is a complete, directly
   * assemblable program (see fasmg's own core/examples/x86/hello.asm) — so this is a second,
   * independent signal (alongside formatDirective) that a file is its own entry point rather than
   * a fragment meant only to be `include`d.
   */
  hasTopLevelOrg?: boolean;
}

export interface InstructionEntry {
  mnemonic: string;
  summary: string;
  operands?: string;
  isa?: string;
}

export interface RegisterEntry {
  name: string;
  group: string;
  bits: number;
}

/** One general-purpose register's sub-width aliases (e.g. al/ax/eax/rax) plus its calling-
 * convention role — shown on hover regardless of which width the cursor is actually on. */
export interface RegisterFamilyEntry {
  widths: Partial<Record<'8' | '16' | '32' | '64', string>>;
  /** Legacy 8-bit high-byte view (ah/bh/ch/dh) — only al/bl/cl/dl have one. */
  highByte?: string;
  role: string;
}

export interface DirectiveEntry {
  name: string;
  summary: string;
  dialect: Dialect | 'both';
  snippet?: string;
}

/** A sub-keyword of "format"/"segment"/"section" (e.g. ELF64, executable, readable, DLL). */
export interface FormatKeywordEntry {
  name: string;
  /** What this keyword actually is, e.g. "output format", "PE subsystem", "ELF segment attribute" —
   * shown as the hover's tag instead of one generic label for all 30-odd keywords in this file. */
  category: string;
  summary: string;
}

/** An operand-size or addressing qualifier (e.g. byte, dword, ptr, near). */
export interface SizeSpecifierEntry {
  name: string;
  /** "size" for byte/word/dword/... vs "addressing" for ptr/near/far/short — two genuinely
   * different concepts this file groups together under one type. */
  kind: 'size' | 'addressing';
  summary: string;
}
