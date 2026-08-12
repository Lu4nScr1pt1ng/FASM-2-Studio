// Parsing of fasm's own console output. Deliberately free of any `vscode` import so it can be
// unit-tested against real compiler output without an extension host (same arrangement as
// shellQuote.ts / taskValidation.ts / dialect.ts).

/**
 * A fasm location header: a file path, a space, then a bracketed 1-based line number, optionally
 * followed by ':'.
 *
 * Anchored to the *whole line* on purpose. fasm prints the macro call stack between a header and
 * its message ("mov? [3] x86.store_instruction@src [77] x86.require.bits64? [6]"), and those
 * lines also end in "[number]" — a pattern that could match mid-line would turn every frame of
 * that trace into a link to a file named "mov?". Excluding brackets from the path part is what
 * rejects them: a trace always carries an earlier bracketed group, so it cannot fill a whole line
 * that permits only one.
 */
const LOCATION_RE = /^([^[\]]+) \[(\d+)\]:?$/;

export interface FasmLocation {
  rawPath: string;
  line: number;
}

/** Parses one line of compiler output as a location header, or undefined if it isn't one. */
export function parseLocationHeader(line: string): FasmLocation | undefined {
  const match = LOCATION_RE.exec(line.trimEnd());
  if (!match) return undefined;
  const lineNumber = Number.parseInt(match[2], 10);
  if (!Number.isFinite(lineNumber) || lineNumber < 1) return undefined;
  const rawPath = match[1].trim();
  if (!rawPath) return undefined;
  return { rawPath, line: lineNumber };
}
