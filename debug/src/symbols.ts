// Resolves a source-level label (e.g. "argc" in "mov [argc], ecx") to the runtime address fasm2
// actually placed it at — the piece fasmg's own DWARF-less output has no equivalent of, so gdb
// can't answer "what's the address of argc" itself (there's no symbol table to ask).
//
// Built entirely from the same listing entries listingMap.ts already parses for address<->line
// correlation (each one is already an (address, reconstructed statement text) pair) — no second
// source read, no dependency on the language server's full symbolIndex. This deliberately mirrors
// listingMap.ts's own stated scope ("what would this line's listing text look like", not a full
// symbol index): "what identifier does this line define, and how many bytes wide is it" is the
// same kind of shallow, line-local question, just answered from the *listing* side instead of the
// source side.
//
// A definition's size is only ever reported when the line itself makes it unambiguous — a data
// directive (db/dw/dd/...) or an explicit "label NAME:size" — never guessed for a plain code
// label ("start:"), since interpreting arbitrary instruction bytes as a scalar value would mislead
// far more than it would help (see session.ts's use of this for exactly that "show the value, but
// only when we're sure what it is" distinction).
import { Token, TokenType, tokenizeLine, unquoteString } from '@fasm2-studio/server/src/parser/tokenizer';
import { ListingEntry } from './listingMap';

export interface DebugSymbol {
  name: string;
  address: bigint;
  /** Byte width of *one* element at this address, when determinable from its own definition line.
   * Undefined for a plain code label, or any form this lightweight scan doesn't recognize. */
  elementSizeBytes?: number;
  /** How many comma-separated values the definition line declared (e.g. "table dd 1,2,3,4" -> 4,
   * "buf rb 16" -> 16 from its count argument). Undefined when elementSizeBytes is also undefined,
   * or when a reserve directive's count isn't a plain literal this scan can read statically. A
   * value of 1 is an ordinary scalar, not an array. */
  elementCount?: number;
  /**
   * Set only for a 1-byte-element (db/rb) declaration that included at least one quoted string
   * literal — manual.txt's "Generating data": a string value always contributes its own literal
   * byte length to the output, regardless of the directive's nominal element width, which is what
   * makes a classic "msg db 'Hello world!',13,10,0" a text buffer rather than a numeric array.
   * This is the *total* combined byte length across every declared value (string literals at their
   * real length, any other value counted as 1 byte), so the whole buffer can be read back and
   * shown as text instead of just its first byte.
   */
  stringLengthBytes?: number;
}

// manual.txt's "Generating data"/"Source and output control" sections — every core data directive
// and its "reserve, uninitialized" counterpart, mapped to the byte width of one element.
const DATA_DIRECTIVE_SIZE_BYTES: Record<string, number> = {
  db: 1, dw: 2, dd: 4, dp: 6, df: 6, dq: 8, dt: 10, ddq: 16, dqq: 32, ddqq: 64, du: 2,
};
const RESERVE_DIRECTIVE_SIZE_BYTES: Record<string, number> = {
  rb: 1, rw: 2, rd: 4, rp: 6, rf: 6, rq: 8, rt: 10, rdq: 16, rqq: 32, rdqq: 64,
};

// manual.txt's built-in "label" size constants (byte/word/dword/...), for the explicit
// "label NAME:size" directive form.
const LABEL_SIZE_KEYWORD_BYTES: Record<string, number> = {
  byte: 1, word: 2, dword: 4, pword: 6, fword: 6, qword: 8, tbyte: 10, tword: 10,
  dqword: 16, xword: 16, qqword: 32, yword: 32, dqqword: 64, zword: 64,
};

/** Splits a data directive's argument tokens on top-level commas only — a comma inside a "dup
 * (...)" group's parentheses doesn't start a new element. Each returned group is one element's
 * worth of tokens (usually a single literal, but any expression is passed through as-is). */
function splitTopLevelCommas(tokens: Token[]): Token[][] {
  const groups: Token[][] = [];
  let current: Token[] = [];
  let depth = 0;
  for (const t of tokens) {
    if (t.type === TokenType.Punct && t.text === '(') depth++;
    else if (t.type === TokenType.Punct && t.text === ')') depth = Math.max(0, depth - 1);
    else if (t.type === TokenType.Punct && t.text === ',' && depth === 0) {
      groups.push(current);
      current = [];
      continue;
    }
    current.push(t);
  }
  if (current.length > 0 || groups.length > 0) groups.push(current);
  return groups.filter((g) => g.length > 0);
}

/** Analyzes a "db"-family value list for element count and (db/rb only) combined string length. */
function analyzeValueList(valueTokens: Token[], elementSizeBytes: number): { elementCount?: number; stringLengthBytes?: number } {
  const groups = splitTopLevelCommas(valueTokens);
  if (groups.length === 0) return {};

  const elementCount = groups.length;
  if (elementSizeBytes !== 1) return { elementCount };

  const hasString = groups.some((g) => g.length === 1 && g[0].type === TokenType.String);
  if (!hasString) return { elementCount };

  let stringLengthBytes = 0;
  for (const g of groups) {
    stringLengthBytes += g.length === 1 && g[0].type === TokenType.String ? unquoteString(g[0].text).length : elementSizeBytes;
  }
  return { elementCount, stringLengthBytes };
}

export function buildSymbolAddressMap(entries: readonly ListingEntry[]): Map<string, DebugSymbol> {
  const symbols = new Map<string, DebugSymbol>();

  for (const entry of entries) {
    const tokens = tokenizeLine(entry.text, 0).filter((t) => t.type !== TokenType.Comment);
    if (tokens.length === 0 || tokens[0].type !== TokenType.Ident) continue;
    const name = tokens[0].text;
    if (symbols.has(name)) continue; // first definition wins — later reuses of a name are ambiguous to a flat map

    // "label NAME[:size] [at expr]" — the fasmg "label" directive itself.
    if (name.toLowerCase() === 'label' && tokens[1]?.type === TokenType.Ident) {
      const labelName = tokens[1].text;
      if (symbols.has(labelName)) continue;
      let elementSizeBytes: number | undefined;
      if (tokens[2]?.type === TokenType.Punct && tokens[2].text === ':' && tokens[3]) {
        elementSizeBytes = LABEL_SIZE_KEYWORD_BYTES[tokens[3].text.toLowerCase()];
        if (elementSizeBytes === undefined && tokens[3].type === TokenType.Number) {
          const n = Number(tokens[3].text);
          if (Number.isFinite(n) && n > 0) elementSizeBytes = n;
        }
      }
      symbols.set(labelName, { name: labelName, address: entry.address, elementSizeBytes });
      continue;
    }

    if (tokens[1]?.type === TokenType.Ident) {
      const directive = tokens[1].text.toLowerCase();

      // "NAME db/dw/dd/... value[, value...]" — a real value list: count elements, detect strings.
      const dataSizeBytes = DATA_DIRECTIVE_SIZE_BYTES[directive];
      if (dataSizeBytes !== undefined) {
        const { elementCount, stringLengthBytes } = analyzeValueList(tokens.slice(2), dataSizeBytes);
        symbols.set(name, { name, address: entry.address, elementSizeBytes: dataSizeBytes, elementCount, stringLengthBytes });
        continue;
      }

      // "NAME rb/rw/rd/... count" — the argument is a *count*, not a value list (uninitialized
      // reserve). Only recognized as an element count when it's a plain integer literal; a
      // symbolic expression (e.g. "buf rb SIZE") can't be evaluated by this lightweight scan, so
      // it's left as an ordinary single-element scalar rather than guessed at.
      const reserveSizeBytes = RESERVE_DIRECTIVE_SIZE_BYTES[directive];
      if (reserveSizeBytes !== undefined) {
        let elementCount: number | undefined;
        if (tokens[2]?.type === TokenType.Number) {
          const n = Number(tokens[2].text);
          if (Number.isInteger(n) && n > 0) elementCount = n;
        }
        symbols.set(name, { name, address: entry.address, elementSizeBytes: reserveSizeBytes, elementCount });
        continue;
      }
    }

    // "NAME:" or "NAME::" — an ordinary or area code label. Address-only: no size to show.
    if (tokens[1]?.type === TokenType.Punct && tokens[1].text === ':') {
      symbols.set(name, { name, address: entry.address });
      continue;
    }
  }

  return symbols;
}

export interface ConstantSymbol {
  name: string;
  /** Parsed value, when the definition's right-hand side is a single, directly-parseable numeric
   * literal (decimal, "0x"/"0b"-prefixed, or an asm-style h/b/o-suffixed literal, digit separators
   * stripped). Undefined when the right-hand side is anything else — an expression referencing
   * other symbols, a string, a register — that this lightweight, non-evaluating scan can't
   * compute (fasmg's own preprocessor would; this doesn't reimplement it). */
  value?: bigint;
  /** The definition's own right-hand-side text, exactly as written — always available, shown
   * when `value` couldn't be parsed. */
  rawText: string;
  definedVia: '=' | ':=' | '=:' | 'equ' | 'reequ' | 'define' | 'redefine';
}

const BUILTIN_PSEUDO_VARIABLES: ReadonlySet<string> = new Set(['$', '$$', '$@', '$%', '$%%', '%', '%%']);

/** Parses a *source* numeric literal (not user-typed input — no wrapping/modulus, unlike
 * registers.ts's parseUserNumber) — decimal, "0x"/"0b"-prefixed, or an asm-style h/b/o-suffixed
 * literal, with fasmg's own digit separators ("'"/"_", manual.txt's "Fundamental syntax rules")
 * stripped first. Returns undefined for anything else (a float, an expression, ...). */
function parseSourceLiteral(text: string): bigint | undefined {
  const cleaned = text.replace(/[_']/g, '');
  if (/^0x[0-9a-f]+$/i.test(cleaned)) return BigInt(cleaned);
  if (/^0b[01]+$/i.test(cleaned)) return BigInt(cleaned);
  if (/^[0-9a-f]+h$/i.test(cleaned)) return BigInt(`0x${cleaned.slice(0, -1)}`);
  if (/^[01]+b$/i.test(cleaned)) return BigInt(`0b${cleaned.slice(0, -1)}`);
  if (/^[0-7]+o$/i.test(cleaned)) return BigInt(`0o${cleaned.slice(0, -1)}`);
  if (/^\d+d?$/i.test(cleaned)) return BigInt(cleaned.replace(/d$/i, ''));
  return undefined;
}

function addConstant(map: Map<string, ConstantSymbol>, name: string, valueTokens: Token[], definedVia: ConstantSymbol['definedVia']): void {
  if (BUILTIN_PSEUDO_VARIABLES.has(name) || map.has(name)) return; // first definition wins, same convention as buildSymbolAddressMap
  const rawText = valueTokens.map((t) => t.text).join(' ');

  let value: bigint | undefined;
  if (valueTokens.length === 1 && valueTokens[0].type === TokenType.Number) {
    value = parseSourceLiteral(valueTokens[0].text);
  } else if (valueTokens.length === 2 && valueTokens[0].type === TokenType.Punct && valueTokens[0].text === '-' && valueTokens[1].type === TokenType.Number) {
    const abs = parseSourceLiteral(valueTokens[1].text);
    value = abs === undefined ? undefined : -abs;
  }

  map.set(name, { name, value, rawText, definedVia });
}

/**
 * Resolves a symbolic constant (e.g. "FD_STDERR = 2" or "FD_STDOUT equ 1") to its defined value —
 * these have no runtime address at all (fasmg substitutes them at compile time; nothing is ever
 * generated for the definition line itself), so gdb has no way to answer "what's the value of
 * FD_STDERR" — asking it fails with "No symbol table is loaded", a raw gdb error that isn't
 * meaningful to someone debugging assembly. Resolving this ourselves, entirely from the listing
 * (mirroring server/src/parser/symbolIndex.ts's own token patterns for constant definitions —
 * see manual.txt's "Basic symbol definitions"), means hover/Watch never needs to ask gdb about a
 * constant at all.
 */
export function buildConstantMap(entries: readonly ListingEntry[]): Map<string, ConstantSymbol> {
  const constants = new Map<string, ConstantSymbol>();

  for (const entry of entries) {
    const tokens = tokenizeLine(entry.text, 0).filter((t) => t.type !== TokenType.Comment);
    if (tokens.length < 2 || tokens[0].type !== TokenType.Ident) continue;

    // ":=" and "=:" are two punctuation tokens each (the tokenizer never merges multi-char
    // operators) — only count as one when written with no space between them, matching how
    // fasmg itself requires no space in these operators.
    const isColonEquals = tokens[1].type === TokenType.Punct && tokens[1].text === ':' && tokens[2]?.type === TokenType.Punct && tokens[2].text === '=' && tokens[1].endChar === tokens[2].startChar;
    const isEqualsColon = tokens[1].type === TokenType.Punct && tokens[1].text === '=' && tokens[2]?.type === TokenType.Punct && tokens[2].text === ':' && tokens[1].endChar === tokens[2].startChar;
    const isPlainEquals = tokens[1].type === TokenType.Punct && tokens[1].text === '=' && !isEqualsColon;
    const lower1 = tokens[1].text.toLowerCase();
    const isEqu = lower1 === 'equ';
    const isReequ = lower1 === 'reequ';

    if (isColonEquals || isEqualsColon || isPlainEquals || isEqu || isReequ) {
      const definedVia: ConstantSymbol['definedVia'] = isColonEquals ? ':=' : isEqualsColon ? '=:' : isEqu ? 'equ' : isReequ ? 'reequ' : '=';
      const valueStart = isColonEquals || isEqualsColon ? 3 : 2;
      addConstant(constants, tokens[0].text, tokens.slice(valueStart), definedVia);
      continue;
    }

    // "define NAME expr" / "redefine NAME expr" — unlike every other form above, the *directive*
    // comes first and the name second (manual.txt: "define y -a").
    const lower0 = tokens[0].text.toLowerCase();
    if ((lower0 === 'define' || lower0 === 'redefine') && tokens[1].type === TokenType.Ident) {
      addConstant(constants, tokens[1].text, tokens.slice(2), lower0 as 'define' | 'redefine');
      continue;
    }
  }

  return constants;
}

/** Multi-line hover explanation for a resolved constant — see formatConstantCompact for the
 * single-line form used everywhere else (Watch/REPL/inline values). */
export function formatConstantDetailed(c: ConstantSymbol): string {
  const header = `${c.name}  (constant, defined via "${c.definedVia}")`;
  if (c.value === undefined) {
    return `${header}\ntext: ${c.rawText}  (not a plain number — this lightweight scan doesn't evaluate expressions)`;
  }
  const hex = c.value < 0n ? `-0x${(-c.value).toString(16)}` : `0x${c.value.toString(16)}`;
  return `${header}\nvalue = ${hex}  ${c.value.toString()}`;
}

export function formatConstantCompact(c: ConstantSymbol): string {
  if (c.value === undefined) return `(constant) ${c.rawText}`;
  const hex = c.value < 0n ? `-0x${(-c.value).toString(16)}` : `0x${c.value.toString(16)}`;
  return `${hex}  ${c.value.toString()}`;
}
