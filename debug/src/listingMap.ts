// Correlates machine addresses back to source (file, line) using a fasmg listing (.lst) file —
// the only address<->source mechanism fasm2 has, since it emits no DWARF/CodeView by default.
// The listing has no "one entry per source line" guarantee: blank lines, comments, `include`
// directives, and macro/struct definition bodies produce no entry at all, while a macro
// *invocation* collapses its entire expansion into a single entry at the call site. So this is
// not a 1:1 zip — it's a forward-only text match between the listing's reconstructed statement
// text and our own re-derivation of that same text from the real source files, walked in the
// same `include` order fasmg itself would process them in. Any statement the matcher can't find
// (an unanticipated meta-line, a macro body, etc.) is simply skipped rather than desyncing
// everything after it — one page of a book gone missing doesn't stop you from finding the rest.
import * as fs from 'fs';
import * as path from 'path';
import { TokenType, Token, tokenizeDocument, unquoteString } from '@fasm2-studio/server/src/parser/tokenizer';

// Bounds the forward search in correlateListing: without it, an entry with no real match would
// scan all the way to the end of the candidate list, and every subsequent miss would redo that
// same scan from the same (unadvanced) cursor — O(entries × candidates) in a pathological case
// (many consecutive unmapped statements). Capping the lookahead makes each entry's search
// O(window) instead, so the whole pass stays linear in the number of listing entries. Far larger
// than any realistic single macro-library body, so this only trades away correlation for
// statements separated by an implausibly large unmatched gap — a debug-quality-of-life edge case,
// not a correctness one anything in this codebase's own test fixtures ever hits.
export const MAX_LOOKAHEAD = 5000;

export interface ListingEntry {
  address: bigint;
  text: string;
}

export interface SourceLocation {
  fsPath: string;
  /** 1-based, matching DAP's default line convention. */
  line: number;
}

export interface AddressLineMap {
  addressToLocation: Map<bigint, SourceLocation>;
  /** Keyed by `${fsPath}:${line}` for O(1) breakpoint resolution. */
  locationToAddress: Map<string, bigint>;
  /** Per source file, the ascending list of lines that actually produced machine code. The
   * complement of this — blank lines, comments, `include`s, bare labels, macro definition bodies,
   * everything in a data section — is most of a typical asm file, and is exactly where a user
   * clicks to set a breakpoint. Kept sorted so nextMappedLineAtOrAfter can binary-search it. */
  mappedLinesByFile: Map<string, number[]>;
}

/**
 * The first line at or after `line` in `fsPath` that has machine code behind it, or undefined if
 * there is none left in that file.
 *
 * This is what lets a breakpoint set on a comment, a blank line or a label land on the instruction
 * the user plainly meant, the same way gdb and every DAP adapter over it behave. DAP allows the
 * `setBreakpoints` response to name a different line than was requested precisely so the client
 * can move its own marker to match, so the adjustment is visible rather than silent.
 */
export function nextMappedLineAtOrAfter(map: AddressLineMap, fsPath: string, line: number): number | undefined {
  const lines = map.mappedLinesByFile.get(fsPath);
  if (!lines || lines.length === 0) return undefined;

  let lo = 0;
  let hi = lines.length; // first index whose line is >= `line`
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid] < line) lo = mid + 1;
    else hi = mid;
  }
  return lo < lines.length ? lines[lo] : undefined;
}

const HEADER_RE = /^\[([0-9A-Fa-f]+)\]\s?(.*)$/;
// An offset+byte-dump prefix, if present, is a run of "<offset>: XX XX XX ..." followed by a
// *multi*-space gap before the source text column — single spaces only ever separate byte pairs
// from each other, so requiring \s\s+ as the boundary is what keeps this from misfiring on text
// that happens to start with hex-digit-like letters (e.g. "add..." — 'a' and 'd' are valid hex).
const OFFSET_AND_BYTES_RE = /^([0-9A-Fa-f]+):((?:\s[0-9A-Fa-f]{2})+)\s\s+(.*)$/;

export function parseListingFile(content: string): ListingEntry[] {
  const entries: ListingEntry[] = [];

  for (const rawLine of content.split(/\r\n|\r|\n/)) {
    const header = HEADER_RE.exec(rawLine);
    if (!header) continue; // byte-dump continuation line, or trailing blank — not a new entry

    const address = BigInt(`0x${header[1]}`);
    const rest = header[2];
    const withBytes = OFFSET_AND_BYTES_RE.exec(rest.trimStart());
    const text = (withBytes ? withBytes[3] : rest).trim();
    if (text.length === 0) continue;

    entries.push({ address, text });
  }

  return entries;
}

interface Candidate extends SourceLocation {
  text: string;
}

/** Reproduces fasmg's own listing text reconstruction: tokens joined with a single space
 * wherever the source had *any* whitespace between them, and no space where it had none
 * (e.g. "eax,    1" -> "eax, 1" but "ebx,2" stays "ebx,2"). */
function reconstructLine(tokens: Token[]): string {
  let out = '';
  for (let i = 0; i < tokens.length; i++) {
    if (i > 0 && tokens[i].startChar > tokens[i - 1].endChar) out += ' ';
    out += tokens[i].text;
  }
  return out;
}

/**
 * Walks the source starting at `entryFsPath`, following `include` directives in the same
 * left-to-right, depth-first order fasmg itself assembles in, and returns the ordered sequence
 * of non-blank, non-`include` statement lines this should produce in the listing (in a debug
 * package deliberately kept separate from the language server's own richer parser, since all
 * this needs is "what would this line's listing text look like", not a full symbol index).
 */
export function buildCandidateSequence(entryFsPath: string, maxFiles = 500): Candidate[] {
  const result: Candidate[] = [];
  const visited = new Set<string>();
  const stack: string[] = [entryFsPath];

  function visit(fsPath: string): void {
    const resolved = path.resolve(fsPath);
    if (visited.has(resolved) || visited.size >= maxFiles) return;
    visited.add(resolved);

    let text: string;
    try {
      text = fs.readFileSync(resolved, 'utf8');
    } catch {
      return; // unreadable include target (e.g. outside the workspace and not on disk) — skip it
    }

    const lines = tokenizeDocument(text);
    for (let i = 0; i < lines.length; i++) {
      const tokens = lines[i].filter((t) => t.type !== TokenType.Comment);
      if (tokens.length === 0) continue;

      const kw0 = tokens[0].type === TokenType.Ident ? tokens[0].text.toLowerCase() : '';
      if (kw0 === 'include' && tokens[1] && tokens[1].type === TokenType.String) {
        visit(path.resolve(path.dirname(resolved), unquoteString(tokens[1].text)));
        continue;
      }

      result.push({ fsPath: resolved, line: i + 1, text: reconstructLine(tokens) });
    }
  }

  visit(stack[0]);
  return result;
}

/** Forward-only match between listing entries and re-derived source candidates. See the module
 * doc comment for why this isn't a strict zip. */
export function correlateListing(entries: ListingEntry[], candidates: Candidate[]): AddressLineMap {
  const addressToLocation = new Map<bigint, SourceLocation>();
  const locationToAddress = new Map<string, bigint>();
  const mappedLinesByFile = new Map<string, number[]>();

  let cursor = 0;
  for (const entry of entries) {
    let found = -1;
    const limit = Math.min(candidates.length, cursor + MAX_LOOKAHEAD);
    for (let i = cursor; i < limit; i++) {
      if (candidates[i].text === entry.text) {
        found = i;
        break;
      }
    }
    if (found === -1) continue; // no matching candidate found within the window; leave this entry unmapped

    const loc: SourceLocation = { fsPath: candidates[found].fsPath, line: candidates[found].line };
    addressToLocation.set(entry.address, loc);
    const key = `${loc.fsPath}:${loc.line}`;
    if (!locationToAddress.has(key)) {
      locationToAddress.set(key, entry.address);
      const lines = mappedLinesByFile.get(loc.fsPath);
      if (lines) lines.push(loc.line);
      else mappedLinesByFile.set(loc.fsPath, [loc.line]);
    }
    cursor = found + 1;
  }

  // Ascending order is nextMappedLineAtOrAfter's precondition. Candidates within a single file are
  // already walked in line order, but an `include` in the middle of one file interleaves another
  // file's entries into the same pass, so the per-file runs are appended in fragments rather than
  // one sorted sweep.
  for (const lines of mappedLinesByFile.values()) lines.sort((a, b) => a - b);

  return { addressToLocation, locationToAddress, mappedLinesByFile };
}

export interface BuiltAddressLineMap extends AddressLineMap {
  /** The listing's own raw entries, alongside the correlated map built from them — callers that
   * also need to derive a symbol/constant map from the same listing (see session.ts) would
   * otherwise have no way to get both without re-running parseListingFile a second time. */
  entries: ListingEntry[];
}

export function buildAddressLineMap(listingFsPath: string, entrySourceFsPath: string): BuiltAddressLineMap {
  const content = fs.readFileSync(listingFsPath, 'utf8');
  const entries = parseListingFile(content);
  const candidates = buildCandidateSequence(entrySourceFsPath);
  return { ...correlateListing(entries, candidates), entries };
}
