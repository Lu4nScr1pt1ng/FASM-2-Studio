import * as fsSync from 'fs';
import * as fs from 'fs/promises';
import * as path from 'path';
import { URI } from 'vscode-uri';
import { parseDocument } from './parser/symbolIndex';
import { Dialect, ParsedDocument, SymbolDefinition, SymbolReference } from './types';

const MAX_INCLUDE_DEPTH = 8;
const MAX_INDEXED_FILE_BYTES = 2 * 1024 * 1024; // guard against accidentally indexing huge/binary files
const MAX_INDEXED_FILES = 20_000; // generous bound for a single-workspace asm project, not a hard business limit
const INDEX_BATCH_SIZE = 40; // files parsed per tick before yielding back to the event loop

export type DialectResolver = (uri: string, text: string) => Dialect;

interface Contribution {
  symbolNames: Set<string>;
  refNames: Set<string>;
}

/**
 * Tracks parsed state for three layers, checked in this priority order everywhere a document is
 * looked up:
 *   1. openDocuments    — live editor buffers, authoritative even if they have unsaved changes.
 *   2. indexedDocuments — every workspace file reached by indexWorkspace()/watcher sync, parsed
 *                         once and kept warm in memory (no per-request disk I/O).
 *   3. externalDiskCache — on-demand, lazily-populated cache for `include` targets that resolve
 *                         *outside* the workspace (e.g. the compiler's own system include dir) —
 *                         those aren't covered by the workspace scan, so they're read the first
 *                         time something actually references them, then cached.
 *
 * findReferences/findSymbolAnywhere/findWorkspaceSymbols are backed by a name-indexed global map
 * (symbolsByName/referencesByName) rather than scanning every known document on every call: each
 * mutation (open/edit/index/close/remove) does O(that one document's symbol count) work to keep
 * the index in sync, so a lookup that used to cost O(every document × its symbols) is an O(1)
 * average Map access instead — the cost moves from "every keystroke-triggered rename preview" to
 * "the edit that already happened anyway", which is the right side of that trade for an editor.
 */
export class Workspace {
  private readonly openDocuments = new Map<string, ParsedDocument>();
  private readonly indexedDocuments = new Map<string, ParsedDocument>();
  private readonly externalDiskCache = new Map<string, ParsedDocument | null>();

  private readonly symbolsByName = new Map<string, SymbolDefinition[]>();
  private readonly referencesByName = new Map<string, SymbolReference[]>();
  private readonly contributions = new Map<string, Contribution>();

  updateDocument(uri: string, version: number, text: string, dialect: Dialect): ParsedDocument {
    const parsed = parseDocument(uri, version, text, dialect);
    this.openDocuments.set(uri, parsed);
    this.externalDiskCache.delete(uri);
    this.syncGlobalIndex(uri);
    return parsed;
  }

  removeDocument(uri: string): void {
    this.openDocuments.delete(uri);
    this.syncGlobalIndex(uri);
  }

  getDocument(uri: string): ParsedDocument | undefined {
    return this.openDocuments.get(uri) ?? this.indexedDocuments.get(uri);
  }

  /**
   * Parses and caches every given workspace file, in small batches with an event-loop yield
   * between each — so a large project never makes hover/completion/diagnostics wait behind a
   * long synchronous indexing pass. Safe to call again (e.g. on workspace folder changes); files
   * already open in an editor are left to their live buffer rather than re-read from disk.
   */
  async indexWorkspace(uris: string[], resolveDialect: DialectResolver): Promise<{ indexed: number; skipped: number }> {
    let indexed = 0;
    let skipped = 0;
    const capped = uris.slice(0, MAX_INDEXED_FILES);

    for (let i = 0; i < capped.length; i += INDEX_BATCH_SIZE) {
      const batch = capped.slice(i, i + INDEX_BATCH_SIZE);
      await Promise.all(
        batch.map(async (uri) => {
          if (this.openDocuments.has(uri)) {
            indexed++;
            return;
          }
          if (await this.readAndIndex(uri, resolveDialect)) indexed++;
          else skipped++;
        }),
      );
      // Give pending LSP requests a chance to run between batches instead of starving them for
      // however long the full scan takes on a very large workspace.
      await new Promise((resolve) => setImmediate(resolve));
    }

    return { indexed, skipped };
  }

  /** Re-indexes a single file from disk — used to react to workspace/didChangeWatchedFiles. */
  async reindexFile(uri: string, resolveDialect: DialectResolver): Promise<void> {
    if (this.openDocuments.has(uri)) return;
    if (!(await this.readAndIndex(uri, resolveDialect))) {
      this.indexedDocuments.delete(uri);
      this.syncGlobalIndex(uri);
    }
  }

  removeIndexedFile(uri: string): void {
    this.indexedDocuments.delete(uri);
    this.syncGlobalIndex(uri);
  }

  private async readAndIndex(uri: string, resolveDialect: DialectResolver): Promise<boolean> {
    try {
      const fsPath = URI.parse(uri).fsPath;
      const stat = await fs.stat(fsPath);
      if (!stat.isFile() || stat.size > MAX_INDEXED_FILE_BYTES) return false;
      const text = await fs.readFile(fsPath, 'utf8');
      this.indexedDocuments.set(uri, parseDocument(uri, -1, text, resolveDialect(uri, text)));
      this.syncGlobalIndex(uri);
      return true;
    } catch {
      return false;
    }
  }

  /** Resolves an `include '...'` path relative to the including file's directory. */
  private resolveIncludePath(fromUri: string, includePath: string): string | undefined {
    try {
      const fromFsPath = URI.parse(fromUri).fsPath;
      const candidate = path.resolve(path.dirname(fromFsPath), includePath);
      return fsSync.existsSync(candidate) ? candidate : undefined;
    } catch {
      return undefined;
    }
  }

  /** Resolves an `include '...'` path to the URI of the target file, for go-to-definition. */
  resolveIncludeUri(fromUri: string, includePath: string): string | undefined {
    const fsPath = this.resolveIncludePath(fromUri, includePath);
    return fsPath ? URI.file(fsPath).toString() : undefined;
  }

  /** Every document this Workspace currently has parsed state for, from any of its three layers. */
  private allKnownDocuments(): ParsedDocument[] {
    const docs: ParsedDocument[] = [...this.openDocuments.values()];
    for (const [uri, doc] of this.indexedDocuments) if (!this.openDocuments.has(uri)) docs.push(doc);
    for (const [uri, doc] of this.externalDiskCache) {
      if (doc && !this.openDocuments.has(uri) && !this.indexedDocuments.has(uri)) docs.push(doc);
    }
    return docs;
  }

  /** Every known document whose `include` resolves to `targetUri` — the reverse of `includes`. */
  private findIncluders(targetUri: string): string[] {
    const includers: string[] = [];
    for (const doc of this.allKnownDocuments()) {
      for (const inc of doc.includes) {
        if (this.resolveIncludeUri(doc.uri, inc.path) === targetUri) {
          includers.push(doc.uri);
          break;
        }
      }
    }
    return includers;
  }

  /**
   * Finds the file that would actually be handed to the compiler for `uri`: `uri` itself if it
   * already has a top-level `format` directive, otherwise the nearest document reachable by
   * walking `include` edges *backwards* (who includes this file, and who includes that...) that
   * does. This is what makes diagnostics work for a fragment file (a `.inc`/`.asm` with no
   * `format` of its own, meant only to be `include`d into a real entry point) — compiling the
   * fragment in isolation is meaningless, so its errors need to be found by compiling the actual
   * program and filtering the result back down to this file.
   * Returns undefined if no reachable ancestor with a `format` directive is known (e.g. an
   * orphaned fragment, or the including file hasn't been indexed/opened yet).
   */
  findEntryFile(uri: string): string | undefined {
    const visited = new Set<string>();
    const queue: Array<{ uri: string; depth: number }> = [{ uri, depth: 0 }];

    while (queue.length > 0) {
      const { uri: currentUri, depth } = queue.shift()!;
      if (visited.has(currentUri) || depth > MAX_INCLUDE_DEPTH) continue;
      visited.add(currentUri);

      const doc = this.openDocuments.get(currentUri) ?? this.indexedDocuments.get(currentUri) ?? this.externalDiskCache.get(currentUri) ?? undefined;
      if (doc?.formatDirective !== undefined) return currentUri;

      for (const includer of this.findIncluders(currentUri)) {
        queue.push({ uri: includer, depth: depth + 1 });
      }
    }
    return undefined;
  }

  private loadForInclude(fsPath: string, dialect: Dialect): ParsedDocument | undefined {
    const uri = URI.file(fsPath).toString();
    const known = this.openDocuments.get(uri) ?? this.indexedDocuments.get(uri);
    if (known) return known;
    if (this.externalDiskCache.has(uri)) return this.externalDiskCache.get(uri) ?? undefined;

    try {
      const stat = fsSync.statSync(fsPath);
      if (stat.size > MAX_INDEXED_FILE_BYTES) {
        this.externalDiskCache.set(uri, null);
        return undefined;
      }
      const text = fsSync.readFileSync(fsPath, 'utf8');
      const parsed = parseDocument(uri, -1, text, dialect);
      this.externalDiskCache.set(uri, parsed);
      this.syncGlobalIndex(uri);
      return parsed;
    } catch {
      this.externalDiskCache.set(uri, null);
      return undefined;
    }
  }

  /**
   * Walks the include graph reachable from `uri`'s real entry point, yielding each parsed
   * document once. `uri` itself may be a fragment with no `format` of its own (e.g. an .inc/.asm
   * meant only to be `include`d) — walking from it directly would miss sibling fragments pulled in
   * by the same entry point but not by `uri` itself (e.g. two files both included by cc.asm, where
   * neither includes the other). findEntryFile walks backward via `include`rs to find that real
   * starting point; falls back to `uri` itself when none is known (an orphaned fragment, or `uri`
   * already being the entry).
   */
  *walkIncludeGraph(uri: string, dialect: Dialect): Generator<ParsedDocument> {
    const startUri = this.findEntryFile(uri) ?? uri;
    const visited = new Set<string>();
    const queue: Array<{ uri: string; depth: number }> = [{ uri: startUri, depth: 0 }];

    while (queue.length > 0) {
      const { uri: currentUri, depth } = queue.shift()!;
      if (visited.has(currentUri) || depth > MAX_INCLUDE_DEPTH) continue;
      visited.add(currentUri);

      const parsed = this.openDocuments.get(currentUri) ?? this.indexedDocuments.get(currentUri) ?? this.externalDiskCache.get(currentUri) ?? undefined;
      if (!parsed) continue;

      yield parsed;

      for (const inc of parsed.includes) {
        const fsPath = this.resolveIncludePath(currentUri, inc.path);
        if (!fsPath) continue;
        const includedDoc = this.loadForInclude(fsPath, dialect);
        if (includedDoc) queue.push({ uri: includedDoc.uri, depth: depth + 1 });
      }
    }
  }

  /** Finds all symbol definitions with the given name reachable from `fromUri` via includes. */
  findDefinitions(fromUri: string, name: string, dialect: Dialect): SymbolDefinition[] {
    const results: SymbolDefinition[] = [];
    const startDoc = this.getDocument(fromUri);
    if (!startDoc) return results;

    for (const doc of this.walkIncludeGraph(fromUri, dialect)) {
      for (const sym of doc.symbols) {
        if (sym.name === name) results.push(sym);
      }
    }
    return results;
  }

  // --- global name index -----------------------------------------------------------------

  /** Recomputes uri's contribution to the global index from whatever is currently authoritative
   * for it (open buffer > indexed-from-disk > external-disk-cache), retracting the previous
   * contribution first. O(that document's own symbol/reference count), never the whole workspace. */
  private syncGlobalIndex(uri: string): void {
    this.retractFromGlobalIndex(uri);
    const doc = this.openDocuments.get(uri) ?? this.indexedDocuments.get(uri) ?? this.externalDiskCache.get(uri) ?? undefined;
    if (doc) this.addToGlobalIndex(doc);
  }

  private addToGlobalIndex(doc: ParsedDocument): void {
    const symbolNames = new Set<string>();
    const refNames = new Set<string>();

    for (const sym of doc.symbols) {
      let bucket = this.symbolsByName.get(sym.name);
      if (!bucket) {
        bucket = [];
        this.symbolsByName.set(sym.name, bucket);
      }
      bucket.push(sym);
      symbolNames.add(sym.name);
    }

    for (const ref of doc.references) {
      let bucket = this.referencesByName.get(ref.name);
      if (!bucket) {
        bucket = [];
        this.referencesByName.set(ref.name, bucket);
      }
      bucket.push(ref);
      refNames.add(ref.name);
    }

    this.contributions.set(doc.uri, { symbolNames, refNames });
  }

  private retractFromGlobalIndex(uri: string): void {
    const contribution = this.contributions.get(uri);
    if (!contribution) return;

    for (const name of contribution.symbolNames) {
      const bucket = this.symbolsByName.get(name);
      if (!bucket) continue;
      const filtered = bucket.filter((s) => s.uri !== uri);
      if (filtered.length > 0) this.symbolsByName.set(name, filtered);
      else this.symbolsByName.delete(name);
    }

    for (const name of contribution.refNames) {
      const bucket = this.referencesByName.get(name);
      if (!bucket) continue;
      const filtered = bucket.filter((r) => r.uri !== uri);
      if (filtered.length > 0) this.referencesByName.set(name, filtered);
      else this.referencesByName.delete(name);
    }

    this.contributions.delete(uri);
  }

  /**
   * Exact-name lookup across the whole known workspace, regardless of `include` reachability.
   * Hover/go-to-definition/signature-help search the include graph first (that's what the
   * assembler would actually resolve) and fall back to this only when that comes up empty — e.g.
   * a macro defined in a sibling file the current one hasn't `include`d (yet). It's a discovery
   * aid, not a claim that the symbol will compile from here; callers that surface it should make
   * that distinction obvious (see hover's "not included in this file" note).
   */
  findSymbolAnywhere(name: string): SymbolDefinition[] {
    return this.symbolsByName.get(name)?.slice() ?? [];
  }

  findReferences(name: string, includeDeclaration: boolean): Array<SymbolReference | SymbolDefinition> {
    const results: Array<SymbolReference | SymbolDefinition> = includeDeclaration ? (this.symbolsByName.get(name)?.slice() ?? []) : [];
    const refs = this.referencesByName.get(name);
    if (refs) results.push(...refs);
    return results;
  }

  /** Substring match over symbol names — inherently O(total distinct names) since every name has
   * to be tested, but it's one flat pass over the index rather than re-deriving "every document,
   * every symbol, deduped" on each call. */
  findWorkspaceSymbols(query: string): SymbolDefinition[] {
    const needle = query.toLowerCase();
    if (!needle) return [...this.symbolsByName.values()].flat();

    const results: SymbolDefinition[] = [];
    for (const [name, symbols] of this.symbolsByName) {
      if (name.toLowerCase().includes(needle)) results.push(...symbols);
    }
    return results;
  }
}
