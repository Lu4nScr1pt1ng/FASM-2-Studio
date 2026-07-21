// Builds a lightweight symbol table from tokenized fasm source. This is heuristic, not a real
// assembler front-end: it recognizes the common definition shapes (label:, label NAME at EXPR,
// NAME = EXPR, NAME equ EXPR, macro/struct blocks, include) well enough to power completion,
// hover, document symbols and go-to-definition, without ever needing to evaluate expressions or
// expand macros. Parsing never throws: malformed or partial lines are simply skipped so one bad
// file can't take down the server or block editing of the rest of the document.

import directivesData from '../data/directives.json';
import instructionsData from '../data/instructions.json';
import registersData from '../data/registers.json';
import { DirectiveEntry, Dialect, InstructionEntry, IncludeDirective, ParsedDocument, Range, RegisterEntry, SymbolDefinition, SymbolKind, SymbolReference } from '../types';
import { Token, TokenType, tokenizeDocument, unquoteString } from './tokenizer';

// Data-defining directives that, when immediately preceded by a bare identifier on the same line
// (no colon needed), implicitly define a label at that point — e.g. "tok_type rb TOK_CAP" or
// "err_open_prefix db 'message'" are equivalent to "tok_type: rb TOK_CAP".
const DATA_DIRECTIVES: ReadonlySet<string> = new Set([
  'db', 'dw', 'dd', 'dp', 'df', 'dq', 'dt', 'ddq', 'dqq', 'ddqq', 'du',
  'rb', 'rw', 'rd', 'rp', 'rf', 'rq', 'rt', 'rdq', 'rqq', 'rdqq', 'file',
]);

/** Joins a macro/struct's parameter tokens back into source text (no separator, so operators like
 * "*" in "a*,b*" don't grow a spurious space). Drops a trailing "{" — present when the block body
 * opens on the same line (e.g. "macro foo a, b {") — which isn't part of the parameter list. */
function paramsFromTokens(tokens: Token[]): string | undefined {
  const relevant = tokens.length > 0 && tokens[tokens.length - 1].text === '{' ? tokens.slice(0, -1) : tokens;
  return relevant.map((t) => t.text).join('').trim() || undefined;
}

const BLOCK_END_KEYWORDS: Record<string, string> = {
  macro: 'end',
  struct: 'ends',
  virtual: 'end',
  namespace: 'end',
};

// Bare identifiers that are instructions, registers, or directives aren't user symbols — they can
// never be defined, renamed, or meaningfully "found" as a reference, and collecting them anyway
// would flood find-references/rename with every "mov"/"eax" in the file for no benefit. Built
// once from the same static data completion/hover already use, not per-parse.
const NON_SYMBOL_IDENTIFIERS: ReadonlySet<string> = new Set([
  ...(instructionsData as InstructionEntry[]).map((i) => i.mnemonic.toLowerCase()),
  ...(registersData as RegisterEntry[]).map((r) => r.name.toLowerCase()),
  ...(directivesData as DirectiveEntry[])
    .map((d) => d.name.toLowerCase())
    .filter((name) => !name.includes(' ')), // multi-word entries ("end macro") never match a single token anyway
]);

function tokenRange(t: Token): Range {
  return { startLine: t.line, startChar: t.startChar, endLine: t.line, endChar: t.endChar };
}

function lineRange(line: number, startChar: number, endChar: number): Range {
  return { startLine: line, startChar, endLine: line, endChar };
}

function lower(t: Token | undefined): string {
  return t ? t.text.toLowerCase() : '';
}

/** Strips a trailing "?" used by fasmg to mark a macro name as overridable/weak (e.g. "foo?" ->
 * "foo"). A bare "?" is different: it's fasmg's syntax for an anonymous macro, and the name IS
 * "?" — stripping it here would turn it into an empty string, which every consumer downstream
 * (hover, completion, document symbols) treats as "no symbol", and which VS Code's own
 * DocumentSymbol validation rejects outright ("name must not be falsy"). */
function baseName(name: string): string {
  return name.length > 1 && name.endsWith('?') ? name.slice(0, -1) : name;
}

/** Tracks one open `macro ... end macro` block, so a name declared `local` inside it can be told
 * apart from the same name declared `local` in a completely unrelated macro elsewhere in the same
 * file (see SymbolDefinition.localScope). */
interface MacroFrame {
  startLine: number;
  localNames: Set<string>;
  pendingSymbols: SymbolDefinition[];
}

export function parseDocument(uri: string, version: number, text: string, dialect: Dialect): ParsedDocument {
  const symbols: SymbolDefinition[] = [];
  const references: SymbolReference[] = [];
  const includes: IncludeDirective[] = [];
  let formatDirective: string | undefined;
  let hasTopLevelOrg = false;
  let inImportList = false;

  const blockStack: string[] = [];
  const macroFrames: MacroFrame[] = [];
  let lastGlobalLabel: string | undefined;

  /** If `name` was declared `local` in a currently-open macro, returns that macro's frame
   * (innermost first — a name can only sensibly be local to one enclosing macro at a time). */
  function enclosingLocalFrame(name: string): MacroFrame | undefined {
    for (let i = macroFrames.length - 1; i >= 0; i--) {
      if (macroFrames[i].localNames.has(name)) return macroFrames[i];
    }
    return undefined;
  }

  try {
    const lines = tokenizeDocument(text);

    for (const rawTokens of lines) {
      const tokens = rawTokens.filter((t) => t.type !== TokenType.Comment);
      if (tokens.length === 0) continue;

      const t0 = tokens[0];
      const kw0 = t0.type === TokenType.Ident ? t0.text.toLowerCase() : '';

      // --- block end tracking (end macro / ends / end virtual / end namespace) ---
      if (kw0 === 'end' && tokens[1]) {
        const what = lower(tokens[1]);
        const top = blockStack[blockStack.length - 1];
        if (top && (what === top || (top !== 'struct' && what === BLOCK_END_KEYWORDS[top]))) {
          blockStack.pop();
          if (top === 'macro') {
            const frame = macroFrames.pop();
            if (frame) {
              for (const sym of frame.pendingSymbols) {
                sym.localScope = { startLine: frame.startLine, startChar: 0, endLine: t0.line, endChar: Number.MAX_SAFE_INTEGER };
              }
            }
          }
        }
        continue;
      }
      if (kw0 === 'ends' && blockStack[blockStack.length - 1] === 'struct') {
        blockStack.pop();
        continue;
      }

      // --- include 'path' ---
      if (kw0 === 'include' && tokens[1] && tokens[1].type === TokenType.String) {
        includes.push({ path: unquoteString(tokens[1].text), range: tokenRange(tokens[1]), uri });
        continue;
      }

      // --- format ... (recorded once, top level) ---
      if (kw0 === 'format' && formatDirective === undefined && blockStack.length === 0) {
        formatDirective = tokens.slice(1).map((t) => t.text).join(' ');
      }

      // --- org/section ... (a top-level output area with no format directive is still a
      // complete, directly assemblable program in fasmg, e.g. a flat "org 100h" .com file) ---
      if ((kw0 === 'org' || kw0 === 'section') && blockStack.length === 0) {
        hasTopLevelOrg = true;
      }

      // --- import <library nickname>, NAME,'exported name', NAME,'exported name', ... ---
      // fasmg's Windows/PE packages (e.g. api/kernel32.inc, api/user32.inc — the standard way any
      // real fasmg project imports OS/kernel functions) declare every imported function this way
      // rather than as a label, so without this the name a program actually calls (e.g.
      // `invoke ExitProcess, ...`) would have no known definition at all: no hover, no
      // go-to-definition, despite compiling perfectly fine. The list is typically continued across
      // many physical lines via a trailing "\", which the tokenizer (line-oriented, no macro
      // expansion) never joins into one logical line — so this tracks that continuation itself,
      // scanning for NAME,'string' pairs on the "import" line (after its library-nickname operand)
      // and on every subsequent line for as long as the previous one ended with "\".
      if (kw0 === 'import' || inImportList) {
        // "import" has two real shapes: the PE/Windows one (a library nickname operand, then
        // NAME,'string' pairs — possibly starting on this same line, possibly only on later
        // continued lines) and the Mach-O/ELF one (no nickname at all, e.g.
        // `import printf,'_printf'`, straight from packages/x86/examples/mach-o/demo_dynamic64.asm).
        // Telling them apart: right after "import", a direct NAME,'string' pair has a string as
        // its *third* token; a nickname operand is instead followed by another name (same-line
        // list) or a line-continuing "\" (list starts on the next line).
        const looksLikeDirectPair =
          kw0 === 'import' && tokens[1]?.type === TokenType.Ident && tokens[2]?.type === TokenType.Punct && tokens[2].text === ',' && tokens[3]?.type === TokenType.String;
        const startIdx = kw0 === 'import' ? (looksLikeDirectPair ? 1 : 2) : 0; // skip "import" itself and its library-nickname operand, if any
        for (let i = startIdx; i + 2 < tokens.length; i++) {
          const nameTok = tokens[i];
          const commaTok = tokens[i + 1];
          const strTok = tokens[i + 2];
          if (
            nameTok.type === TokenType.Ident &&
            commaTok.type === TokenType.Punct &&
            commaTok.text === ',' &&
            strTok.type === TokenType.String
          ) {
            symbols.push({
              name: nameTok.text,
              kind: SymbolKind.Constant,
              range: lineRange(nameTok.line, nameTok.startChar, strTok.endChar),
              nameRange: tokenRange(nameTok),
              value: `imported as ${strTok.text}`,
              uri,
            });
          }
        }
        const lastToken = tokens[tokens.length - 1];
        inImportList = lastToken.type === TokenType.Punct && lastToken.text === '\\';
        continue;
      }

      // --- macro NAME params... ---
      if (kw0 === 'macro' && tokens[1] && tokens[1].type === TokenType.Ident) {
        const nameTok = tokens[1];
        const name = baseName(nameTok.text);
        symbols.push({
          name,
          kind: SymbolKind.Macro,
          range: lineRange(nameTok.line, t0.startChar, tokens[tokens.length - 1].endChar),
          nameRange: tokenRange(nameTok),
          params: paramsFromTokens(tokens.slice(2)),
          uri,
        });
        blockStack.push('macro');
        macroFrames.push({ startLine: t0.line, localNames: new Set(), pendingSymbols: [] });
        continue;
      }

      // --- local NAME1, NAME2, ... (inside a macro body) ---
      if (kw0 === 'local' && macroFrames.length > 0) {
        const frame = macroFrames[macroFrames.length - 1];
        for (const t of tokens.slice(1)) {
          if (t.type === TokenType.Ident) frame.localNames.add(t.text);
        }
        continue;
      }

      // --- struct NAME params... ---
      if (kw0 === 'struct' && tokens[1] && tokens[1].type === TokenType.Ident) {
        const nameTok = tokens[1];
        symbols.push({
          name: nameTok.text,
          kind: SymbolKind.Struct,
          range: lineRange(nameTok.line, t0.startChar, tokens[tokens.length - 1].endChar),
          nameRange: tokenRange(nameTok),
          params: paramsFromTokens(tokens.slice(2)),
          uri,
        });
        blockStack.push('struct');
        continue;
      }

      if (kw0 === 'virtual' || kw0 === 'namespace') {
        blockStack.push(kw0);
        continue;
      }

      // --- label NAME [size] at EXPR ---
      if (kw0 === 'label' && tokens[1] && tokens[1].type === TokenType.Ident) {
        const nameTok = tokens[1];
        const atIdx = tokens.findIndex((t) => lower(t) === 'at');
        const value = atIdx >= 0 ? tokens.slice(atIdx + 1).map((t) => t.text).join(' ') : undefined;
        symbols.push({
          name: nameTok.text,
          kind: SymbolKind.Label,
          range: lineRange(nameTok.line, t0.startChar, tokens[tokens.length - 1].endChar),
          nameRange: tokenRange(nameTok),
          value,
          uri,
        });
        if (!nameTok.text.startsWith('.')) lastGlobalLabel = nameTok.text;
        continue;
      }

      // --- NAME = EXPR ---
      if (t0.type === TokenType.Ident && tokens[1] && tokens[1].type === TokenType.Punct && tokens[1].text === '=') {
        const sym: SymbolDefinition = {
          name: t0.text,
          kind: SymbolKind.Constant,
          range: lineRange(t0.line, t0.startChar, tokens[tokens.length - 1].endChar),
          nameRange: tokenRange(t0),
          value: tokens.slice(2).map((t) => t.text).join(' '),
          definedVia: '=',
          uri,
        };
        symbols.push(sym);
        enclosingLocalFrame(t0.text)?.pendingSymbols.push(sym);
        continue;
      }

      // --- NAME equ EXPR ---
      if (t0.type === TokenType.Ident && lower(tokens[1]) === 'equ') {
        const sym: SymbolDefinition = {
          name: t0.text,
          kind: SymbolKind.Constant,
          range: lineRange(t0.line, t0.startChar, tokens[tokens.length - 1].endChar),
          nameRange: tokenRange(t0),
          value: tokens.slice(2).map((t) => t.text).join(' '),
          definedVia: 'equ',
          uri,
        };
        symbols.push(sym);
        enclosingLocalFrame(t0.text)?.pendingSymbols.push(sym);
        continue;
      }

      // --- NAME db/dw/dd/dq/dt/du/rb/rw/rd/rq/file ... (implicit data-label, no colon) ---
      if (
        t0.type === TokenType.Ident &&
        !NON_SYMBOL_IDENTIFIERS.has(t0.text.toLowerCase()) &&
        tokens[1] &&
        tokens[1].type === TokenType.Ident &&
        DATA_DIRECTIVES.has(lower(tokens[1]))
      ) {
        const isLocal = t0.text.startsWith('.');
        symbols.push({
          name: t0.text,
          kind: isLocal ? SymbolKind.LocalLabel : SymbolKind.Label,
          range: lineRange(t0.line, t0.startChar, tokens[tokens.length - 1].endChar),
          nameRange: tokenRange(t0),
          parentLabel: isLocal ? lastGlobalLabel : undefined,
          value: tokens.slice(1).map((t) => t.text).join(' '),
          uri,
        });
        if (!isLocal) lastGlobalLabel = t0.text;

        collectReferences(tokens.slice(2), uri, references);
        continue;
      }

      // --- NAME: (label, global or local) ---
      if (t0.type === TokenType.Ident && tokens[1] && tokens[1].type === TokenType.Punct && tokens[1].text === ':') {
        const isLocal = t0.text.startsWith('.');
        symbols.push({
          name: t0.text,
          kind: isLocal ? SymbolKind.LocalLabel : SymbolKind.Label,
          range: lineRange(t0.line, t0.startChar, tokens[1].endChar),
          nameRange: tokenRange(t0),
          parentLabel: isLocal ? lastGlobalLabel : undefined,
          uri,
        });
        if (!isLocal) lastGlobalLabel = t0.text;

        // References may continue on the same line after the colon (e.g. "start: mov eax,1").
        collectReferences(tokens.slice(2), uri, references);
        continue;
      }

      // Anything else on the line is treated as instruction/operand text; harvest bare
      // identifiers as best-effort references for go-to-definition.
      collectReferences(tokens, uri, references);
    }
  } catch {
    // Never let a parse failure propagate — degrade to whatever was collected so far.
  }

  return { uri, version, dialect, symbols, references, includes, formatDirective, hasTopLevelOrg };
}

function collectReferences(tokens: Token[], uri: string, out: SymbolReference[]): void {
  for (const t of tokens) {
    if (t.type === TokenType.Ident && !NON_SYMBOL_IDENTIFIERS.has(t.text.toLowerCase())) {
      out.push({ name: t.text, range: tokenRange(t), uri });
    }
  }
}
