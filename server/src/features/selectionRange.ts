// Smart select (Shift+Alt+Right / Left): grow the selection one meaningful step at a time.
//
// The editor's built-in fallback grows by word, then by bracket pair, then by the whole document —
// which in assembly means it goes from `eax` straight to the file, since a line of asm has no
// brackets to stop at. The steps that actually exist here are the operand, the statement, the line,
// and each enclosing block, and only the server knows where those are: telling `db 'a, b'` from a
// real operand separator, or which `end macro` closes which `macro`, both need the tokenizer.

import { Position, Range, SelectionRange } from 'vscode-languageserver/node';
import { Token, TokenType, tokenizeDocument } from '../parser/tokenizer';
import { DEDICATED_CLOSERS, END_KEYWORD_BLOCKS, labelPrefixLength } from './foldingRange';

/** Matches foldingRange.ts's own guard against a pathological file producing an unbounded stack. */
const MAX_NESTING = 100;

interface BlockRange {
  startLine: number;
  /** The closing line itself, which — unlike a fold — is part of what gets selected. */
  endLine: number;
}

interface OpenBlock {
  keyword: string;
  line: number;
}

function statement(tokens: Token[]): { keyword: string; second?: string } | undefined {
  const code = tokens.filter((t) => t.type !== TokenType.Comment);
  if (code.length === 0) return undefined;
  const start = labelPrefixLength(code);
  const first = code[start];
  if (!first || first.type !== TokenType.Ident) return undefined;
  const second = code[start + 1];
  return { keyword: first.text.toLowerCase(), second: second?.type === TokenType.Ident ? second.text.toLowerCase() : undefined };
}

function popNearest(stack: OpenBlock[], matches: (keyword: string) => boolean): OpenBlock | undefined {
  for (let i = stack.length - 1; i >= 0; i--) {
    if (matches(stack[i].keyword)) return stack.splice(i, 1)[0];
  }
  return undefined;
}

/**
 * Every matched block in the document, opener line through closer line inclusive.
 *
 * Deliberately whole blocks rather than fold ranges: selecting a `macro` should take the `macro`
 * line and its `end macro` with it, since the point of the selection is almost always to move or
 * copy the construct, and half of one is not a construct. An `else` is left alone for the same
 * reason — the useful unit is the whole `if`, not one of its branches.
 */
export function getBlockRanges(text: string): BlockRange[] {
  const lines = tokenizeDocument(text);
  const blocks: BlockRange[] = [];
  const stack: OpenBlock[] = [];

  for (let line = 0; line < lines.length; line++) {
    const found = statement(lines[line]);
    if (!found) continue;
    const { keyword, second } = found;

    if (keyword === 'end' && second !== undefined) {
      const closed = popNearest(stack, (open) => open === second || (second === 'match' && (open === 'rmatch' || open === 'rawmatch')));
      if (closed) blocks.push({ startLine: closed.line, endLine: line });
      continue;
    }

    const dedicated = DEDICATED_CLOSERS[keyword];
    if (dedicated) {
      const closed = popNearest(stack, (open) => dedicated.has(open));
      if (closed) blocks.push({ startLine: closed.line, endLine: line });
      continue;
    }

    if (keyword === 'end') continue;

    const opens = END_KEYWORD_BLOCKS.has(keyword) || keyword === 'struct' || keyword === 'struc' || keyword === 'union' || keyword === 'proc';
    if (opens && stack.length < MAX_NESTING) stack.push({ keyword, line });
  }

  return blocks;
}

function contains(outer: Range, inner: Range): boolean {
  const startsBefore = outer.start.line < inner.start.line || (outer.start.line === inner.start.line && outer.start.character <= inner.start.character);
  const endsAfter = outer.end.line > inner.end.line || (outer.end.line === inner.end.line && outer.end.character >= inner.end.character);
  return startsBefore && endsAfter;
}

function sameRange(a: Range, b: Range): boolean {
  return a.start.line === b.start.line && a.start.character === b.start.character && a.end.line === b.end.line && a.end.character === b.end.character;
}

/** The token the cursor is on or immediately after — the innermost step, and the one the editor
 * would otherwise have to guess with its own word pattern. */
function tokenAt(tokens: Token[], character: number): Token | undefined {
  return tokens.find((t) => character >= t.startChar && character <= t.endChar);
}

/**
 * The comma-separated operand the cursor sits in, as a character span.
 *
 * Bracket depth is tracked so a comma inside `[eax + ebx*2]` — or inside a macro argument list
 * written with braces — does not split an operand that the assembler reads as one.
 */
function operandSpan(code: Token[], from: number, character: number): { start: number; end: number } | undefined {
  let depth = 0;
  let spanStart = from;
  for (let i = from; i <= code.length; i++) {
    const token = code[i];
    const atEnd = i === code.length;
    if (!atEnd && token.type === TokenType.Punct) {
      if (token.text === '[' || token.text === '(' || token.text === '{') depth++;
      else if (token.text === ']' || token.text === ')' || token.text === '}') depth = Math.max(0, depth - 1);
    }
    const isSeparator = !atEnd && token.type === TokenType.Punct && token.text === ',' && depth === 0;
    if (!atEnd && !isSeparator) continue;

    const last = code[i - 1];
    if (spanStart < i && last && character >= code[spanStart].startChar && character <= last.endChar) {
      return { start: code[spanStart].startChar, end: last.endChar };
    }
    spanStart = i + 1;
    if (atEnd) break;
  }
  return undefined;
}

/** Turns an outermost-first list of ranges into the nested chain LSP asks for, dropping any that
 * repeats the one before it (a statement that is already the whole line, say). */
function chain(ranges: Range[]): SelectionRange | undefined {
  let current: SelectionRange | undefined;
  for (const range of ranges) {
    if (current && (sameRange(current.range, range) || !contains(current.range, range))) continue;
    current = { range, parent: current };
  }
  return current;
}

export function getSelectionRanges(text: string, positions: Position[]): SelectionRange[] {
  const lineTexts = text.split(/\r\n|\r|\n/);
  const lines = tokenizeDocument(text);
  const blocks = getBlockRanges(text);
  const documentRange: Range = {
    start: { line: 0, character: 0 },
    end: { line: Math.max(0, lineTexts.length - 1), character: lineTexts[lineTexts.length - 1]?.length ?? 0 },
  };

  return positions.map((position) => {
    const ranges: Range[] = [documentRange];

    // Enclosing blocks, outermost first, so each is a parent of the next.
    const enclosing = blocks
      .filter((b) => position.line >= b.startLine && position.line <= b.endLine)
      .sort((a, b) => a.startLine - b.startLine || b.endLine - a.endLine);
    for (const block of enclosing) {
      ranges.push({
        start: { line: block.startLine, character: 0 },
        end: { line: block.endLine, character: lineTexts[block.endLine]?.length ?? 0 },
      });
    }

    const lineText = lineTexts[position.line] ?? '';
    ranges.push({ start: { line: position.line, character: 0 }, end: { line: position.line, character: lineText.length } });

    const tokens = lines[position.line] ?? [];
    const code = tokens.filter((t) => t.type !== TokenType.Comment);
    if (code.length > 0) {
      // The statement without its label or trailing comment — what you want when moving one
      // instruction, as opposed to the line it happens to share with a label.
      const from = labelPrefixLength(code);
      if (code[from]) {
        ranges.push({
          start: { line: position.line, character: code[from].startChar },
          end: { line: position.line, character: code[code.length - 1].endChar },
        });
      }

      // Operands start after the mnemonic/directive itself.
      const operand = operandSpan(code, from + 1, position.character);
      if (operand) {
        ranges.push({
          start: { line: position.line, character: operand.start },
          end: { line: position.line, character: operand.end },
        });
      }
    }

    const token = tokenAt(tokens, position.character);
    if (token) {
      ranges.push({
        start: { line: position.line, character: token.startChar },
        end: { line: position.line, character: token.endChar },
      });
    }

    // A position with nothing at all around it (an empty document) still owes the client a range.
    return chain(ranges) ?? { range: { start: position, end: position } };
  });
}
