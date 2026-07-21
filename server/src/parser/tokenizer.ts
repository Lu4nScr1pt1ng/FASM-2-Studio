// Single-pass, line-oriented tokenizer for fasm1/fasm2 source. This is deliberately not a full
// assembler-grade lexer (no macro expansion, no expression evaluation) — it exists only to feed
// the lightweight symbol index used for completion/hover/go-to-definition. Every scan is O(n) in
// the length of the line with no backtracking regexes, so it stays cheap even on very large files
// and can safely re-run on every keystroke without a perceptible stall.

export enum TokenType {
  Ident,
  Number,
  String,
  Punct,
  Comment,
}

export interface Token {
  type: TokenType;
  text: string;
  line: number;
  startChar: number;
  endChar: number;
}

// fasmg's own tokenization rule (manual.txt's "Fundamental syntax rules") is the inverse of what
// you'd expect: it lists the small set of characters that are *always* their own separate token
// (`+-/*=<>()[]{}:?!,.|&~#\`) and says any other contiguous run of characters is a single name —
// "%" is conspicuously absent from that special-character list, so e.g.
// packages/x86/include/pcount/kernel32.inc's own "BackupRead% =  7" defines a symbol literally
// named "BackupRead%", not "BackupRead" followed by a "%" punctuation token. Without "%" here, the
// tokenizer split it into Ident("BackupRead") + Punct("%"), so the "=" that should immediately
// follow the identifier ends up in the wrong token slot and the whole line was silently never
// recognized as a constant definition at all.
const IDENT_START = /[A-Za-z_.@$?%]/;
const IDENT_PART = /[A-Za-z0-9_.@$?%]/;
const DIGIT = /[0-9]/;

/** Tokenizes a single line. Strings and comments never span lines in fasm syntax. */
export function tokenizeLine(text: string, line: number): Token[] {
  const tokens: Token[] = [];
  const len = text.length;
  let i = 0;

  while (i < len) {
    const ch = text[i];

    if (ch === ' ' || ch === '\t' || ch === '\r') {
      i++;
      continue;
    }

    if (ch === ';') {
      tokens.push({ type: TokenType.Comment, text: text.slice(i), line, startChar: i, endChar: len });
      break;
    }

    if (ch === "'" || ch === '"') {
      const start = i;
      const quote = ch;
      i++;
      while (i < len) {
        if (text[i] === quote) {
          // A doubled quote is an escaped literal quote character, not the terminator.
          if (text[i + 1] === quote) {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      tokens.push({ type: TokenType.String, text: text.slice(start, i), line, startChar: start, endChar: i });
      continue;
    }

    if (DIGIT.test(ch)) {
      const start = i;
      while (i < len && IDENT_PART.test(text[i])) i++;
      tokens.push({ type: TokenType.Number, text: text.slice(start, i), line, startChar: start, endChar: i });
      continue;
    }

    if (IDENT_START.test(ch)) {
      const start = i;
      while (i < len && IDENT_PART.test(text[i])) i++;
      tokens.push({ type: TokenType.Ident, text: text.slice(start, i), line, startChar: start, endChar: i });
      continue;
    }

    // Everything else (operators, punctuation, brackets) is a single-char token; multi-char
    // operators like "<=" don't need merging for our indexing purposes.
    tokens.push({ type: TokenType.Punct, text: ch, line, startChar: i, endChar: i + 1 });
    i++;
  }

  return tokens;
}

export function tokenizeDocument(text: string): Token[][] {
  const lines = text.split(/\r\n|\r|\n/);
  return lines.map((lineText, idx) => tokenizeLine(lineText, idx));
}

/** Strips the trailing quote characters and un-doubles escaped quotes from a string token's text. */
export function unquoteString(tokenText: string): string {
  if (tokenText.length < 2) return tokenText;
  const quote = tokenText[0];
  const inner = tokenText.slice(1, tokenText[tokenText.length - 1] === quote ? -1 : undefined);
  return inner.split(quote + quote).join(quote);
}
