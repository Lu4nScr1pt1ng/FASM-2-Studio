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

export interface DirectiveEntry {
  name: string;
  summary: string;
  dialect: Dialect | 'both';
  snippet?: string;
}

/** A sub-keyword of "format"/"segment"/"section" (e.g. ELF64, executable, readable, DLL). */
export interface FormatKeywordEntry {
  name: string;
  summary: string;
}

/** An operand-size or addressing qualifier (e.g. byte, dword, ptr, near). */
export interface SizeSpecifierEntry {
  name: string;
  summary: string;
}
