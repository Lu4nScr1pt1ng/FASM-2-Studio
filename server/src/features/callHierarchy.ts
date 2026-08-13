// Call hierarchy: "what reaches this label, and what does this label reach".
//
// In assembly that question is the navigation question — a label is a routine, and the only way to
// know whether one is dead, or who would notice if it changed, is to walk the edges. Find-all-
// references answers it as a flat list of line numbers with no structure and no direction; this is
// the same information as a tree you can expand.
//
// An edge here is *any* reference to a label, not just one under a `call`. That is deliberate.
// Restricting to a mnemonic list would mean picking one: `call` alone misses every tail call
// written as `jmp`, and the full set of x86 conditional jumps (`jz`, `jne`, `loopne`, ...) is both
// long and wrong for every other instruction set fasmg can assemble — the very thing this server
// refuses to assume elsewhere. Taking every reference costs a data label's `dd handler` showing up
// as an edge, which is honest: that is exactly how a jump table is reached.

import { CallHierarchyIncomingCall, CallHierarchyItem, CallHierarchyOutgoingCall, Range } from 'vscode-languageserver/node';
import { toLspRange } from '../lspUtils';
import { Dialect, ParsedDocument, SymbolDefinition, SymbolKind } from '../types';
import { Workspace } from '../workspace';
import { SYMBOL_KIND_MAP } from './symbolKindMap';

/** The symbol kinds worth building a hierarchy over. A constant or a section is not something other
 * code "reaches" in any sense this view could show usefully. */
const CALLABLE_KINDS = new Set<SymbolKind>([SymbolKind.Label, SymbolKind.LocalLabel, SymbolKind.Macro]);

/** Cap on edges reported for one node. A label referenced thousands of times (a macro from a big
 * package) would otherwise build a tree no one can read out of a response no one asked for. */
const MAX_EDGES = 200;

/** Carried through the client and handed back on the incoming/outgoing requests, so neither has to
 * re-derive which symbol an item stands for from its range alone. */
interface ItemData {
  name: string;
  uri: string;
  line: number;
}

function itemFor(symbol: SymbolDefinition, bodyEnd: number): CallHierarchyItem {
  const data: ItemData = { name: symbol.name, uri: symbol.uri, line: symbol.range.startLine };
  return {
    name: symbol.name,
    kind: SYMBOL_KIND_MAP[symbol.kind],
    uri: symbol.uri,
    // The whole routine, so selecting the item in the tree reveals its body...
    range: { start: { line: symbol.range.startLine, character: 0 }, end: { line: bodyEnd, character: Number.MAX_SAFE_INTEGER } },
    // ...while the cursor lands on the name itself.
    selectionRange: toLspRange(symbol.nameRange),
    detail: symbol.kind === SymbolKind.Macro ? (symbol.params ? `macro ${symbol.params}` : 'macro') : undefined,
    data,
  };
}

/**
 * Where a routine's body ends: the line before the next definition of the same rank in the same
 * file, or end of file.
 *
 * A global label owns everything up to the next global label — its own local (`.dot`) labels
 * included, since those are part of the routine rather than routines of their own. That is what
 * makes "which routine is this reference inside" answerable at all: assembly has no closing brace
 * to delimit one.
 */
function bodyEndLine(doc: ParsedDocument, symbol: SymbolDefinition, totalLines: number): number {
  const sameRank = (s: SymbolDefinition): boolean =>
    symbol.kind === SymbolKind.LocalLabel ? CALLABLE_KINDS.has(s.kind) : s.kind !== SymbolKind.LocalLabel && CALLABLE_KINDS.has(s.kind);

  let end = totalLines;
  for (const other of doc.symbols) {
    if (other === symbol || !sameRank(other)) continue;
    if (other.range.startLine > symbol.range.startLine && other.range.startLine < end) end = other.range.startLine;
  }
  return Math.max(symbol.range.startLine, end - 1);
}

/** Line count of a document, without needing the text: the last line any symbol or reference in it
 * mentions is a sufficient upper bound for delimiting the final routine. */
function lastKnownLine(doc: ParsedDocument): number {
  let last = 0;
  for (const sym of doc.symbols) last = Math.max(last, sym.range.endLine);
  for (const ref of doc.references) last = Math.max(last, ref.range.endLine);
  for (const inc of doc.includes) last = Math.max(last, inc.range.endLine);
  return last + 1;
}

/** The callable symbol whose body contains `line` in `doc` — the routine a reference sits inside.
 * Prefers a local label over the global label enclosing it, since that is the nearer answer. */
function enclosingRoutine(doc: ParsedDocument, line: number): SymbolDefinition | undefined {
  let best: SymbolDefinition | undefined;
  for (const sym of doc.symbols) {
    if (!CALLABLE_KINDS.has(sym.kind)) continue;
    if (sym.range.startLine > line) continue;
    if (!best || sym.range.startLine > best.range.startLine) best = sym;
  }
  return best;
}

/**
 * The definition `name` resolves to, searching the include graph first — what the assembler would
 * use — and falling back to a workspace-wide name lookup, the same two-step definition.ts already
 * applies. The fallback is what keeps the tree connected across a file that is part of the project
 * but not (yet) `include`d from the one being read.
 */
function resolveCallable(workspace: Workspace, fromUri: string, dialect: Dialect, name: string): SymbolDefinition | undefined {
  const reachable = workspace.findDefinitions(fromUri, name, dialect).find((s) => CALLABLE_KINDS.has(s.kind));
  return reachable ?? workspace.findSymbolAnywhere(name).find((s) => CALLABLE_KINDS.has(s.kind));
}

/** The item the cursor is on, or nothing if this position is not a routine the tree can be rooted
 * at. */
export function prepareCallHierarchy(workspace: Workspace, uri: string, dialect: Dialect, word: string): CallHierarchyItem[] {
  const symbol = resolveCallable(workspace, uri, dialect, word);
  if (!symbol) return [];

  const doc = workspace.getDocument(symbol.uri);
  if (!doc) return [];
  return [itemFor(symbol, bodyEndLine(doc, symbol, lastKnownLine(doc)))];
}

function dataOf(item: CallHierarchyItem): ItemData | undefined {
  const data = item.data as ItemData | undefined;
  return data && typeof data.name === 'string' ? data : undefined;
}

/** Every routine that mentions this one, with the reference sites that do the mentioning. */
export function incomingCalls(workspace: Workspace, item: CallHierarchyItem): CallHierarchyIncomingCall[] {
  const data = dataOf(item);
  if (!data) return [];

  const byCaller = new Map<string, { item: CallHierarchyItem; ranges: Range[] }>();

  for (const ref of workspace.findReferences(data.name, false).slice(0, MAX_EDGES)) {
    const range = 'nameRange' in ref ? ref.nameRange : ref.range;
    const doc = workspace.getDocument(ref.uri);
    if (!doc) continue;
    const caller = enclosingRoutine(doc, range.startLine);
    // A reference above the first label in its file belongs to no routine — a `dd handler` in a
    // data section, most often. There is nothing to hang it under, and inventing a node for the
    // file itself would put something in the tree that is not a caller.
    if (!caller) continue;
    // A routine's own recursive reference to itself is a real edge; its *definition* is not.
    if (caller.uri === data.uri && caller.range.startLine === data.line && range.startLine === data.line) continue;

    const key = `${caller.uri}\0${caller.range.startLine}`;
    const existing = byCaller.get(key);
    if (existing) {
      existing.ranges.push(toLspRange(range));
    } else {
      byCaller.set(key, {
        item: itemFor(caller, bodyEndLine(doc, caller, lastKnownLine(doc))),
        ranges: [toLspRange(range)],
      });
    }
  }

  return [...byCaller.values()].map(({ item: from, ranges }) => ({ from, fromRanges: ranges }));
}

/** Every routine this one mentions, with the sites inside its body that mention them. */
export function outgoingCalls(workspace: Workspace, dialect: Dialect, item: CallHierarchyItem): CallHierarchyOutgoingCall[] {
  const data = dataOf(item);
  if (!data) return [];
  const doc = workspace.getDocument(data.uri);
  if (!doc) return [];

  const self = doc.symbols.find((s) => s.name === data.name && s.range.startLine === data.line);
  if (!self) return [];
  const end = bodyEndLine(doc, self, lastKnownLine(doc));

  const byCallee = new Map<string, { item: CallHierarchyItem; ranges: Range[] }>();

  for (const ref of doc.references) {
    if (ref.range.startLine < data.line || ref.range.startLine > end) continue;
    if (byCallee.size >= MAX_EDGES) break;

    const target = resolveCallable(workspace, data.uri, dialect, ref.name);
    if (!target) continue;
    // The routine's own name on its own definition line is not a call out of itself.
    if (target.uri === data.uri && target.range.startLine === data.line && ref.range.startLine === data.line) continue;

    const key = `${target.uri}\0${target.range.startLine}`;
    const existing = byCallee.get(key);
    if (existing) {
      existing.ranges.push(toLspRange(ref.range));
    } else {
      const targetDoc = workspace.getDocument(target.uri);
      if (!targetDoc) continue;
      byCallee.set(key, {
        item: itemFor(target, bodyEndLine(targetDoc, target, lastKnownLine(targetDoc))),
        ranges: [toLspRange(ref.range)],
      });
    }
  }

  return [...byCallee.values()].map(({ item: to, ranges }) => ({ to, fromRanges: ranges }));
}
