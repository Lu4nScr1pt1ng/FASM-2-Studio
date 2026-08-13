import { CompletionItem, CompletionItemKind, InsertTextFormat } from 'vscode-languageserver/node';
import { TokenType, tokenizeLine } from '../parser/tokenizer';
import { detectIsa, Isa } from '../isa';
import { Dialect, ParsedDocument, SymbolKind } from '../types';
import { Workspace } from '../workspace';
import directivesData from '../data/directives.json';
import instructionsData from '../data/instructions.json';
import registersData from '../data/registers.json';
import formatKeywordsData from '../data/formatKeywords.json';
import sizeSpecifiersData from '../data/sizeSpecifiers.json';
import { DirectiveEntry, FormatKeywordEntry, InstructionEntry, RegisterEntry, SizeSpecifierEntry } from '../types';
import { LOGICAL_OPERATORS, VALUE_OPERATORS } from './hover';

// Only the word-like keys (not bare punctuation like "~"/"&"/"|", which aren't something a user
// ever types a prefix of to trigger completion for) — e.g. "defined", "eqtype", "relativeto",
// "scale", "trunc". Without this, none of hover.ts's own logical/value operators ever surfaced in
// completion at all, unlike every other keyword family (directives, mnemonics, ...) that does.
const WORD_LIKE = /^[A-Za-z][A-Za-z0-9]*$/;

const directives = directivesData as DirectiveEntry[];
const instructions = instructionsData as InstructionEntry[];
const registers = registersData as RegisterEntry[];
const formatKeywords = formatKeywordsData as FormatKeywordEntry[];
const sizeSpecifiers = sizeSpecifiersData as SizeSpecifierEntry[];

const SYMBOL_KIND_TO_COMPLETION: Record<SymbolKind, CompletionItemKind> = {
  [SymbolKind.Label]: CompletionItemKind.Reference,
  [SymbolKind.LocalLabel]: CompletionItemKind.Reference,
  [SymbolKind.Constant]: CompletionItemKind.Constant,
  [SymbolKind.Macro]: CompletionItemKind.Function,
  [SymbolKind.Struct]: CompletionItemKind.Struct,
  [SymbolKind.Section]: CompletionItemKind.Module,
};

let staticItemsCache: { dialect: Dialect; isa: Isa; items: CompletionItem[]; labels: Set<string> } | undefined;

function buildStaticItems(dialect: Dialect, isa: Isa): CompletionItem[] {
  const items: CompletionItem[] = [];

  // The instruction and register tables are x86-specific, so a document whose include graph
  // supplies its own instruction set must not be offered them: an aarch64 file was previously
  // offered all ~1400 x86 mnemonics plus rax/eax/al/xmm0, none of which exist on that CPU, while
  // its own `mov`/`add`/`ret` were dropped outright for colliding with those static labels (see
  // the dedup in getCompletions). Everything below — directives, format keywords, size
  // specifiers, operators — is fasmg engine syntax and applies to every ISA alike.
  if (isa === 'x86') {
    for (const ins of instructions) {
      items.push({
        label: ins.mnemonic,
        kind: CompletionItemKind.Keyword,
        detail: ins.operands ? `${ins.mnemonic} ${ins.operands}` : ins.mnemonic,
        documentation: ins.isa ? `${ins.summary} (${ins.isa})` : ins.summary,
      });
    }

    for (const reg of registers) {
      items.push({
        label: reg.name,
        kind: CompletionItemKind.Variable,
        detail: `${reg.group} register (${reg.bits}-bit)`,
      });
    }
  }

  for (const dir of directives) {
    if (dir.dialect !== 'both' && dir.dialect !== dialect) continue;
    const item: CompletionItem = {
      label: dir.name,
      kind: CompletionItemKind.Keyword,
      documentation: dir.summary,
    };
    if (dir.snippet) {
      item.insertText = dir.snippet;
      item.insertTextFormat = InsertTextFormat.Snippet;
    }
    items.push(item);
  }

  for (const fmt of formatKeywords) {
    items.push({
      label: fmt.name,
      kind: CompletionItemKind.Keyword,
      documentation: fmt.summary,
    });
  }

  for (const size of sizeSpecifiers) {
    items.push({
      label: size.name,
      kind: CompletionItemKind.Keyword,
      documentation: size.summary,
    });
  }

  for (const [word, doc] of Object.entries({ ...LOGICAL_OPERATORS, ...VALUE_OPERATORS })) {
    if (!WORD_LIKE.test(word)) continue;
    items.push({
      label: word,
      kind: CompletionItemKind.Operator,
      documentation: doc,
    });
  }

  return items;
}

/** Memoized alongside the static items themselves — labels is derived purely from `items`, so
 * rebuilding it from scratch on every completion request (this fires on every identifier
 * keystroke) would repeat the same ~1600-entry scan for a result that never changes between
 * dialect switches. */
function getStaticItemsCache(dialect: Dialect, isa: Isa): { items: CompletionItem[]; labels: Set<string> } {
  if (staticItemsCache?.dialect !== dialect || staticItemsCache.isa !== isa) {
    const items = buildStaticItems(dialect, isa);
    staticItemsCache = { dialect, isa, items, labels: new Set(items.map((i) => i.label)) };
  }
  return staticItemsCache;
}

/**
 * Every static name this dialect/ISA combination knows — mnemonics, registers, directives, format
 * keywords, size specifiers, word-like operators.
 *
 * Exposed because a second feature needs exactly this set for the opposite purpose: code actions
 * have to tell a misspelling apart from a name the assembler genuinely knows, and rebuilding that
 * list separately would let the two drift.
 */
export function staticKeywords(dialect: Dialect, isa: Isa): ReadonlySet<string> {
  return getStaticItemsCache(dialect, isa).labels;
}

/**
 * Where on a line the cursor is, as far as ranking is concerned.
 *
 * "statement" is the position a mnemonic or directive goes — the first token of a line, or the
 * first after a `label:`. "operand" is anything after that. The distinction is worth making
 * because the two positions want almost disjoint answers: at statement position a register name
 * is nearly always wrong, and in operand position a directive nearly always is.
 */
export type CompletionContext = 'statement' | 'operand';

/**
 * Classifies the cursor from the text before it on its own line.
 *
 * Tokenized rather than pattern-matched so a `;` inside a string (`db 'a ; b'`) is not read as a
 * comment, and so a trailing partially-typed word is correctly *excluded* — the word being typed
 * is not itself evidence of what position it is in.
 */
export function completionContext(linePrefix: string): CompletionContext {
  const tokens = tokenizeLine(linePrefix, 0).filter((t) => t.type !== TokenType.Comment);
  // Drop a word still being typed: it ends exactly where the cursor is.
  const complete = tokens.length > 0 && tokens[tokens.length - 1].endChar === linePrefix.length && tokens[tokens.length - 1].type === TokenType.Ident
    ? tokens.slice(0, -1)
    : tokens;

  if (complete.length === 0) return 'statement';
  // "label:" (or "label::") still leaves the cursor at statement position — this is the ordinary
  // way a line carries both a label and an instruction.
  const isLabelOnly =
    complete.length <= 3 &&
    complete[0].type === TokenType.Ident &&
    complete.slice(1).every((t) => t.type === TokenType.Punct && t.text === ':');
  return isLabelOnly && complete.length > 1 ? 'statement' : 'operand';
}

/**
 * Sort keys. LSP sorts by `sortText` lexicographically and falls back to `label`, so a single
 * leading digit is enough to build tiers without touching what is displayed or what matches.
 *
 * Nothing is ever *filtered* by context — a wrong guess would hide the one item the user wanted,
 * and this classification is a heuristic over a language where a macro can be named anything.
 * Ranking degrades gracefully where filtering does not.
 */
function sortTextFor(item: CompletionItem, context: CompletionContext): string {
  const isRegister = item.kind === CompletionItemKind.Variable;
  const isKeyword = item.kind === CompletionItemKind.Keyword;
  const isProjectSymbol = !isRegister && !isKeyword && item.kind !== CompletionItemKind.Operator;

  let tier: number;
  if (context === 'statement') {
    // Mnemonics and directives first, then the project's own macros/labels (a macro invocation is
    // a statement too), then registers last — they cannot open a statement.
    tier = isKeyword ? 0 : isProjectSymbol ? 1 : isRegister ? 3 : 2;
  } else {
    // In operand position: registers and the project's own constants/labels are what gets typed;
    // mnemonics almost never are.
    tier = isRegister ? 0 : isProjectSymbol ? 1 : isKeyword ? 3 : 2;
  }
  return `${tier}${item.label.toLowerCase()}`;
}

/**
 * Documentation is deliberately *not* attached here — see resolveCompletionItem. The x86 table
 * alone is ~1400 entries, and shipping a summary string for every one of them on every keystroke
 * is a payload the client immediately throws away for all but the one row the user highlights.
 */
export function getCompletions(workspace: Workspace, uri: string, dialect: Dialect, linePrefix = ''): CompletionItem[] {
  const { items: staticItems, labels } = getStaticItemsCache(dialect, detectIsa(workspace, uri, dialect));
  const context = completionContext(linePrefix);
  const items: CompletionItem[] = staticItems.map((item) => ({
    label: item.label,
    kind: item.kind,
    detail: item.detail,
    insertText: item.insertText,
    insertTextFormat: item.insertTextFormat,
    sortText: sortTextFor(item, context),
    // Round-tripped back to completionItem/resolve, which needs the originating document to know
    // which dialect and instruction-set tables the item came from.
    data: { uri },
  }));
  const seen = new Set<string>(labels);

  const doc: ParsedDocument | undefined = workspace.getDocument(uri);
  if (!doc) return items;

  for (const parsed of workspace.walkIncludeGraph(uri, dialect)) {
    for (const sym of parsed.symbols) {
      const key = `${sym.kind}:${sym.name}`;
      if (seen.has(key)) continue;
      // A struct field is unambiguous even when it happens to spell a real directive/register (e.g.
      // "segment"/"offset", both real field names in fasmg's own packages/x86/projects/challenger/
      // challenger.asm) — same carve-out hover.ts/symbolIndex.ts already give it ahead of the
      // context-free keyword lookup. Without this, such a field never appeared in completion at all.
      if (!sym.isStructField && seen.has(sym.name)) continue;
      seen.add(key);
      const item: CompletionItem = {
        label: sym.name,
        kind: SYMBOL_KIND_TO_COMPLETION[sym.kind],
        detail: sym.params ? `${sym.kind} ${sym.name} ${sym.params}` : sym.kind,
        documentation: sym.value ? `= ${sym.value}` : undefined,
      };
      // A project symbol's documentation is one already-parsed string, not a table lookup, so
      // there is nothing to defer — unlike the static tables, it costs nothing to send now.
      item.sortText = sortTextFor(item, context);
      items.push(item);
    }
  }

  return items;
}

/**
 * Fills in the documentation for one static item, on demand.
 *
 * This is the other half of dropping `documentation` from getCompletions: the client asks for it
 * only for the row the user actually highlights, so the per-keystroke payload loses ~1600
 * summary strings while the visible result is identical.
 */
export function resolveCompletionItem(item: CompletionItem, dialect: Dialect, isa: Isa): CompletionItem {
  if (item.documentation !== undefined) return item;
  const { items } = getStaticItemsCache(dialect, isa);
  const match = items.find((candidate) => candidate.label === item.label && candidate.kind === item.kind);
  return match ? { ...item, documentation: match.documentation, detail: item.detail ?? match.detail } : item;
}
