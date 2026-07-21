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

export function parseDocument(uri: string, version: number, text: string, dialect: Dialect): ParsedDocument {
  const symbols: SymbolDefinition[] = [];
  const references: SymbolReference[] = [];
  const includes: IncludeDirective[] = [];
  let formatDirective: string | undefined;

  const blockStack: string[] = [];
  let lastGlobalLabel: string | undefined;

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
        symbols.push({
          name: t0.text,
          kind: SymbolKind.Constant,
          range: lineRange(t0.line, t0.startChar, tokens[tokens.length - 1].endChar),
          nameRange: tokenRange(t0),
          value: tokens.slice(2).map((t) => t.text).join(' '),
          definedVia: '=',
          uri,
        });
        continue;
      }

      // --- NAME equ EXPR ---
      if (t0.type === TokenType.Ident && lower(tokens[1]) === 'equ') {
        symbols.push({
          name: t0.text,
          kind: SymbolKind.Constant,
          range: lineRange(t0.line, t0.startChar, tokens[tokens.length - 1].endChar),
          nameRange: tokenRange(t0),
          value: tokens.slice(2).map((t) => t.text).join(' '),
          definedVia: 'equ',
          uri,
        });
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

  return { uri, version, dialect, symbols, references, includes, formatDirective };
}

function collectReferences(tokens: Token[], uri: string, out: SymbolReference[]): void {
  for (const t of tokens) {
    if (t.type === TokenType.Ident && !NON_SYMBOL_IDENTIFIERS.has(t.text.toLowerCase())) {
      out.push({ name: t.text, range: tokenRange(t), uri });
    }
  }
}
