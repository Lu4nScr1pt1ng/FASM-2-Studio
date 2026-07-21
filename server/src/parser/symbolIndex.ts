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

/** A macro name directly (no space) followed by "!" marks it "unconditional" — evaluated even
 * inside a suspended/false conditional block or another macro's own definition, e.g. fasmg's own
 * `macro endp?!` (packages/x86/include/macro/proc64.inc) so an "endp" can close out an "if"/"macro"
 * left open by "proc" without a literal "end if"/"end macro" appearing at that point. The "!"
 * isn't a parameter — skip it so it isn't mistaken for the start of one. */
function paramsAfterMacroName(nameTok: Token, tokens: Token[]): { tokens: Token[]; isUnconditional: boolean } {
  const next = tokens[2];
  const isUnconditional = !!(next && next.type === TokenType.Punct && next.text === '!' && next.startChar === nameTok.endChar);
  return { tokens: isUnconditional ? tokens.slice(3) : tokens.slice(2), isUnconditional };
}

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

/** Strips a trailing "?" used by fasmg to mark a name (or, independently, each dot-separated
 * component of a compound name) as overridable/weak — e.g. "foo?" -> "foo", and "end?.frame?" ->
 * "end.frame" (both components stripped, matching the manual's own "xor?.mask? := ..." example: a
 * "?" can independently follow *each* part of a dotted identifier). A component that is a bare "?"
 * is different: it's fasmg's syntax for an anonymous macro, and the name IS "?" — stripping it
 * would turn it into an empty string, which every consumer downstream (hover, completion, document
 * symbols) treats as "no symbol", and which VS Code's own DocumentSymbol validation rejects
 * outright ("name must not be falsy"). */
function baseName(name: string): string {
  return name
    .split('.')
    .map((part) => (part.length > 1 && part.endsWith('?') ? part.slice(0, -1) : part))
    .join('.');
}

/**
 * fasmg lets user code extend its CALM command set by defining a calminstruction namespaced under
 * the special "calminstruction" symbol (e.g. fasmg's own packages/x86/include/cpu/8086.inc defines
 * "calminstruction?.xcall?", used elsewhere as a bare "xcall" — a genuinely different mechanism
 * from an ordinary dotted identifier like "x87.parse_operand@dest", which *is* invoked with its
 * full dotted path intact). Detects that case and returns just the bare command name actually used
 * at call sites; returns undefined for a normal (non-command-namespaced) calminstruction name.
 */
function calmCommandBareName(cleanedName: string): string | undefined {
  const match = /^calminstruction\.(.+)$/i.exec(cleanedName);
  return match ? match[1] : undefined;
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
        // Normally `what` matches the stack top directly. It can legitimately not: fasmg's own
        // packages/x86/include/macro/proc64.inc has a macro ("initlocal") that opens a `virtual
        // at` block it *deliberately* leaves open across macro invocations — only a later,
        // separate macro ("endl?") ever closes it — a deferred-execution trick this parser (which
        // never expands or invokes macros) can't understand. Search down from the top for the
        // nearest block this end keyword actually matches, and treat anything above it as
        // implicitly closed, rather than let one such stray block desync every block after it for
        // the rest of the file.
        const idx = blockStack.lastIndexOf(what);
        if (idx !== -1) {
          while (blockStack.length > idx) {
            const popped = blockStack.pop();
            if (popped === 'macro' || popped === 'calminstruction') {
              const frame = macroFrames.pop();
              if (frame) {
                for (const sym of frame.pendingSymbols) {
                  sym.localScope = { startLine: frame.startLine, startChar: 0, endLine: t0.line, endChar: Number.MAX_SAFE_INTEGER };
                }
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
        const isWeak = nameTok.text.length > 1 && nameTok.text.endsWith('?');
        const { tokens: paramTokens, isUnconditional } = paramsAfterMacroName(nameTok, tokens);
        const sym: SymbolDefinition = {
          name,
          kind: SymbolKind.Macro,
          range: lineRange(nameTok.line, t0.startChar, tokens[tokens.length - 1].endChar),
          nameRange: tokenRange(nameTok),
          params: paramsFromTokens(paramTokens),
          isWeak,
          isUnconditional,
          uri,
        };
        symbols.push(sym);
        // A macro defined *inside* another macro's body (e.g. fasmg's own packages/x86/include/
        // macro/com64.inc's "comcall", which defines its own nested "call" macro) is only
        // meaningfully in scope for the body of the macro that defines it — reuse the same
        // localScope mechanism as `local` variables so it doesn't shadow, or get shadowed by, an
        // unrelated same-named instruction or macro elsewhere in the file.
        if (macroFrames.length > 0) macroFrames[macroFrames.length - 1].pendingSymbols.push(sym);
        blockStack.push('macro');
        macroFrames.push({ startLine: t0.line, localNames: new Set(), pendingSymbols: [] });
        continue;
      }

      // --- calminstruction NAME params... (fasmg implements virtually every real x86
      // instruction this way, e.g. this very file's own "fld?"/"fadd"-family/"xcall" — without
      // this, none of them had any SymbolDefinition at all, so hover/go-to-definition on a
      // calminstruction-defined name found nothing unless it happened to already be hardcoded in
      // this extension's own static instructions.json) ---
      if (kw0 === 'calminstruction' && tokens[1] && tokens[1].type === TokenType.Ident) {
        const nameTok = tokens[1];
        const cleaned = baseName(nameTok.text);
        const name = calmCommandBareName(cleaned) ?? cleaned;
        const isWeak = nameTok.text.length > 1 && nameTok.text.endsWith('?');
        const { tokens: paramTokens, isUnconditional } = paramsAfterMacroName(nameTok, tokens);
        const sym: SymbolDefinition = {
          name,
          kind: SymbolKind.Macro,
          range: lineRange(nameTok.line, t0.startChar, tokens[tokens.length - 1].endChar),
          nameRange: tokenRange(nameTok),
          params: paramsFromTokens(paramTokens),
          isWeak,
          isUnconditional,
          uri,
        };
        symbols.push(sym);
        if (macroFrames.length > 0) macroFrames[macroFrames.length - 1].pendingSymbols.push(sym);
        blockStack.push('calminstruction');
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

      // --- NAME = EXPR / NAME := EXPR / NAME =: EXPR / NAME equ EXPR / NAME reequ EXPR ---
      // ":=" and "=:" are two punctuation tokens each (the tokenizer never merges multi-char
      // operators), so they only count as one when written with no space between them, matching
      // how fasmg itself requires no space in these operators.
      const isColonEquals = tokens[1]?.type === TokenType.Punct && tokens[1].text === ':' && tokens[2]?.type === TokenType.Punct && tokens[2].text === '=' && tokens[1].endChar === tokens[2].startChar;
      const isEqualsColon = tokens[1]?.type === TokenType.Punct && tokens[1].text === '=' && tokens[2]?.type === TokenType.Punct && tokens[2].text === ':' && tokens[1].endChar === tokens[2].startChar;
      const isPlainEquals = tokens[1]?.type === TokenType.Punct && tokens[1].text === '=' && !isEqualsColon;
      const isEqu = lower(tokens[1]) === 'equ';
      const isReequ = lower(tokens[1]) === 'reequ';
      if (t0.type === TokenType.Ident && (isColonEquals || isEqualsColon || isPlainEquals || isEqu || isReequ)) {
        const definedVia = isColonEquals ? ':=' : isEqualsColon ? '=:' : isEqu ? 'equ' : isReequ ? 'reequ' : '=';
        const valueStart = isColonEquals || isEqualsColon ? 3 : 2;
        const name = baseName(t0.text);
        const sym: SymbolDefinition = {
          name,
          kind: SymbolKind.Constant,
          range: lineRange(t0.line, t0.startChar, tokens[tokens.length - 1].endChar),
          nameRange: tokenRange(t0),
          value: tokens.slice(valueStart).map((t) => t.text).join(' '),
          definedVia,
          uri,
        };
        symbols.push(sym);
        enclosingLocalFrame(name)?.pendingSymbols.push(sym);
        continue;
      }

      // --- define/redefine NAME EXPR ---
      if ((kw0 === 'define' || kw0 === 'redefine') && tokens[1] && tokens[1].type === TokenType.Ident) {
        const nameTok = tokens[1];
        const name = baseName(nameTok.text);
        const sym: SymbolDefinition = {
          name,
          kind: SymbolKind.Constant,
          range: lineRange(t0.line, t0.startChar, tokens[tokens.length - 1].endChar),
          nameRange: tokenRange(nameTok),
          value: tokens.slice(2).map((t) => t.text).join(' ') || undefined,
          definedVia: kw0,
          uri,
        };
        symbols.push(sym);
        enclosingLocalFrame(name)?.pendingSymbols.push(sym);
        continue;
      }

      // --- load NAME[:size] from ADDRESS (defines NAME by reading bytes back out of an output
      // area, e.g. fasmg's own packages/x86/include/macro/proc64.inc's
      // "load value:byte from area:pointer") ---
      if (kw0 === 'load' && tokens[1] && tokens[1].type === TokenType.Ident) {
        const nameTok = tokens[1];
        const name = baseName(nameTok.text);
        const fromIdx = tokens.findIndex((t) => lower(t) === 'from');
        const sym: SymbolDefinition = {
          name,
          kind: SymbolKind.Constant,
          range: lineRange(t0.line, t0.startChar, tokens[tokens.length - 1].endChar),
          nameRange: tokenRange(nameTok),
          value: fromIdx >= 0 ? tokens.slice(fromIdx + 1).map((t) => t.text).join(' ') : undefined,
          definedVia: 'load',
          uri,
        };
        symbols.push(sym);
        enclosingLocalFrame(name)?.pendingSymbols.push(sym);
        continue;
      }

      // --- NAME db/dw/dd/dq/dt/du/rb/rw/rd/rq/file ... (implicit data-label, no colon) ---
      // Inside a struct body, the name is unambiguously a field, never a keyword usage — bypass
      // NON_SYMBOL_IDENTIFIERS there. Without this, a field literally named "segment" or "offset"
      // (both real field names in fasmg's own packages/x86/projects/challenger/challenger.asm,
      // the same real file that motivated the matching struct-field fix in the syntax-highlight
      // grammar) would never be indexed at all, since those words are also recognized directives
      // — so hovering "PLANE_POINTER.segment" fell through to the unrelated "segment" directive.
      if (
        t0.type === TokenType.Ident &&
        (blockStack[blockStack.length - 1] === 'struct' || !NON_SYMBOL_IDENTIFIERS.has(t0.text.toLowerCase())) &&
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
          isStructField: blockStack[blockStack.length - 1] === 'struct',
          uri,
        });
        if (!isLocal) lastGlobalLabel = t0.text;

        collectReferences(tokens.slice(2), uri, references);
        continue;
      }

      // --- NAME:: (area label — only meaningful as the target of `load`'s AREA:offset
      // addressing mode, e.g. fasmg's own packages/x86/include/macro/proc64.inc's "area::") ---
      // Must be checked before the plain "NAME:" pattern below: that one only looks at the first
      // ":" token, so "area::" would otherwise match it as an ordinary label and strand the
      // second ":" unrecognized.
      if (
        t0.type === TokenType.Ident &&
        tokens[1]?.type === TokenType.Punct &&
        tokens[1].text === ':' &&
        tokens[2]?.type === TokenType.Punct &&
        tokens[2].text === ':' &&
        tokens[1].endChar === tokens[2].startChar
      ) {
        const isLocal = t0.text.startsWith('.');
        const sym: SymbolDefinition = {
          name: t0.text,
          kind: isLocal ? SymbolKind.LocalLabel : SymbolKind.Label,
          range: lineRange(t0.line, t0.startChar, tokens[2].endChar),
          nameRange: tokenRange(t0),
          parentLabel: isLocal ? lastGlobalLabel : undefined,
          isAreaLabel: true,
          uri,
        };
        symbols.push(sym);
        enclosingLocalFrame(t0.text)?.pendingSymbols.push(sym);
        if (!isLocal) lastGlobalLabel = t0.text;

        collectReferences(tokens.slice(3), uri, references);
        continue;
      }

      // --- NAME: (label, global or local) ---
      if (t0.type === TokenType.Ident && tokens[1] && tokens[1].type === TokenType.Punct && tokens[1].text === ':') {
        const isLocal = t0.text.startsWith('.');
        const sym: SymbolDefinition = {
          name: t0.text,
          kind: isLocal ? SymbolKind.LocalLabel : SymbolKind.Label,
          range: lineRange(t0.line, t0.startChar, tokens[1].endChar),
          nameRange: tokenRange(t0),
          parentLabel: isLocal ? lastGlobalLabel : undefined,
          uri,
        };
        symbols.push(sym);
        enclosingLocalFrame(t0.text)?.pendingSymbols.push(sym);
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
