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
  /** Raw value expression for constants (right-hand side of the operator/directive in definedVia). */
  value?: string;
  /**
   * How a constant was defined:
   * - "="        stored, evaluated value; discards any previous value.
   * - ":="       like "=", but the symbol must be defined exactly once (safe to forward-reference).
   * - "=:"       like "=", but preserves the previous value, restorable with `restore`.
   * - "equ"      textual substitution, re-substituted unevaluated at every use; preserves the
   *              previous value like "=:".
   * - "reequ"    like "equ", but discards the previous value like "=".
   * - "define"   textual substitution like "equ", but does not evaluate symbolic variables in the
   *              text; preserves the previous value.
   * - "redefine" like "define", but discards the previous value like "reequ"/"=".
   * Undefined for non-constant symbol kinds.
   */
  definedVia?: '=' | ':=' | '=:' | 'equ' | 'reequ' | 'define' | 'redefine' | 'load';
  /**
   * Set for a label declared with "::" instead of ":" — a special "area label" fasmg uses only to
   * address `load`'s alternate addressing mode (`load NAME:size from AREA_LABEL:offset`), which
   * can read bytes generated later in the very same area (unlike plain-address `load`, restricted
   * to bytes already emitted). Its own value isn't meant to be used directly like an ordinary
   * label's. Only meaningful for SymbolKind.Label.
   */
  isAreaLabel?: boolean;
  /**
   * Set for a label declared inside a `struct ... ends` body (a field). Checked ahead of
   * context-free lookups (directives, instructions) in hover: a field literally named "segment"
   * or "offset" (both real field names in fasmg's own packages/x86/projects/challenger/
   * challenger.asm) would otherwise always resolve to the unrelated directive/register of the
   * same spelling instead of the field itself.
   */
  isStructField?: boolean;
  /**
   * Set when this symbol was declared via `local` inside a macro body — fasmg gives every macro
   * invocation a fresh, hygienic instance of each `local` name, so e.g. `value` declared this way
   * in one macro is a completely different, private variable from `value` declared the same way
   * in another macro (a very common idiom — 8051.inc alone declares "value" as a macro-local in
   * 40 different, unrelated macros). This is the line range of the enclosing `macro ... end
   * macro` block, used to resolve a reference to the *one* local actually in scope at the query
   * position instead of an arbitrary same-named local from a different macro entirely.
   */
  localScope?: Range;
  /** For macros: the name was written with a trailing "?" (e.g. `macro foo?`), marking it
   * weak/overridable — it can be redefined later without a "symbol already defined" error, the
   * standard convention for macro packages meant to tolerate being `include`d more than once. */
  isWeak?: boolean;
  /** For macros: the name was written with a trailing "!" (e.g. `macro endp?!`), marking it
   * unconditional — evaluated even inside a suspended (false) conditional block or another
   * macro's own definition, e.g. so an "endp" can close an "if"/"macro" a "proc" left open. */
  isUnconditional?: boolean;
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
