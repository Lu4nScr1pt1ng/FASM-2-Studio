// Server-side folding for fasm's block constructs.
//
// The language configuration already carries `folding.markers` regexes, but a marker-based folder
// is line-local: it cannot tell which `end macro` closes which `macro`, so nested blocks — a
// `while` inside an `if` inside a `macro`, entirely ordinary in fasmg — fold wrongly. This walks
// the document with an explicit stack instead, so every range is a real, matched pair.
//
// It works off the tokenizer rather than raw regexes for one concrete reason: a `;` inside a
// string literal is not a comment (`db 'a ; b'`), and a `macro`/`end` spelled inside one is not a
// block. Regex-based folding gets both wrong.

import { FoldingRange, FoldingRangeKind } from 'vscode-languageserver/node';
import { Token, TokenType, tokenizeDocument } from '../parser/tokenizer';

/**
 * Blocks opened by a keyword and closed by `end <that same keyword>`. Taken from fasmg's own
 * control directives; `rmatch`/`rawmatch` close with `end match`, which the nearest-matching-opener
 * search below handles without needing to be special-cased.
 */
export const END_KEYWORD_BLOCKS = new Set([
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
]);

/** Blocks closed by a dedicated single keyword rather than `end <keyword>`. */
export const DEDICATED_CLOSERS: Record<string, ReadonlySet<string>> = {
  ends: new Set(['struct', 'struc', 'union']),
  endp: new Set(['proc']), // the fasm1 proc/endp macros
};

/** Guards a pathological file (deeply nested or generated) from producing an unbounded stack. */
const MAX_NESTING = 100;

interface OpenBlock {
  keyword: string;
  line: number;
}

/**
 * How many leading tokens a `label:`/`label::` prefix occupies, so the statement itself can be read
 * past it. A block can be preceded by a label on the same line ("done: end if" is rare, "start:
 * macro" is not, but both are legal).
 */
export function labelPrefixLength(code: Token[]): number {
  if (code[0]?.type === TokenType.Ident && code[1]?.type === TokenType.Punct && code[1].text === ':') {
    return code[2]?.type === TokenType.Punct && code[2].text === ':' ? 3 : 2;
  }
  return 0;
}

/** The statement keyword a line starts with, ignoring an optional leading `label:` and any
 * comment, or undefined for a line that starts with something else. */
function statementKeyword(tokens: Token[]): { keyword: string; second?: string } | undefined {
  const code = tokens.filter((t) => t.type !== TokenType.Comment);
  if (code.length === 0) return undefined;

  const start = labelPrefixLength(code);
  const first = code[start];
  if (!first || first.type !== TokenType.Ident) return undefined;
  const second = code[start + 1];
  return {
    keyword: first.text.toLowerCase(),
    second: second?.type === TokenType.Ident ? second.text.toLowerCase() : undefined,
  };
}

/** Pops the nearest open block matching `matches`, returning it, or undefined when the closer has
 * no opener (a fragment file that begins mid-block, or unbalanced conditional assembly). */
function popNearest(stack: OpenBlock[], matches: (keyword: string) => boolean): OpenBlock | undefined {
  for (let i = stack.length - 1; i >= 0; i--) {
    if (matches(stack[i].keyword)) {
      const [block] = stack.splice(i, 1);
      return block;
    }
  }
  return undefined;
}

/** A fold covering `startLine`..`endLine`, or nothing when it would be a single line (VS Code
 * ignores those, and emitting them just inflates the response). */
function range(startLine: number, endLine: number, kind?: FoldingRangeKind): FoldingRange[] {
  // endLine is the last line *inside* the fold: the closing keyword itself stays visible when
  // collapsed, matching how every other language's folding behaves.
  const last = endLine - 1;
  return last > startLine ? [{ startLine, endLine: last, ...(kind ? { kind } : {}) }] : [];
}

export function getFoldingRanges(text: string): FoldingRange[] {
  const lines = tokenizeDocument(text);
  const ranges: FoldingRange[] = [];
  const stack: OpenBlock[] = [];
  const regions: number[] = [];
  let commentRunStart: number | undefined;

  for (let line = 0; line < lines.length; line++) {
    const tokens = lines[line];

    // --- `;region` / `;endregion`, and runs of consecutive comment lines --------------------
    const onlyComment = tokens.length > 0 && tokens.every((t) => t.type === TokenType.Comment);
    if (onlyComment) {
      const body = tokens[0].text.replace(/^;+\s*/, '').toLowerCase();
      if (body.startsWith('region')) {
        regions.push(line);
        commentRunStart = undefined;
        continue;
      }
      if (body.startsWith('endregion')) {
        const start = regions.pop();
        if (start !== undefined) ranges.push(...range(start, line + 1, FoldingRangeKind.Region));
        commentRunStart = undefined;
        continue;
      }
      if (commentRunStart === undefined) commentRunStart = line;
    } else {
      if (commentRunStart !== undefined) ranges.push(...range(commentRunStart, line, FoldingRangeKind.Comment));
      commentRunStart = undefined;
    }
    if (onlyComment) continue;

    // --- block structure --------------------------------------------------------------------
    const statement = statementKeyword(tokens);
    if (!statement) continue;
    const { keyword, second } = statement;

    if (keyword === 'end' && second !== undefined) {
      const closed = popNearest(stack, (open) => open === second || (second === 'match' && (open === 'rmatch' || open === 'rawmatch')));
      if (closed) ranges.push(...range(closed.line, line));
      continue;
    }

    const dedicated = DEDICATED_CLOSERS[keyword];
    if (dedicated) {
      const closed = popNearest(stack, (open) => dedicated.has(open));
      if (closed) ranges.push(...range(closed.line, line));
      continue;
    }

    // `else` / `else if` closes the preceding branch and opens the next, so each branch folds
    // independently — the same shape every other language's folding gives an if/else chain.
    if (keyword === 'else') {
      const previous = popNearest(stack, (open) => open === 'if');
      if (previous) ranges.push(...range(previous.line, line));
      if (stack.length < MAX_NESTING) stack.push({ keyword: 'if', line });
      continue;
    }

    // `end macro` on its own line is a closer, handled above; a bare `end` (fasm1's program
    // terminator) opens nothing.
    if (keyword === 'end') continue;

    const opensBlock = END_KEYWORD_BLOCKS.has(keyword) || keyword === 'struct' || keyword === 'struc' || keyword === 'union' || keyword === 'proc';
    if (opensBlock && stack.length < MAX_NESTING) {
      stack.push({ keyword, line });
    }
  }

  // A trailing run of comments still folds; an *unclosed block* deliberately does not. Folding it
  // to end-of-file would misrepresent a file that simply opens a block it never closes (a fragment
  // meant to be `include`d mid-construct, or a `macro` guarded by conditional assembly) as one
  // enormous region.
  if (commentRunStart !== undefined) ranges.push(...range(commentRunStart, lines.length, FoldingRangeKind.Comment));

  return ranges;
}
