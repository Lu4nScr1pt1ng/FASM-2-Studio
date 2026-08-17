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
//     indentation its author gave it — the one exception is a comment continuing the trailing
//     comment directly above it, which travels with the column it is part of);
//   - moves a comment left of the column its author aligned it to, when that column still clears
//     the code.
//
// Everything is driven by the real tokenizer, which is what makes the "never touch a string" rule
// hold: `db 'a ; b'` has no comment in it, and a regex-based formatter reliably gets that wrong.

import { Token, TokenType, tokenizeLine } from '../parser/tokenizer';

export interface FormatOptions {
  /** Column the mnemonic/directive is aligned to. 0 disables mnemonic alignment. */
  mnemonicColumn: number;
  /** Column operands are aligned to. 0 means "one space after the mnemonic". */
  operandColumn: number;
  /** Column a trailing `;` comment is aligned to. 0 aligns each run of commented lines together. */
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
  'irps',
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
  // fasm 1's PE/COFF `data import` ... `end data`. A colon-less data label (`data dd 0`) is read as
  // a label before this is ever consulted, so this only fires on a real `data <section>` header.
  'data',
]);

// `endif` is not fasm syntax at all: it is the alias (`endif equ end if`) that fasm 1 projects
// coming from MASM/TASM habits define for themselves, in 74 files of KolibriOS alone. Treating it
// as what it always is spares those files the alternative — every `if` in them read as a block
// nothing closes, and the nesting their author wrote flattened out of the file.
const BLOCK_CLOSERS = new Set(['ends', 'endp', 'endif']);

/** What `end <keyword>`, `ends`, `endp` and `endif` are each allowed to close. */
const DEDICATED_CLOSERS: Record<string, ReadonlySet<string>> = {
  ends: new Set(['struct', 'struc', 'union']),
  endp: new Set(['proc']),
  endif: new Set(['if']),
};

/** Guards a pathological file (deeply nested, generated, or unbalanced) from unbounded indent. */
const MAX_NESTING = 64;

/** One open block: the keyword that opened it, and whether `}` rather than `end` will close it. */
interface Frame {
  keyword: string;
  brace: boolean;
  /** The line it was opened on, so an opener nothing ever closes can be identified afterwards. */
  line: number;
}

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

/**
 * Directives whose first operand may itself begin with `=`, which in fasmg's match family means
 * "the literal token that follows". Without them listed here, `match =dup? value, definitions` —
 * ordinary fasmg, straight out of fasm2's own dd.inc — reads as the definition of a symbol called
 * `match`, and lays the line out as one.
 */
const MATCH_DIRECTIVES = new Set(['match', 'rmatch', 'rawmatch']);

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
  /** Where the trailing comment's `;` sits in the source line, so its column can be honoured. */
  commentStart?: number;
  /** True when the line is not a statement this formatter reads: blank, a comment on its own, or
   *  something it could not parse confidently enough to move. */
  verbatim: boolean;
  /** True for a blank line or a line holding nothing but a comment. */
  bodyless: boolean;
  /** True when the line ends in `\`, so the *next* line is a continuation of this statement. */
  continues: boolean;
  /** How `{`/`}` in this line's code move the block depth: `dip` is how far below its starting
   *  level the running depth goes (the closers this line begins with), `rise` how far above that
   *  low point the line ends up. */
  braceDip: number;
  braceRise: number;
  /** How many `{` the line has at all — a block both opened and closed here has none left open. */
  braceOpens: number;
  /** True when the line's first code token is `{` (or fasm 1's escaped `\{`), which is how a block
   *  body written on the line after its keyword begins. */
  opensFirst: boolean;
  /** Set when the line's entire code is one brace — fasm 1 writes a macro body's `{`/`}` this way,
   *  possibly escaped as `\{`/`\}` inside an enclosing macro. */
  soleBrace?: { text: string; open: boolean };
}

/** Reads one line's shape from its tokens, or marks it verbatim when it isn't safely reformattable. */
export function lineShape(text: string): LineShape {
  const tokens = tokenizeLine(text, 0);
  const commentToken = tokens.length > 0 && tokens[tokens.length - 1].type === TokenType.Comment ? tokens[tokens.length - 1] : undefined;
  const code = commentToken ? tokens.slice(0, -1) : tokens;

  // Braces are read off the token stream so a `}` inside a string or a comment cannot move the
  // indent, and are collected for *every* line — a lone `}` is not a statement this formatter
  // reshapes, but it still ends a block, and a formatter that missed that would indent the whole
  // rest of the file one level deeper for each fasm 1 macro in it.
  let running = 0;
  let dip = 0;
  let opens = 0;
  for (const token of code) {
    if (token.type !== TokenType.Punct) continue;
    if (token.text === '{') {
      running++;
      opens++;
    } else if (token.text === '}') {
      running--;
      dip = Math.min(dip, running);
    }
  }
  const last = code[code.length - 1];
  const first = code[0]?.type === TokenType.Punct && code[0].text === '\\' ? code[1] : code[0];
  const structure = {
    braceDip: dip === 0 ? 0 : -dip,
    braceRise: running - dip,
    braceOpens: opens,
    opensFirst: first?.type === TokenType.Punct && first.text === '{',
    continues: last?.type === TokenType.Punct && last.text === '\\',
    soleBrace: soleBraceOf(code),
  };

  // A comment-only line keeps whatever indentation its author chose: these are section banners and
  // explanations, and pushing them to a code column is exactly the kind of "help" that makes a
  // formatter untrustworthy. (formatLines makes one narrow exception, for a comment continuing the
  // trailing comment on the line above.)
  if (code.length === 0) {
    return { comment: commentToken?.text, commentStart: commentToken?.startChar, verbatim: true, bodyless: true, ...structure };
  }

  // Even a line this formatter will not reshape keeps its comment available: a lone `}` is
  // re-indented, and its trailing comment travels with it.
  const verbatim = { comment: commentToken?.text, commentStart: commentToken?.startChar, verbatim: true, bodyless: false, ...structure };
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
    } else if (isPunct(code[1], '=') && !MATCH_DIRECTIVES.has(code[0].text.toLowerCase())) {
      // "NAME = value", and "NAME =: value" — a definition target, not a mnemonic.
      label = code[0].text;
      index = 1;
    }
  }

  if (index >= code.length) {
    return label === undefined
      ? verbatim
      : { label, comment: commentToken?.text, commentStart: commentToken?.startChar, verbatim: false, bodyless: false, ...structure };
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
    return verbatim;
  }

  const operandStart = code[operandTokenIndex]?.startChar;
  const operandEnd = code[code.length - 1].endChar;
  const operands = operandStart !== undefined ? text.slice(operandStart, operandEnd).trimEnd() : undefined;

  return {
    label,
    mnemonic,
    operands,
    comment: commentToken?.text,
    commentStart: commentToken?.startChar,
    verbatim: false,
    bodyless: false,
    ...structure,
  };
}

/** A line whose whole code is `{`, `}`, `\{` or `\}` — how fasm 1 delimits a macro body. */
function soleBraceOf(code: Token[]): { text: string; open: boolean } | undefined {
  const brace = code[code.length - 1];
  if (code.length > 2 || brace?.type !== TokenType.Punct) return undefined;
  if (brace.text !== '{' && brace.text !== '}') return undefined;
  // The escape form, `\{`, appears wherever one macro defines another.
  const escape = code.length === 2 ? code[0] : undefined;
  if (code.length === 2 && !(escape?.type === TokenType.Punct && escape.text === '\\')) return undefined;
  return { text: (escape ? '\\' : '') + brace.text, open: brace.text === '{' };
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
 * Tracks how deep in blocks each line sits.
 *
 * fasm has two block syntaxes and both are in daily use: fasmg's `macro` ... `end macro`, and
 * fasm 1's `macro name {` ... `}` (which fasmg accepts too). A `{` can also open the body on the
 * line *after* its keyword, which is how much of fasm 1's own include tree is written:
 *
 *     macro stdcall proc,[arg]
 *     {
 *         ...
 *     }
 *
 * so a keyword block that then meets its `{` must not count twice. Counting both would deepen the
 * indent by one level for every macro in the file and never give it back — on fasm 1's own
 * proc32.inc that ran to 144 columns of leading whitespace.
 */
class BlockNesting {
  /** One entry per open block, innermost last. `brace` marks the ones that `}` closes. */
  private readonly frames: Frame[] = [];
  /** A keyword block still waiting to find out whether its body is brace-delimited. */
  private pendingBrace: Frame | undefined;
  /** The frame index of the innermost `calminstruction`, whose body is not block-structured. */
  private calmAt: number | undefined;
  /** Lines that opened a block nothing ever closed — see `openersToIgnore`. */
  private readonly unclosed = new Set<number>();

  /** @param ignore lines whose block openers to disregard, from a previous survey of the file. */
  constructor(private readonly ignore: ReadonlySet<number> = new Set()) {}

  /**
   * The lines whose openers turned out to open nothing: still on the stack at the end of the file,
   * or discarded because a closer matched something further out.
   *
   * Every file has some of these, and they are never a block this formatter understood: a fasm 1
   * project that writes `endif equ end if`, a MASM-syntax header that came along for the ride, a
   * macro pair a project invented (`function` ... `endf`), a fragment meant to be included inside
   * a construct it never opens. Indenting the rest of the file on the strength of one of those is
   * how a formatter turns a whole file into a diff — KolibriOS' uFMOD reached 288 columns that
   * way. Running the survey first and then disregarding those openers keeps a misreading local to
   * the line it happened on.
   */
  openersToIgnore(): ReadonlySet<number> {
    for (const frame of this.frames) this.unclosed.add(frame.line);
    return this.unclosed;
  }

  /** True inside a `calminstruction` body, where the keywords are flat instructions rather than
   *  blocks — calm's own `match`/`take`/`local` open nothing and have no `end`. */
  private get calm(): boolean {
    return this.calmAt !== undefined;
  }

  /**
   * Accounts for one statement line and reports where to render it: `depth` indent levels in, and
   * whether it sits in a context where structural keywords are just instructions.
   *
   * Blank and comment-only lines are not passed here at all, so a comment between `macro` and its
   * `{` does not break the pairing of the two.
   */
  place(shape: LineShape, line: number): { depth: number; flat: boolean } {
    const calmBefore = this.calm;

    // Leading `}`s close their blocks before this line is placed, so the closer itself lands at the
    // depth of the code it closes rather than one level inside it.
    this.closeBraces(shape.braceDip);

    const keyword = shape.mnemonic?.toLowerCase();
    const second = shape.operands ? /^([A-Za-z_][A-Za-z0-9_]*)/.exec(shape.operands.trim())?.[1]?.toLowerCase() : undefined;
    // Inside a calm body only its own `end calminstruction` carries block meaning.
    const structural = !this.calm || (keyword === 'end' && second === 'calminstruction');

    if (structural && keyword === 'end' && second !== undefined) {
      this.popKeyword((open) => open === second || (second === 'match' && (open === 'rmatch' || open === 'rawmatch')));
    } else if (structural && keyword !== undefined && BLOCK_CLOSERS.has(keyword)) {
      this.popKeyword((open) => DEDICATED_CLOSERS[keyword].has(open));
    }

    // `else` belongs to the `if` it splits: rendered one level out, without closing anything.
    const depth = structural && keyword === 'else' ? Math.max(0, this.frames.length - 1) : this.frames.length;
    // A lone `{` opening the body of the keyword block just above is that block's own delimiter,
    // not a level of its own, so it renders at the block's depth — as its `}` will.
    const merges = this.pendingBrace !== undefined && shape.opensFirst;
    const placed = merges && shape.soleBrace ? Math.max(0, depth - 1) : depth;

    this.openBraces(shape, structural ? keyword : undefined, line);
    // A keyword is at the margin only if it is structural on both sides of itself: the
    // `calminstruction` header and its `end` are, the instructions between them are not.
    return { depth: placed, flat: calmBefore && this.calm };
  }

  /** Accounts for a line's braces without reading it as a statement — a continuation line, or one
   *  whose shape this formatter does not recognize. */
  track(shape: LineShape, line: number): void {
    this.closeBraces(shape.braceDip);
    this.openBraces(shape, undefined, line);
  }

  private openBraces(shape: LineShape, keyword: string | undefined, line: number): void {
    let rise = shape.braceRise;
    if (this.pendingBrace !== undefined && shape.opensFirst) {
      // The block above found its body: `}` closes it now, and this `{` costs no extra level.
      this.pendingBrace.brace = true;
      rise--;
    }
    this.pendingBrace = undefined;

    if (keyword !== undefined && BLOCK_OPENERS.has(keyword)) {
      if (rise > 0) {
        // fasm 1 style, "macro m {": the brace *is* this block's body, so it costs one level, not
        // two — and it is `}`, not `end macro`, that will close it.
        rise--;
        this.push({ keyword, brace: true, line });
      } else if (shape.braceOpens > 0) {
        // Opened and closed on the one line ("rept 4 { db 0 }"): nothing stays open.
        rise = 0;
      } else {
        // fasmg style, closed by `end <keyword>` — unless the next line turns out to be its `{`.
        this.pendingBrace = this.push({ keyword, brace: false, line });
      }
    }

    for (let i = 0; i < rise; i++) this.push({ keyword: '{', brace: true, line });
  }

  private push(frame: Frame): Frame | undefined {
    if (this.ignore.has(frame.line)) return undefined;
    if (this.frames.length >= MAX_NESTING) {
      // Past the guard nothing is tracked, so the survey must report these openers as ones it
      // could not follow — otherwise the second pass, with room on the stack again, would indent
      // on exactly the openers the first pass had to drop.
      this.unclosed.add(frame.line);
      return undefined;
    }
    this.frames.push(frame);
    if (frame.keyword === 'calminstruction' && this.calmAt === undefined) this.calmAt = this.frames.length - 1;
    return frame;
  }

  private closeBraces(count: number): void {
    for (let i = 0; i < count; i++) this.popBrace();
  }

  private popBrace(): void {
    this.popFrom(this.lastIndex((frame) => frame.brace));
  }

  private popKeyword(matches: (keyword: string) => boolean): void {
    this.popFrom(this.lastIndex((frame) => matches(frame.keyword)));
  }

  /**
   * Drops the matched block and anything left open inside it. Discarding the inner frames is what
   * keeps one unbalanced construct — fasmg's own proc64.inc opens a `virtual` that only a later,
   * separate macro closes — from deepening every line for the rest of the file.
   */
  private popFrom(index: number): void {
    if (index < 0) return;
    for (let i = index + 1; i < this.frames.length; i++) this.unclosed.add(this.frames[i].line);
    this.frames.length = index;
    this.pendingBrace = undefined;
    if (this.calmAt !== undefined && this.calmAt >= index) this.calmAt = undefined;
  }

  private lastIndex(matches: (frame: Frame) => boolean): number {
    for (let i = this.frames.length - 1; i >= 0; i--) if (matches(this.frames[i])) return i;
    return -1;
  }
}

/**
 * Formats one already-shaped line's code at `depth`, without its trailing comment (which is placed
 * afterwards, in company with the comments around it).
 *
 * The configured columns are measured *from the indent*, not from column zero. Absolute columns
 * would make indentation invisible the moment it was smaller than the mnemonic column: a `push`
 * inside a macro body and a `push` at top level would both land in column 8, so nesting would show
 * nowhere in the output.
 */
function renderCode(shape: LineShape, depth: number, options: FormatOptions, flat: boolean): string {
  const indent = indentText(depth, options);
  const base = visualWidth(indent, options.tabSize);
  let out = indent + (shape.label ?? '');

  if (shape.mnemonic) {
    // A structural keyword stays at the margin; an instruction goes to the mnemonic column. A
    // label always wins over both — "start: mov" keeps the mnemonic after the label either way.
    // Inside a `calminstruction` nothing is structural: its body is a flat instruction list.
    const atMargin = shape.label === undefined && !flat && MARGIN_KEYWORDS.has(shape.mnemonic.toLowerCase());
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

  return out.trimEnd();
}

/**
 * One output line, before its trailing comment has been placed.
 *
 * `breaks` marks the lines that end a run of comment alignment: a blank line, or anything this
 * formatter passed through untouched. A code line without a comment does not break the run — it is
 * ordinary for a couple of uncommented instructions to sit inside a commented passage, and
 * splitting the column there would step the comments in and out for no reason a reader can see.
 */
interface Placed {
  text: string;
  comment?: string;
  /** The comment's column in the *source*, so an author's alignment can be preserved. */
  sourceColumn: number;
  breaks: boolean;
  /** A comment-only line, alignable only when it continues the comment directly above it. */
  note: boolean;
}

/**
 * The column a run of trailing comments should share.
 *
 * The column an author aligned their comments to is kept whenever it still clears the code, because
 * it is information: 32 is not an accident, and re-flowing a carefully laid-out file to some other
 * column produces a diff in which every real change is invisible. Only when the code has outgrown
 * that column does the run move, to the next tab stop past the longest line in it.
 */
function commentTarget(members: Placed[], options: FormatOptions): number {
  let fits = 1;
  const counts = new Map<number, number>();
  for (const member of members) {
    if (!member.note) fits = Math.max(fits, visualWidth(member.text, options.tabSize) + 1);
    counts.set(member.sourceColumn, (counts.get(member.sourceColumn) ?? 0) + 1);
  }

  // The run's own prevailing column, which is what the author was aligning to; ties go to the
  // leftmost, so a stray comment further right pulls nothing along with it.
  let authored = 0;
  let best = 0;
  for (const [column, count] of [...counts].sort((a, b) => a[0] - b[0])) {
    if (count > best) {
      authored = column;
      best = count;
    }
  }
  if (authored >= fits) return authored;

  const step = Math.max(1, options.tabSize);
  return Math.ceil(fits / step) * step;
}

/** Places every trailing comment, aligning each run of them to one column. */
function alignComments(placed: Placed[], options: FormatOptions): string[] {
  for (let i = 0; i < placed.length; i++) {
    if (placed[i].comment === undefined || placed[i].note) continue;

    // The run: commented code lines, the uncommented code lines between them, and any comment-only
    // line that continues the comment above it at exactly its column (the second and third lines of
    // a wrapped trailing comment, which belong to the column, not to the margin).
    const members = [placed[i]];
    let column = placed[i].sourceColumn;
    let end = i + 1;
    for (; end < placed.length; end++) {
      const next = placed[end];
      if (next.note) {
        if (next.comment === undefined || next.sourceColumn !== column) break;
      } else if (next.breaks) break;
      if (next.comment === undefined) continue;
      members.push(next);
      column = next.sourceColumn;
    }

    const target = options.commentColumn > 0 ? options.commentColumn : commentTarget(members, options);
    for (const member of members) {
      // A continuation comment's own indentation is only ever padding towards the column it is
      // part of, so it is rebuilt rather than padded further.
      member.text = padTo(member.note ? '' : member.text, target, options.tabSize) + member.comment;
      member.comment = undefined;
    }
    i = end - 1;
  }

  return placed.map((line) => line.text.trimEnd());
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
  const shapes = lines.map(lineShape);

  // Walked twice: the first pass only finds out which of the file's block openers are ever closed,
  // so the second can lay the file out knowing which ones meant anything. The lines are tokenized
  // once and both passes share the shapes.
  const survey = new BlockNesting();
  walkBlocks(shapes, survey);
  const placements = walkBlocks(shapes, new BlockNesting(survey.openersToIgnore()));

  const placed: Placed[] = shapes.map((shape, index) => {
    const line = lines[index];
    const sourceColumn = shape.commentStart === undefined ? 0 : visualWidth(line.slice(0, shape.commentStart), options.tabSize);
    const placement = placements[index];

    if (placement === undefined) {
      // Passed through untouched: a blank line, a comment on its own, a continuation line, or a
      // statement this formatter could not read. A comment-only line still offers up its comment,
      // in case alignComments finds it to be the continuation of the trailing comment above it.
      const note = shape.bodyless && shape.comment !== undefined;
      return { text: line.trim() === '' ? '' : line.trimEnd(), comment: note ? shape.comment : undefined, sourceColumn, breaks: !note, note };
    }

    // A lone brace is structure rather than code to guess at, so it is re-indented to the level it
    // opens or closes even though the rest of a punctuation-led line never would be.
    const text = shape.soleBrace
      ? indentText(placement.depth, options) + shape.soleBrace.text
      : renderCode(shape, placement.depth, options, placement.flat);
    return { text, comment: shape.comment, sourceColumn, breaks: false, note: false };
  });

  return alignComments(placed, options);
}

/** Where each line sits in the file's block structure, or undefined for one that is passed through. */
function walkBlocks(shapes: readonly LineShape[], nesting: BlockNesting): ({ depth: number; flat: boolean } | undefined)[] {
  const placements: ({ depth: number; flat: boolean } | undefined)[] = [];
  let continuing = false;

  for (let index = 0; index < shapes.length; index++) {
    const shape = shapes[index];

    // A statement continued with a trailing `\` — fasm's line continuation — is one logical line
    // spread over several physical ones. Only its head is a statement: the rest carry operands
    // already aligned to the wrapped list above them, and reading each as a fresh statement turns
    // "hlt,0F4h, cmc,0F5h" into a mnemonic whose operand starts with a comma.
    const carried = continuing;
    continuing = shape.continues;

    if (carried || (shape.verbatim && !shape.soleBrace)) {
      if (!shape.bodyless) nesting.track(shape, index);
      placements.push(undefined);
    } else if (shape.bodyless) {
      // Blank and comment-only lines are not statements at all, and deliberately do not disturb a
      // `macro` still waiting for the `{` that opens its body.
      placements.push(undefined);
    } else {
      placements.push(nesting.place(shape, index));
    }
  }

  return placements;
}
