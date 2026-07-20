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
 * This is what makes findReferences/findWorkspaceSymbols/rename workspace-wide without paying a
 * disk read per keystroke: indexing happens once, off the interactive request path, and every
 * lookup after that is an in-memory Map hit.
 */
export class Workspace {
  private readonly openDocuments = new Map<string, ParsedDocument>();
  private readonly indexedDocuments = new Map<string, ParsedDocument>();
  private readonly externalDiskCache = new Map<string, ParsedDocument | null>();

  updateDocument(uri: string, version: number, text: string, dialect: Dialect): ParsedDocument {
    const parsed = parseDocument(uri, version, text, dialect);
    this.openDocuments.set(uri, parsed);
    this.externalDiskCache.delete(uri);
    return parsed;
  }

  removeDocument(uri: string): void {
    this.openDocuments.delete(uri);
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
    if (!(await this.readAndIndex(uri, resolveDialect))) this.indexedDocuments.delete(uri);
  }

  removeIndexedFile(uri: string): void {
    this.indexedDocuments.delete(uri);
  }

  private async readAndIndex(uri: string, resolveDialect: DialectResolver): Promise<boolean> {
    try {
      const fsPath = URI.parse(uri).fsPath;
      const stat = await fs.stat(fsPath);
      if (!stat.isFile() || stat.size > MAX_INDEXED_FILE_BYTES) return false;
      const text = await fs.readFile(fsPath, 'utf8');
      this.indexedDocuments.set(uri, parseDocument(uri, -1, text, resolveDialect(uri, text)));
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
      return parsed;
    } catch {
      this.externalDiskCache.set(uri, null);
      return undefined;
    }
  }

  /** Walks the include graph starting at `uri`, yielding each reachable parsed document once. */
  *walkIncludeGraph(uri: string, dialect: Dialect): Generator<ParsedDocument> {
    const visited = new Set<string>();
    const queue: Array<{ uri: string; depth: number }> = [{ uri, depth: 0 }];

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

  /**
   * Exact-name lookup across the whole known workspace, regardless of `include` reachability.
   * Hover/go-to-definition/signature-help search the include graph first (that's what the
   * assembler would actually resolve) and fall back to this only when that comes up empty — e.g.
   * a macro defined in a sibling file the current one hasn't `include`d (yet). It's a discovery
   * aid, not a claim that the symbol will compile from here; callers that surface it should make
   * that distinction obvious (see hover's "not included in this file" note).
   */
  findSymbolAnywhere(name: string): SymbolDefinition[] {
    const results: SymbolDefinition[] = [];
    for (const doc of this.allKnownDocuments()) {
      for (const sym of doc.symbols) {
        if (sym.name === name) results.push(sym);
      }
    }
    return results;
  }

  /** Every document this workspace instance currently knows about: open editors (authoritative
   * for their own uri) plus the full workspace index plus anything reached on-demand outside it. */
  private *allKnownDocuments(): Generator<ParsedDocument> {
    const seen = new Set<string>();
    for (const doc of this.openDocuments.values()) {
      seen.add(doc.uri);
      yield doc;
    }
    for (const doc of this.indexedDocuments.values()) {
      if (seen.has(doc.uri)) continue;
      seen.add(doc.uri);
      yield doc;
    }
    for (const doc of this.externalDiskCache.values()) {
      if (!doc || seen.has(doc.uri)) continue;
      seen.add(doc.uri);
      yield doc;
    }
  }

  findReferences(name: string, includeDeclaration: boolean): Array<SymbolReference | SymbolDefinition> {
    const results: Array<SymbolReference | SymbolDefinition> = [];
    const seen = new Set<string>();

    for (const doc of this.allKnownDocuments()) {
      if (includeDeclaration) {
        for (const sym of doc.symbols) {
          if (sym.name !== name) continue;
          const key = `${sym.uri}:${sym.nameRange.startLine}:${sym.nameRange.startChar}`;
          if (seen.has(key)) continue;
          seen.add(key);
          results.push(sym);
        }
      }
      for (const ref of doc.references) {
        if (ref.name !== name) continue;
        const key = `${ref.uri}:${ref.range.startLine}:${ref.range.startChar}`;
        if (seen.has(key)) continue;
        seen.add(key);
        results.push(ref);
      }
    }
    return results;
  }

  findWorkspaceSymbols(query: string): SymbolDefinition[] {
    const needle = query.toLowerCase();
    const results: SymbolDefinition[] = [];
    const seen = new Set<string>();

    for (const doc of this.allKnownDocuments()) {
      for (const sym of doc.symbols) {
        if (needle && !sym.name.toLowerCase().includes(needle)) continue;
        const key = `${sym.uri}:${sym.nameRange.startLine}:${sym.nameRange.startChar}`;
        if (seen.has(key)) continue;
        seen.add(key);
        results.push(sym);
      }
    }
    return results;
  }
}
