import { CompletionItem, CompletionItemKind, InsertTextFormat } from 'vscode-languageserver/node';
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

export function getCompletions(workspace: Workspace, uri: string, dialect: Dialect): CompletionItem[] {
  const { items: staticItems, labels } = getStaticItemsCache(dialect, detectIsa(workspace, uri, dialect));
  const items = [...staticItems];
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
      items.push({
        label: sym.name,
        kind: SYMBOL_KIND_TO_COMPLETION[sym.kind],
        detail: sym.params ? `${sym.kind} ${sym.name} ${sym.params}` : sym.kind,
        documentation: sym.value ? `= ${sym.value}` : undefined,
      });
    }
  }

  return items;
}
