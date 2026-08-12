// Column-aligning formatter for fasm source.
//
// Formatting assembly is a place to be conservative, because a formatter that "tidies" hand-laid-
// out code is worse than none: assembly is one of the few languages where the visual column of an
// operand is load-bearing to the person reading it. So this does exactly one thing — put labels,
// mnemonics, operands and trailing comments in consistent columns — and never:
//
//   - reorders, inserts, removes or rewrites a single token;
//   - touches the inside of a string literal;
//   - changes a line it cannot confidently parse (it is returned verbatim);
//   - changes blank lines, or lines that are only a comment (a banner comment block keeps the
//     indentation its author gave it).
//
// Everything is driven by the real tokenizer, which is what makes the "never touch a string" rule
// hold: `db 'a ; b'` has no comment in it, and a regex-based formatter reliably gets that wrong.

import { Token, TokenType, tokenizeLine } from '../parser/tokenizer';

export interface FormatOptions {
  /** Column the mnemonic/directive is aligned to. 0 disables mnemonic alignment. */
  mnemonicColumn: number;
  /** Column operands are aligned to. 0 means "one space after the mnemonic". */
  operandColumn: number;
  /** Column a trailing `;` comment is aligned to. 0 means "leave it one space after the code". */
  commentColumn: number;
  /** Indent one level with this many spaces when a tab is not being used. */
  useTabs: boolean;
  tabSize: number;
}

export const DEFAULT_FORMAT_OPTIONS: FormatOptions = {
  mnemonicColumn: 8,
  operandColumn: 16,
  commentColumn: 0,
  useTabs: false,
  tabSize: 4,
};

/**
 * Statement keywords that open a block, and the ones that close it. Only used to decide *indent
 * depth*; nothing here changes the tokens themselves. Kept deliberately in step with
 * foldingRange.ts, which derives structure from the same keywords.
 */
const BLOCK_OPENERS = new Set([
  'macro',
  'virtual',
  'if',
  'while',
  'repeat',
  'rept',
  'iterate',
  'irp',
  'irpv',
  'namespace',
  'calminstruction',
  'match',
  'rmatch',
  'rawmatch',
  'postpone',
  'struct',
  'struc',
  'union',
  'proc',
]);

const BLOCK_CLOSERS = new Set(['ends', 'endp']);

/**
 * Statement keywords that sit at the indent column rather than the mnemonic column.
 *
 * Assembly's near-universal layout is "structure on the left, instructions indented": a `format`
 * or a `macro` starts at the margin, and the code inside it is stepped in. Sending every statement
 * to the mnemonic column instead puts a `struct` keyword to the *right* of its own fields' labels,
 * which reads backwards.
 *
 * Deliberately a short, explicit list of things that really are structural, rather than everything
 * in the directive tables: `db`/`dd` and friends belong with the code they sit among, and a macro
 * that happens to share a name with some minor directive should not be pulled to the margin.
 */
const MARGIN_KEYWORDS = new Set([
  ...BLOCK_OPENERS,
  ...BLOCK_CLOSERS,
  'end',
  'else',
  'format',
  'entry',
  'include',
  'org',
  'section',
  'segment',
  'public',
  'extrn',
  'use',
  'use16',
  'use32',
  'use64',
  'label',
  'assert',
  'purge',
  'restore',
]);

/**
 * Directives that, appearing as the *second* token, prove the first one was a label rather than a
 * mnemonic — fasm lets a data label be written with no colon at all, and `msg db 'hi',0` is how
 * essentially every data section is written. Without this the first token reads as the mnemonic
 * and `db` as its operand, which lays a data section out quite differently from the code above it.
 *
 * A closed set of real fasm directives, so this can never misread an ordinary
 * "mnemonic operand" line: no instruction takes a bare `db`/`equ` as its first operand.
 */
const DATA_DIRECTIVES = new Set([
  'db',
  'dw',
  'dd',
  'dp',
  'dq',
  'dt',
  'ddq',
  'du',
  'file',
  'rb',
  'rw',
  'rd',
  'rp',
  'rq',
  'rt',
  'equ',
  'reequ',
  'define',
  'redefine',
  'load',
  'store',
  'element',
]);

/** A label is anything the assembler treats as one: `name:`, `name::`, or a `label name` line. */
interface LineShape {
  /** `name:` including the colon(s), or undefined. */
  label?: string;
  /** The statement keyword/mnemonic, or undefined for a label-only line. */
  mnemonic?: string;
  /** Everything between the mnemonic and any trailing comment, verbatim from the source. */
  operands?: string;
  /** The trailing comment including its `;`, or undefined. */
  comment?: string;
  /** True when this line is blank or contains only a comment — never reformatted. */
  verbatim: boolean;
}

/** Reads one line's shape from its tokens, or marks it verbatim when it isn't safely reformattable. */
export function lineShape(text: string): LineShape {
  const tokens = tokenizeLine(text, 0);
  if (tokens.length === 0) return { verbatim: true };

  const comment = tokens[tokens.length - 1].type === TokenType.Comment ? tokens[tokens.length - 1] : undefined;
  const code = comment ? tokens.slice(0, -1) : tokens;
  // A comment-only line keeps whatever indentation its author chose: these are section banners and
  // explanations, and pushing them to a code column is exactly the kind of "help" that makes a
  // formatter untrustworthy.
  if (code.length === 0) return { verbatim: true };

  const isPunct = (token: Token | undefined, text_: string): boolean => token?.type === TokenType.Punct && token.text === text_;

  let index = 0;
  let label: string | undefined;
  if (code[0].type === TokenType.Ident) {
    if (isPunct(code[1], ':')) {
      // "name:" — and "name::", fasmg's area label, which tokenizes as two separate ':' tokens.
      const doubled = isPunct(code[2], ':');
      label = `${code[0].text}${doubled ? '::' : ':'}`;
      index = doubled ? 3 : 2;
    } else if (code[1]?.type === TokenType.Ident && DATA_DIRECTIVES.has(code[1].text.toLowerCase())) {
      // A colon-less data label: "msg db 'hi', 0" — how essentially every fasm data section is
      // written. Without this the label reads as the mnemonic and `db` as its operand.
      label = code[0].text;
      index = 1;
    } else if (isPunct(code[1], '=')) {
      // "NAME = value", and "NAME =: value" — a definition target, not a mnemonic.
      label = code[0].text;
      index = 1;
    }
  }

  if (index >= code.length) {
    return { label, comment: comment?.text, verbatim: label === undefined };
  }

  // The mnemonic slot: an identifier, or one of the assignment operators that follows a bare name
  // ("=", ":=", "=:"). Anything else starting a statement is something this formatter does not
  // understand well enough to move, so the line is left exactly as written.
  const mnemonicToken = code[index];
  let mnemonic: string;
  let operandTokenIndex: number;
  if (mnemonicToken.type === TokenType.Ident) {
    mnemonic = mnemonicToken.text;
    operandTokenIndex = index + 1;
  } else if (isPunct(mnemonicToken, '=') || isPunct(mnemonicToken, ':')) {
    const paired = isPunct(code[index + 1], '=') || isPunct(code[index + 1], ':');
    mnemonic = paired ? `${mnemonicToken.text}${code[index + 1].text}` : mnemonicToken.text;
    operandTokenIndex = paired ? index + 2 : index + 1;
  } else {
    return { verbatim: true };
  }

  const operandStart = code[operandTokenIndex]?.startChar;
  const operandEnd = code[code.length - 1].endChar;
  const operands = operandStart !== undefined ? text.slice(operandStart, operandEnd).trimEnd() : undefined;

  return { label, mnemonic, operands, comment: comment?.text, verbatim: false };
}

/**
 * The column the cursor sits at after `text`, counting a tab as advancing to the next tab stop.
 * Needed because indentation may be tabs while column alignment is spaces (the conventional "tabs
 * to indent, spaces to align" arrangement) — measuring a tab as one character would misalign every
 * line that used one.
 */
export function visualWidth(text: string, tabSize: number): number {
  let width = 0;
  for (const ch of text) {
    width = ch === '\t' ? (Math.floor(width / tabSize) + 1) * tabSize : width + 1;
  }
  return width;
}

/** Pads `line` out to `column`, or adds a single space when it is already at or past it. */
function padTo(line: string, column: number, tabSize: number): string {
  const width = visualWidth(line, tabSize);
  return width < column ? line + ' '.repeat(column - width) : `${line} `;
}

function indentText(depth: number, options: FormatOptions): string {
  if (depth <= 0) return '';
  return options.useTabs ? '\t'.repeat(depth) : ' '.repeat(depth * options.tabSize);
}

/**
 * Whether a statement keyword opens or closes a block, for indent purposes. `end <keyword>` and
 * the dedicated closers dedent; `else` does both.
 */
function depthDelta(mnemonic: string | undefined, operands: string | undefined): { before: number; after: number } {
  if (!mnemonic) return { before: 0, after: 0 };
  const keyword = mnemonic.toLowerCase();
  const second = operands ? /^([A-Za-z_][A-Za-z0-9_]*)/.exec(operands.trim())?.[1]?.toLowerCase() : undefined;

  if (keyword === 'end' && second !== undefined && (BLOCK_OPENERS.has(second) || second === 'match')) return { before: -1, after: 0 };
  if (BLOCK_CLOSERS.has(keyword)) return { before: -1, after: 0 };
  if (keyword === 'else') return { before: -1, after: 1 };
  if (BLOCK_OPENERS.has(keyword)) return { before: 0, after: 1 };
  return { before: 0, after: 0 };
}

/**
 * Formats one already-shaped line at `depth`.
 *
 * The configured columns are measured *from the indent*, not from column zero. Absolute columns
 * would make indentation invisible the moment it was smaller than the mnemonic column: a `push`
 * inside a macro body and a `push` at top level would both land in column 8, so nesting would show
 * nowhere in the output.
 */
function renderLine(shape: LineShape, depth: number, options: FormatOptions): string {
  const indent = indentText(depth, options);
  const base = visualWidth(indent, options.tabSize);
  let out = indent + (shape.label ?? '');

  if (shape.mnemonic) {
    // A structural keyword stays at the margin; an instruction goes to the mnemonic column. A
    // label always wins over both — "start: mov" keeps the mnemonic after the label either way.
    const atMargin = shape.label === undefined && MARGIN_KEYWORDS.has(shape.mnemonic.toLowerCase());
    // A label long enough to overrun the mnemonic column pushes the mnemonic one space to its
    // right rather than onto a line of its own — moving code between lines is well beyond what a
    // formatter this conservative should do.
    out = atMargin || options.mnemonicColumn <= 0 ? (shape.label ? `${out} ` : out) : padTo(out, base + options.mnemonicColumn, options.tabSize);
    out += shape.mnemonic;

    if (shape.operands) {
      // A structural keyword's operand follows after a single space. Column-aligning it would
      // stretch `format`/`entry`/`macro` lines across the page to line up with instruction
      // operands they have nothing to do with, and those keywords vary too much in length for the
      // alignment to buy anything anyway.
      out = atMargin || options.operandColumn <= 0 ? `${out} ` : padTo(out, base + options.operandColumn, options.tabSize);
      out += shape.operands;
    }
  }

  if (shape.comment) {
    // The comment column is deliberately absolute: trailing comments read as a column down the
    // right-hand side of the file, and stepping them in and out with the code's nesting would
    // defeat the point of aligning them at all.
    out = options.commentColumn > 0 ? padTo(out, options.commentColumn, options.tabSize) : `${out} `;
    out += shape.comment;
  }

  return out.trimEnd();
}

/**
 * The line ending `text` already uses, so formatting never silently rewrites them. Real fasm
 * sources are frequently CRLF — fasmg's own examples and tetros.asm among them — and a formatter
 * that quietly converted a 339-line file to LF would show up as a 339-line diff in which every
 * actual change was invisible.
 */
export function detectEol(text: string): string {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/\n/g) ?? []).length - crlf;
  return crlf > lf ? '\r\n' : '\n';
}

/**
 * Formats `text`, returning one output line per input line (so a caller can map them back to
 * ranges). Line endings are the caller's concern — see detectEol.
 */
export function formatLines(text: string, options: FormatOptions = DEFAULT_FORMAT_OPTIONS): string[] {
  const lines = text.split(/\r\n|\r|\n/);
  const out: string[] = [];
  let depth = 0;

  for (const line of lines) {
    const shape = lineShape(line);
    if (shape.verbatim) {
      // Blank lines are normalized to genuinely empty (trailing whitespace on an otherwise empty
      // line is invisible noise); everything else verbatim is passed through untouched.
      out.push(line.trim() === '' ? '' : line.trimEnd());
      continue;
    }

    const delta = depthDelta(shape.mnemonic, shape.operands);
    depth = Math.max(0, depth + delta.before);
    out.push(renderLine(shape, depth, options));
    depth = Math.max(0, depth + delta.after);
  }

  return out;
}
