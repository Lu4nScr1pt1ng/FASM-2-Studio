// Shows, inline at the end of each instruction, where it lands in memory and how many bytes it
// assembled to.
//
// This is the one thing the editor can say about a FASM source that no general-purpose language
// tooling can: assembly's whole subject is the layout of the bytes, and until now the only way to
// see any of it was to build, open the .lst, and read it against the source by eye. The data comes
// from the very compile that live error checking already runs (diagnostics.ts), so a file that is
// being checked for errors is already producing everything needed here — the extra cost is one
// `-i` flag on a compile that was happening anyway, plus reading the listing it writes.
//
// Deliberately opt-in (`fasm2Studio.inlayHints`, default "off"). An annotation on every
// code-producing line is a real change to how a file reads, and the listing generation is not free
// on a large project; both are choices worth leaving to the person whose screen it is.

import * as fs from 'fs';
import * as path from 'path';
import { InlayHint, InlayHintKind, Range } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { URI } from 'vscode-uri';
import { AddressLineMap } from '../listing/listingMap';

/**
 * The bundled listing macro, or undefined if it cannot be found — in which case hints are simply
 * not produced, rather than a compile being run with an `-i` flag pointing at nothing.
 *
 * Two locations, because this module runs from two very different places. In an installed
 * extension the server is the bundle at `dist/server.js` and the macro sits beside it, copied
 * there by the extension's own esbuild step. Running from source (tests, `npm run watch`) there is
 * no `dist/` at all and the macro is still in the debug package where it is maintained.
 */
export function bundledListingIncPath(): string | undefined {
  const candidates = [
    path.join(__dirname, 'debug-support', 'listing.inc'),
    path.join(__dirname, '..', '..', '..', 'debug', 'debug-support', 'listing.inc'),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate));
}

/** What `fasm2Studio.inlayHints` can be set to. */
export type InlayHintMode = 'off' | 'address' | 'size' | 'addressAndSize' | 'bytes' | 'addressAndBytes';

/**
 * How many bytes of an encoding are shown inline before it is elided.
 *
 * An x86 instruction is at most 15 bytes, so this shows every real instruction in full; what it
 * cuts short is the other kind of line the listing carries bytes for — a `format` directive
 * emitting a 120-byte ELF header, a `db` of a whole string — where the point of the hint is that
 * there are bytes and roughly how many, not all of them. The full dump is always on the hint's
 * tooltip regardless.
 */
const MAX_INLINE_BYTES = 16;

/**
 * How wide an address is rendered, in hex digits.
 *
 * Padded to a fixed width so the hints form a readable column down the file rather than a ragged
 * edge that shifts every time an address crosses a power of sixteen. Eight digits covers the whole
 * 32-bit range and the low 4 GiB that ordinary ELF programs are linked into; anything above that
 * simply renders wider rather than being truncated, which would be a lie about the address.
 */
const ADDRESS_HEX_DIGITS = 8;

function formatAddress(address: bigint): string {
  return `0x${address.toString(16).toUpperCase().padStart(ADDRESS_HEX_DIGITS, '0')}`;
}

/** "1 byte"/"N bytes", spelled out rather than abbreviated — the hint is read as prose next to
 * code, and "1 B" next to an instruction reads like part of the operand. */
function formatSize(bytes: number): string {
  return bytes === 1 ? '1 byte' : `${bytes} bytes`;
}

/**
 * The hint text for one line, or undefined when there is nothing worth saying.
 *
 * Kept pure and exported so every combination of mode and available data can be asserted directly,
 * without a listing, a compiler or a document.
 */
/**
 * The encoding as one uppercase, space-separated run ("66 B8 01 00 00 00"), elided past
 * MAX_INLINE_BYTES.
 *
 * Uppercase because that is how fasm's own listing writes it, and how a reader who is about to
 * compare this against a hex dump or an opcode table expects to see it.
 */
function formatBytes(bytes: string[]): string {
  const shown = bytes.slice(0, MAX_INLINE_BYTES).map((b) => b.toUpperCase()).join(' ');
  return bytes.length > MAX_INLINE_BYTES ? `${shown} … (${bytes.length} bytes)` : shown;
}

/** The whole encoding, never elided — what the hint's tooltip carries. Exported for the tests that
 * assert an elided inline label still has its full form available. */
export function fullBytes(bytes: string[]): string {
  return `${bytes.map((b) => b.toUpperCase()).join(' ')} (${formatSize(bytes.length)})`;
}

export function hintLabel(
  mode: InlayHintMode,
  address: bigint | undefined,
  size: number | undefined,
  bytes?: string[],
): string | undefined {
  if (mode === 'off' || address === undefined) return undefined;
  switch (mode) {
    case 'address':
      return formatAddress(address);
    case 'size':
      // A line with an address but no byte count produced no machine code of its own (a label
      // sharing a line, an `org`). In size mode there is genuinely nothing to report about it.
      return size === undefined ? undefined : formatSize(size);
    case 'addressAndSize':
      return size === undefined ? formatAddress(address) : `${formatAddress(address)} · ${formatSize(size)}`;
    // Same rule as size mode: no bytes means this line produced no code, and an encoding is the
    // one thing there is nothing to say about.
    case 'bytes':
      return bytes === undefined ? undefined : formatBytes(bytes);
    case 'addressAndBytes':
      return bytes === undefined ? formatAddress(address) : `${formatAddress(address)} · ${formatBytes(bytes)}`;
  }
}

/**
 * Hints for the lines of `doc` that fall inside `range`.
 *
 * Only the requested range is walked: VS Code asks per visible viewport and re-asks on scroll, so
 * building the whole file's worth on every request would scale with file size instead of screen
 * size.
 *
 * Each hint is anchored at the end of its line's text rather than at a fixed column, so it never
 * lands in the middle of a trailing comment.
 */
export function getInlayHints(doc: TextDocument, range: Range, map: AddressLineMap | undefined, mode: InlayHintMode): InlayHint[] {
  if (mode === 'off' || !map) return [];

  const fsPath = uriToFsPath(doc.uri);
  if (!fsPath) return [];

  const hints: InlayHint[] = [];
  const lastLine = Math.min(range.end.line, doc.lineCount - 1);

  for (let line = range.start.line; line <= lastLine; line++) {
    // The map is keyed 1-based (DAP's convention, which the listing was built for); LSP positions
    // are 0-based.
    const key = `${fsPath}:${line + 1}`;
    const address = map.locationToAddress.get(key);
    if (address === undefined) continue;

    const bytes = map.bytesByLocation.get(key);
    const label = hintLabel(mode, address, map.sizeByLocation.get(key), bytes);
    if (label === undefined) continue;

    const text = doc.getText({ start: { line, character: 0 }, end: { line, character: Number.MAX_SAFE_INTEGER } });
    hints.push({
      position: { line, character: text.replace(/\s+$/, '').length },
      label,
      kind: InlayHintKind.Parameter,
      paddingLeft: true,
      // The full encoding, whatever the mode showed inline — so a hint elided at MAX_INLINE_BYTES
      // (or one showing only an address) still has the whole answer a hover away.
      tooltip: bytes ? fullBytes(bytes) : undefined,
    });
  }

  return hints;
}

/** file:// URI -> filesystem path, matching the fsPath every map key in this module is built from
 * (server.ts derives sourceFsPath the same way, via `URI.parse(uri).fsPath`). The server only ever
 * holds file:// and untitled: documents, and an untitled one has no path for a listing to have been
 * keyed by in the first place — checked explicitly, since URI.parse().fsPath does not return
 * undefined for a non-file scheme, just a meaningless value derived from its opaque part.
 *
 * This used to be a hand-rolled `decodeURIComponent` + leading-slash strip, which left the path
 * exactly as the URI encoded it: always "/"-separated, whatever the platform. On Windows every path
 * built through this module's Map keys elsewhere (mappedLinesByFile, locationToAddress, ...) uses
 * "\" instead, from sourceFsPath's own `.fsPath`. Two spellings of the same file never compared
 * equal, so a lookup here always missed and inlay hints silently produced nothing — invisible on
 * Linux/macOS, where "/" already is the native separator, which is exactly why this went unnoticed
 * until a real Windows compile ever reached this code path. */
export function uriToFsPath(uri: string): string | undefined {
  if (!uri.startsWith('file://')) return undefined;
  return URI.parse(uri).fsPath;
}

/**
 * The correlated listing map per *entry point*, which is the unit a listing actually describes: a
 * fragment has no listing of its own, and its lines appear in the listing of whichever program
 * includes it. Keyed by the entry point's real path, so an included file's hints are served from
 * the same map its program produced.
 */
export class ListingMapStore {
  private readonly byEntry = new Map<string, AddressLineMap>();
  /** Which entry point's map last carried each file's lines, so a lookup by document can find the
   * right map without searching every entry. */
  private readonly entryForFile = new Map<string, string>();

  set(entryFsPath: string, map: AddressLineMap): void {
    this.byEntry.set(entryFsPath, map);
    for (const fsPath of map.mappedLinesByFile.keys()) this.entryForFile.set(fsPath, entryFsPath);
  }

  /** The map covering `fsPath`, whether it is an entry point itself or a fragment included by one. */
  get(fsPath: string): AddressLineMap | undefined {
    const direct = this.byEntry.get(fsPath);
    if (direct) return direct;
    const entry = this.entryForFile.get(fsPath);
    return entry ? this.byEntry.get(entry) : undefined;
  }

  /** Drops everything. Used when the setting turns hints off, so a stale map cannot outlive the
   * feature that produced it and reappear if it is turned back on. */
  clear(): void {
    this.byEntry.clear();
    this.entryForFile.clear();
  }
}
