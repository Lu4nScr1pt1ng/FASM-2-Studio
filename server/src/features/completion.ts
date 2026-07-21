import { CompletionItem, CompletionItemKind, InsertTextFormat } from 'vscode-languageserver/node';
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

let staticItemsCache: { dialect: Dialect; items: CompletionItem[] } | undefined;

function buildStaticItems(dialect: Dialect): CompletionItem[] {
  const items: CompletionItem[] = [];

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

function getStaticItems(dialect: Dialect): CompletionItem[] {
  if (staticItemsCache?.dialect !== dialect) {
    staticItemsCache = { dialect, items: buildStaticItems(dialect) };
  }
  return staticItemsCache.items;
}

export function getCompletions(workspace: Workspace, uri: string, dialect: Dialect): CompletionItem[] {
  const items = [...getStaticItems(dialect)];
  const seen = new Set<string>(items.map((i) => i.label));

  const doc: ParsedDocument | undefined = workspace.getDocument(uri);
  if (!doc) return items;

  for (const parsed of workspace.walkIncludeGraph(uri, dialect)) {
    for (const sym of parsed.symbols) {
      const key = `${sym.kind}:${sym.name}`;
      if (seen.has(key) || seen.has(sym.name)) continue;
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
