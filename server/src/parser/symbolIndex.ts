// Builds a lightweight symbol table from tokenized fasm source. This is heuristic, not a real
// assembler front-end: it recognizes the common definition shapes (label:, label NAME at EXPR,
// NAME = EXPR, NAME equ EXPR, macro/struct blocks, include) well enough to power completion,
// hover, document symbols and go-to-definition, without ever needing to evaluate expressions or
// expand macros. Parsing never throws: malformed or partial lines are simply skipped so one bad
// file can't take down the server or block editing of the rest of the document.

import directivesData from '../data/directives.json';
import instructionsData from '../data/instructions.json';
import registersData from '../data/registers.json';
import { DirectiveEntry, Dialect, InstructionEntry, IncludeDirective, ParsedDocument, PossibleInstance, Range, RegisterEntry, SymbolDefinition, SymbolKind, SymbolReference } from '../types';
import { Token, TokenType, tokenizeDocument, unquoteString } from './tokenizer';

// Data-defining directives that, when immediately preceded by a bare identifier on the same line
// (no colon needed), implicitly define a label at that point — e.g. "tok_type rb TOK_CAP" or
// "err_open_prefix db 'message'" are equivalent to "tok_type: rb TOK_CAP". Mirrors manual.txt's
// own "Generating data" table exactly (every directive in it "is paired with a labeled instruction
// of the same name") — "emit" (synonym "dbx") is the table's variable-unit-size entry and gets the
// same implicit-label treatment as db/dw/etc., e.g. "counter emit 2: 0,1000,2000".
const DATA_DIRECTIVES: ReadonlySet<string> = new Set([
  'db', 'dw', 'dd', 'dp', 'df', 'dq', 'dt', 'ddq', 'dqq', 'ddqq', 'du',
  'rb', 'rw', 'rd', 'rp', 'rf', 'rq', 'rt', 'rdq', 'rqq', 'rdqq', 'file',
  'emit', 'dbx',
]);

/** fasmg's own built-in pseudo-variables ($, $$, $@, $%, $%%, %, %%) are always case-insensitive
 * and redefinable (manual.txt's "Basic symbol definitions" section) — real code exploits this to
 * temporarily override one inside a "virtual at" trick (e.g. fasm2's own source/macos/macho.inc:
 * "$%? = $%?-($-address)", adjusting "$%" for the duration of a `store`/`load` at an already-
 * generated output offset). Registering that as an ordinary workspace-wide constant named "$%"
 * would pollute hover's "defined elsewhere in the workspace" fallback for every other file's
 * genuine, unrelated use of the real "$%" built-in — hover.ts's own SPECIAL_SYMBOLS already
 * explains the built-in meaning and must stay reachable instead.
 */
const BUILTIN_PSEUDO_VARIABLES: ReadonlySet<string> = new Set(['$', '$$', '$@', '$%', '$%%', '%', '%%']);

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

/**
 * One open loop block (`repeat` or `iterate`) and the concrete values its control variables take.
 *
 * fasmg packages define whole families of names in bulk by concatenating a loop variable onto a
 * stem with `#`, so the names a programmer actually writes exist nowhere literally in the source.
 * Both loop forms are reduced to the same thing here — a variable bound to an ordered list of
 * values — because the two idioms differ only in where those values come from:
 *
 *     repeat 31, i:0                     iterate <instr,opcode>, jo,70h, jno,71h, ...
 *         element x#i : ...                  calminstruction instr? dest*
 *     end repeat                         end iterate
 *     -> x0 ... x30                      -> jo, jno, ...
 *
 * Tracked separately from `blockStack` so that recognizing these here cannot change how the
 * existing block tracking classifies a top-level `format`/`org`.
 */
interface LoopFrame {
  values: Map<string, string[]>;
}

/** Upper bound on how many names one loop may contribute. Real instruction/register families are
 * small (aarch64's largest register file is 32; x86's biggest conditional-jump table is 30), while
 * `repeat` in ordinary code routinely runs thousands of iterations to generate data — expanding
 * one of those would flood completion with junk, so an over-long loop is skipped entirely rather
 * than partially expanded. */
const MAX_LOOP_EXPANSION = 256;

/** Looks a loop variable up across the open loops, innermost first. */
function loopValues(frames: LoopFrame[], varName: string): string[] | undefined {
  for (let i = frames.length - 1; i >= 0; i--) {
    const values = frames[i].values.get(varName);
    if (values) return values;
  }
  return undefined;
}

/**
 * Collects a declared name written as `#`-concatenated parts starting at `startIdx`, e.g. the
 * `instr#ps?` of `macro instr#ps? dest*,src*`. Adjacency is required (no spaces), which is what
 * separates a concatenated name from the parameter list that follows it.
 */
function concatenatedNameParts(tokens: Token[], startIdx: number): Token[] {
  const parts: Token[] = [];
  let i = startIdx;
  while (tokens[i] && tokens[i].type === TokenType.Ident) {
    parts.push(tokens[i]);
    const hash = tokens[i + 1];
    const next = tokens[i + 2];
    const joined =
      hash?.type === TokenType.Punct && hash.text === '#' &&
      next?.type === TokenType.Ident &&
      hash.startChar === tokens[i].endChar && next.startChar === hash.endChar;
    if (!joined) break;
    i += 2;
  }
  return parts;
}

/**
 * Expands a `#`-concatenated declared name against the open loops, returning one entry per
 * iteration. Exactly one of the parts may be a loop variable — every real use names a family by
 * varying a single value (`x#i`, `instr#ps`, `uint#N`) — so anything more involved is left
 * unexpanded rather than guessed at.
 */
function expandLoopName(parts: Token[], frames: LoopFrame[]): Array<{ name: string; value: string }> | undefined {
  // A declared name may carry fasmg's trailing "?" weak marker directly on the loop variable
  // ("calminstruction instr? dest*", how 8086.inc declares all 30 conditional jumps), so the
  // marker has to be stripped before the variable can be recognized.
  const varNameOf = (p: Token): string | undefined => {
    if (loopValues(frames, p.text)) return p.text;
    const stripped = baseName(p.text);
    return loopValues(frames, stripped) ? stripped : undefined;
  };

  const varNames = parts.map(varNameOf);
  const bound = varNames.filter((n): n is string => n !== undefined);
  if (bound.length !== 1) return undefined;

  const values = loopValues(frames, bound[0])!;
  if (values.length > MAX_LOOP_EXPANSION) return undefined;

  return values.map((value) => ({
    name: baseName(parts.map((p, i) => (varNames[i] !== undefined ? value : p.text)).join('')),
    value,
  }));
}

/** Splits a comma-separated token run on its top-level commas only, joining each group's text.
 * Bracket depth is tracked so a nested `<a,b>` group counts as one item. */
function splitLoopValues(tokens: Token[]): string[] {
  const items: string[] = [];
  let current = '';
  let depth = 0;
  for (const t of tokens) {
    if (t.type === TokenType.Punct && '<([{'.includes(t.text)) depth++;
    else if (t.type === TokenType.Punct && '>)]}'.includes(t.text)) depth--;
    else if (t.type === TokenType.Punct && t.text === ',' && depth === 0) {
      items.push(current.trim());
      current = '';
      continue;
    }
    current += t.text;
  }
  items.push(current.trim());
  return items.filter((s) => s.length > 0);
}

/**
 * Parses an `iterate` header into its variable bindings, or undefined when the value list is not
 * a literal one. Both shapes appear in real packages:
 *
 *     iterate N, 8,16,32                              -> N = 8, 16, 32
 *     iterate <instr,opcode>, jo,70h, jno,71h         -> instr = jo, jno   opcode = 70h, 71h
 *
 * `iterate arg, args` (a list held in a variable) is deliberately rejected: its values are only
 * known once macros are expanded, which this parser never does.
 */
function parseIterateHeader(tokens: Token[]): LoopFrame | undefined {
  let vars: string[];
  let rest: Token[];

  if (tokens[1]?.type === TokenType.Punct && tokens[1].text === '<') {
    const close = tokens.findIndex((t, i) => i > 1 && t.type === TokenType.Punct && t.text === '>');
    if (close === -1) return undefined;
    vars = tokens.slice(2, close).filter((t) => t.type === TokenType.Ident).map((t) => t.text);
    rest = tokens.slice(close + 2); // skip ">" and the "," after it
  } else {
    if (tokens[1]?.type !== TokenType.Ident) return undefined;
    vars = [tokens[1].text];
    rest = tokens.slice(3); // skip the variable and the "," after it
  }

  if (vars.length === 0) return undefined;
  const items = splitLoopValues(rest);
  // A single item for a single variable is a list held in a variable, not a literal list.
  if (items.length === vars.length && vars.length === 1) return undefined;
  if (items.length === 0 || items.length % vars.length !== 0) return undefined;

  const values = new Map<string, string[]>();
  vars.forEach((name, offset) => {
    const bound: string[] = [];
    for (let i = offset; i < items.length; i += vars.length) bound.push(items[i]);
    values.set(name, bound);
  });
  return { values };
}

/** Parses a `repeat <count>[, <var>:<start>]` header into the same binding form. A non-literal
 * count yields an empty frame, so nothing expands but nesting stays balanced against
 * `end repeat`. */
function parseRepeatHeader(tokens: Token[]): LoopFrame {
  const countTok = tokens[1];
  const varTok = tokens[3];
  const startTok = tokens[5];
  const count = countTok?.type === TokenType.Number ? Number(countTok.text) : NaN;
  const start = startTok?.type === TokenType.Number ? Number(startTok.text) : NaN;
  const hasCounter =
    varTok?.type === TokenType.Ident &&
    tokens[2]?.type === TokenType.Punct && tokens[2].text === ',' &&
    tokens[4]?.type === TokenType.Punct && tokens[4].text === ':' &&
    Number.isSafeInteger(count) && Number.isSafeInteger(start) &&
    count >= 0 && count <= MAX_LOOP_EXPANSION;

  const values = new Map<string, string[]>();
  if (hasCounter) {
    values.set(varTok.text, Array.from({ length: count }, (_, i) => String(start + i)));
  }
  return { values };
}

export function parseDocument(uri: string, version: number, text: string, dialect: Dialect): ParsedDocument {
  const symbols: SymbolDefinition[] = [];
  const references: SymbolReference[] = [];
  const includes: IncludeDirective[] = [];
  const possibleInstances: PossibleInstance[] = [];
  let formatDirective: string | undefined;
  let hasTopLevelOrg = false;
  /** See ParsedDocument.statementWords. */
  const statementWords = new Set<string>();
  let inImportList = false;

  const blockStack: string[] = [];
  const macroFrames: MacroFrame[] = [];
  const loopFrames: LoopFrame[] = [];
  /** Accumulated tokens of an `iterate` header still being continued across lines with a trailing
   * "\" — its value list is regularly long enough to be wrapped (fasmg's own 8086.inc splits the
   * 30-entry conditional-jump table over two lines). */
  let pendingIterate: Token[] | undefined;
  let lastGlobalLabel: string | undefined;
  /** The outermost currently-open `struct ... ends` block's own name/nameRange — real fasmg's
   * struct package (macro/struct.inc) wraps a struct's *entire* body in `namespace <name>`, so
   * every field's real, canonically-referenced name outside the struct is fully qualified
   * ("StructName.field"), and closing the struct auto-generates a companion "sizeof.StructName"
   * constant (struct.inc's own `close_struct:` label: "arrange sym, =sizeof.pname / publish sym,
   * tmp") — see both usages below. Only set for the *outermost* struct: a real nested/anonymous
   * `struct`/`union` sub-block (struct.inc supports this for e.g. packed union layouts) stays
   * inside the same single outer namespace, so its fields still qualify under the outer struct's
   * name, not the inner one. */
  let currentStruct: { name: string; nameRange: Range } | undefined;

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

      // Whatever stands in instruction position on this line, recorded before any of the
      // directive handlers below consume the line. "label: mnemonic" counts too, since the colon
      // ends the label and what follows begins a statement.
      if (kw0) statementWords.add(kw0);
      if (tokens[1]?.type === TokenType.Punct && tokens[1].text === ':' && tokens[2]?.type === TokenType.Ident) {
        statementWords.add(tokens[2].text.toLowerCase());
      }

      // --- continuation of an `iterate` header wrapped with a trailing "\" ---
      if (pendingIterate) {
        const last = tokens[tokens.length - 1];
        const continues = last.type === TokenType.Punct && last.text === '\\';
        pendingIterate.push(...(continues ? tokens.slice(0, -1) : tokens));
        if (!continues) {
          loopFrames.push(parseIterateHeader(pendingIterate) ?? { values: new Map() });
          pendingIterate = undefined;
        }
        collectReferences(tokens, uri, references);
        continue;
      }

      // --- block end tracking (end macro / ends / end virtual / end namespace) ---
      if (kw0 === 'end' && tokens[1]) {
        const what = lower(tokens[1]);
        if (what === 'repeat' || what === 'iterate') loopFrames.pop();
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
            if (popped === 'macro' || popped === 'calminstruction' || popped === 'struc') {
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
        // Only the *outermost* struct's close actually finalizes the size and publishes
        // "sizeof.<name>" in real fasmg (struct.inc's collect? only reaches its own
        // "asm end namespace" / "sizeof.pname" publish once its nesting accumulator is fully
        // unwound) — a nested/anonymous sub-struct's own "ends" just closes that inner layout
        // block, no new sizeof symbol of its own.
        if (currentStruct && !blockStack.includes('struct')) {
          symbols.push({
            name: `sizeof.${currentStruct.name}`,
            kind: SymbolKind.Constant,
            range: currentStruct.nameRange,
            nameRange: currentStruct.nameRange,
            value: currentStruct.name,
            definedVia: 'struct-size',
            uri,
          });
          currentStruct = undefined;
        }
        continue;
      }

      // --- include 'path' ---
      if (kw0 === 'include' && tokens[1] && tokens[1].type === TokenType.String) {
        includes.push({
          path: unquoteString(tokens[1].text),
          quote: tokens[1].text[0],
          range: tokenRange(tokens[1]),
          uri,
        });
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

      // --- macro/calminstruction/struc NAME params... — the three macro-like block definitions,
      // identical in shape (name with optional "?" weak / "!" unconditional markers, parameter
      // list, body closed by "end <same keyword>"), all indexed as SymbolKind.Macro:
      //   - "calminstruction": fasmg implements virtually every real x86 instruction this way
      //     (e.g. the "fld?"/"fadd"-family/"xcall") — without this, none of them had any
      //     SymbolDefinition at all, so hover/go-to-definition found nothing unless the name
      //     happened to already be hardcoded in this extension's own static instructions.json.
      //     A command-namespaced name ("calminstruction?.xcall?") additionally reduces to the
      //     bare command name real call sites use (see calmCommandBareName).
      //   - "struc": the core "labeled macroinstruction" directive that fasmg's own "struct"
      //     convenience macro is itself built on top of (manual.txt section 9) — defined exactly
      //     like "macro", just invoked as "label struc-name args" instead of a plain instruction.
      //     Real code writes raw "struc" directly often enough (e.g. fasmg's own
      //     packages/x86/include/format/pe.inc) that leaving it unrecognized would mean no
      //     hover/go-to-definition for every one of those, unlike the "struct" wrapper macro
      //     which already gets its own SymbolDefinition below.
      if ((kw0 === 'macro' || kw0 === 'calminstruction' || kw0 === 'struc') && tokens[1] && tokens[1].type === TokenType.Ident) {
        const nameTok = tokens[1];
        const cleaned = baseName(nameTok.text);
        const isWeak = nameTok.text.length > 1 && nameTok.text.endsWith('?');
        const { tokens: paramTokens, isUnconditional } = paramsAfterMacroName(nameTok, tokens);
        const range = lineRange(nameTok.line, t0.startChar, tokens[tokens.length - 1].endChar);
        const params = paramsFromTokens(paramTokens);

        // Whole instruction families are declared by naming the macro after an enclosing loop's
        // variable rather than spelling each one out — fasmg's own 8086.inc defines all 30
        // conditional jumps as a single `calminstruction instr?` inside an `iterate`, and sse.inc
        // builds addps/mulps/subps/... from `macro instr#ps?`. Without expanding these, the names
        // real code writes have no definition at all.
        const expanded = expandLoopName(concatenatedNameParts(tokens, 1), loopFrames);
        const names = expanded
          ? expanded.map((e) => e.name)
          : [kw0 === 'calminstruction' ? (calmCommandBareName(cleaned) ?? cleaned) : cleaned];

        for (const rawName of names) {
          const name = kw0 === 'calminstruction' && !expanded ? rawName : (calmCommandBareName(rawName) ?? rawName);
          const sym: SymbolDefinition = {
            name,
            kind: SymbolKind.Macro,
            range,
            nameRange: tokenRange(nameTok),
            params,
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
        }
        blockStack.push(kw0);
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
        if (!currentStruct) currentStruct = { name: nameTok.text, nameRange: tokenRange(nameTok) };
        blockStack.push('struct');
        continue;
      }

      if (kw0 === 'virtual' || kw0 === 'namespace') {
        blockStack.push(kw0);
        continue;
      }

      // --- repeat <count>[, <var>:<start>] / iterate <var>|<vars>, values... ---
      // Tracked so that names generated inside the body (see expandLoopName) can be expanded. A
      // frame is pushed for every loop, including forms nothing can be derived from, so that
      // nesting stays balanced against the matching `end`; such a frame simply binds no variables.
      if (kw0 === 'repeat' || kw0 === 'iterate') {
        const last = tokens[tokens.length - 1];
        const continues = kw0 === 'iterate' && last.type === TokenType.Punct && last.text === '\\';
        if (continues) {
          pendingIterate = tokens.slice(0, -1);
        } else {
          loopFrames.push(kw0 === 'repeat' ? parseRepeatHeader(tokens) : parseIterateHeader(tokens) ?? { values: new Map() });
        }
        // A non-literal count or list is usually a named constant or a macro parameter
        // ("repeat BUFFER_SIZE", "iterate arg, args"), so the operands still carry real references
        // even when nothing here defines a symbol.
        collectReferences(tokens.slice(1), uri, references);
        continue;
      }

      // --- proc NAME params... (packages/x86/include/macro/proc32.inc's "proc?" macro) ---
      // Not a core directive, but its own body does "match name declaration, statement : if used
      // name / name: / namespace name" -- so "proc NAME ..." genuinely defines NAME as a real,
      // callable label, exactly like writing "NAME:" by hand. Without this, virtually every real
      // fasmg Windows program's own procedures (e.g. fasm2's own fasmgw.asm: "proc MainWindow
      // hwnd,wmsg,wparam,lparam") have no SymbolDefinition at all: no hover, no go-to-definition,
      // no workspace symbol search, despite being the single most common way to define a function.
      if (kw0 === 'proc' && tokens[1] && tokens[1].type === TokenType.Ident) {
        const nameTok = tokens[1];
        symbols.push({
          name: nameTok.text,
          kind: SymbolKind.Label,
          range: lineRange(nameTok.line, t0.startChar, tokens[tokens.length - 1].endChar),
          nameRange: tokenRange(nameTok),
          params: paramsFromTokens(tokens.slice(2)),
          uri,
        });
        lastGlobalLabel = nameTok.text;
        continue;
      }

      // --- label NAME [size] at EXPR ---
      // tokens[1] must not itself be a data directive: fasmg's own packages/x86/include/macro/
      // resource.inc's "dialog" macro and macro/import64.inc's "import?" macro both have a macro
      // parameter literally named "label" (shadowing the directive within that macro's body), and
      // write it back as e.g. "label dd RVA data,size,0,0" / "label dq RVA name.label" — the
      // *implicit* data-label pattern below, not an invocation of this "label" directive at all.
      // Without this guard, "dd"/"dq" (a TokenType.Ident, same as any name) got misindexed as the
      // label's own declared name, both hiding the real definition and polluting workspace symbol
      // search/completion with a bogus "dd"/"dq" label — the same bug class already fixed in the
      // syntax-highlight grammar for this exact pair of real files.
      if (kw0 === 'label' && tokens[1] && tokens[1].type === TokenType.Ident && !DATA_DIRECTIVES.has(lower(tokens[1]))) {
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
        if (BUILTIN_PSEUDO_VARIABLES.has(name)) continue;
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
        if (BUILTIN_PSEUDO_VARIABLES.has(name)) continue;
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

      // --- element NAME [: EXPR] / element NAME#<repeat var> [: EXPR] ---
      // A core fasmg directive (manual.txt "Symbolic values") that declares a named term usable in
      // expressions. Instruction-set packages use it to declare their register names — it's how
      // every aarch64 register is defined (packages/aarch64/iset/aarch64.inc) — so without this
      // none of them had a SymbolDefinition at all: no hover, no go-to-definition, and nothing to
      // offer in completion, for the identifiers such code uses on nearly every line.
      if (kw0 === 'element' && tokens[1] && tokens[1].type === TokenType.Ident) {
        const nameTok = tokens[1];
        // A real declaration is "element NAME", "element NAME : expr", or the generated
        // "element NAME#var : expr" — the name is always either the whole line or immediately
        // followed by ":". Requiring that shape keeps ordinary English prose from being read as a
        // declaration: KolibriOS's libGUI/SRC/malloc.inc carries a ported dlmalloc doc comment
        // with a line beginning "element may have a different size, and also that...", which
        // otherwise defined a symbol named "may".
        const nameParts = concatenatedNameParts(tokens, 1);
        const expanded = expandLoopName(nameParts, loopFrames);
        const afterHead = tokens[1 + (nameParts.length * 2 - 1)];
        if (afterHead && !(afterHead.type === TokenType.Punct && afterHead.text === ':')) continue;

        const colonIdx = tokens.findIndex((t) => t.type === TokenType.Punct && t.text === ':');
        const valueTokens = colonIdx >= 0 ? tokens.slice(colonIdx + 1) : [];
        const range = lineRange(t0.line, t0.startChar, tokens[tokens.length - 1].endChar);
        const loopVar = expanded ? nameParts.find((p) => loopValues(loopFrames, p.text) !== undefined)?.text : undefined;

        for (const { name, value: counter } of expanded ?? [{ name: baseName(nameTok.text), value: '' }]) {
          if (BUILTIN_PSEUDO_VARIABLES.has(name)) continue;
          // Substitute the loop counter into the displayed value, per token so a variable named
          // "i" can't be rewritten inside an unrelated identifier that merely contains it. Without
          // this, every generated register hovered as its raw source text — "x0 = aarch64.reg +
          // (i shl 0) + ..." — showing an "i" that is nowhere in scope at the point of use.
          const value =
            valueTokens.map((t) => (loopVar && t.type === TokenType.Ident && t.text === loopVar ? counter : t.text)).join(' ') || undefined;
          const sym: SymbolDefinition = {
            name,
            kind: SymbolKind.Constant,
            range,
            nameRange: tokenRange(nameTok),
            value,
            definedVia: 'element',
            uri,
          };
          symbols.push(sym);
          enclosingLocalFrame(name)?.pendingSymbols.push(sym);
        }
        if (colonIdx >= 0) collectReferences(valueTokens, uri, references);
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
        const isField = blockStack[blockStack.length - 1] === 'struct';
        symbols.push({
          name: t0.text,
          kind: isLocal ? SymbolKind.LocalLabel : SymbolKind.Label,
          range: lineRange(t0.line, t0.startChar, tokens[tokens.length - 1].endChar),
          nameRange: tokenRange(t0),
          parentLabel: isLocal ? lastGlobalLabel : undefined,
          value: tokens.slice(1).map((t) => t.text).join(' '),
          isStructField: isField,
          uri,
        });
        // fasmg's struct package wraps a struct's *entire* body in "namespace <structName>"
        // (macro/struct.inc's collect?), so a field's real, canonically-referenced name from
        // outside the struct is always fully qualified ("StructName.field", e.g. real code's own
        // "[ebx+MatchedExcerpt.matcher]") — never the bare field name alone. Indexed as its own,
        // separate symbol (not a rename of the bare one above) so both an internal same-struct-
        // body reference to the bare name and the overwhelmingly more common qualified external
        // reference resolve to something; scoping it to exactly this struct's own qualified name
        // also means two unrelated structs sharing a generic field name (e.g. two different
        // structs each with a "flags" field) can never cross-resolve to each other's field.
        if (isField && !isLocal && currentStruct) {
          symbols.push({
            name: `${currentStruct.name}.${t0.text}`,
            kind: SymbolKind.Label,
            range: lineRange(t0.line, t0.startChar, tokens[tokens.length - 1].endChar),
            nameRange: tokenRange(t0),
            value: tokens.slice(1).map((t) => t.text).join(' '),
            isStructField: true,
            uri,
          });
        }
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

      // --- IDENT1 IDENT2 [args...] (e.g. "assembly_workspace Workspace") — a candidate struct
      // instantiation; see PossibleInstance's own doc comment for why this is only ever recorded,
      // never trusted here. Scoped to top level (blockStack empty): a real instantiation is
      // ordinary global/segment-level data, not something written inside a macro/struct body.
      if (
        blockStack.length === 0 &&
        t0.type === TokenType.Ident &&
        !NON_SYMBOL_IDENTIFIERS.has(t0.text.toLowerCase()) &&
        tokens[1]?.type === TokenType.Ident &&
        !NON_SYMBOL_IDENTIFIERS.has(tokens[1].text.toLowerCase())
      ) {
        possibleInstances.push({
          name: t0.text,
          typeName: tokens[1].text,
          nameRange: tokenRange(t0),
          range: lineRange(t0.line, t0.startChar, tokens[tokens.length - 1].endChar),
        });
      }

      // Anything else on the line is treated as instruction/operand text; harvest bare
      // identifiers as best-effort references for go-to-definition.
      collectReferences(tokens, uri, references);
    }
  } catch {
    // Never let a parse failure propagate — degrade to whatever was collected so far.
  }

  return { uri, version, dialect, symbols, references, includes, possibleInstances, formatDirective, hasTopLevelOrg, statementWords: [...statementWords] };
}

function collectReferences(tokens: Token[], uri: string, out: SymbolReference[]): void {
  for (const t of tokens) {
    if (t.type === TokenType.Ident && !NON_SYMBOL_IDENTIFIERS.has(t.text.toLowerCase())) {
      out.push({ name: t.text, range: tokenRange(t), uri });
    }
  }
}
