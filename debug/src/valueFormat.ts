// Pure formatting helpers for the values symbols.ts resolves addresses for — decoding raw memory
// bytes (already read via gdb's own "-data-read-memory-bytes" MI command; see session.ts for the
// actual round-trip) into arrays and text previews. Kept separate from session.ts the same way
// registers.ts keeps pure register-metadata logic apart from the DAP request handling that uses
// it — testable without a live gdb connection.

/** How many bytes/elements to actually fetch and show for a string/array preview — a safety cap,
 * not a normal-case limit (mirrors listingMap.ts's own MAX_LOOKAHEAD reasoning: bound the cost of
 * a pathological case, like a multi-megabyte buffer, without complicating the common case). */
export const MAX_STRING_PREVIEW_BYTES = 128;
export const MAX_ARRAY_PREVIEW_ELEMENTS = 32;

export const SIZE_NAMES: Record<number, string> = {
  1: 'byte', 2: 'word', 4: 'dword', 6: 'pword', 8: 'qword', 10: 'tbyte',
  16: 'dqword', 32: 'qqword', 64: 'dqqword',
};

/** The conventional fasmg name for a declared element width, falling back to a plain "N-byte"
 * label for a size this lightweight scan can still measure but doesn't have a name for. */
export function sizeName(bytes: number): string {
  return SIZE_NAMES[bytes] ?? `${bytes}-byte`;
}

/** Parses gdb's own "-data-read-memory-bytes" result "contents" field — a plain hex string with
 * no spaces or prefix, e.g. "01000000" (confirmed against real gdb 16.3 output) — into a byte
 * array, in the order the bytes actually sit in memory. */
export function parseHexBytes(hex: string): number[] {
  const bytes: number[] = [];
  for (let i = 0; i + 1 < hex.length; i += 2) bytes.push(parseInt(hex.slice(i, i + 2), 16));
  return bytes;
}

/** Interprets `count` little-endian unsigned integers of `elementSizeBytes` width out of a flat
 * byte array — x86 is always little-endian, and every element width this is used for (1/2/4/8,
 * see session.ts's READABLE_VALUE_BITS) is one formatRegisterValue already knows how to render. */
export function decodeLittleEndianElements(bytes: readonly number[], elementSizeBytes: number, count: number): bigint[] {
  const values: bigint[] = [];
  for (let i = 0; i < count; i++) {
    let value = 0n;
    for (let b = elementSizeBytes - 1; b >= 0; b--) {
      value = (value << 8n) | BigInt(bytes[i * elementSizeBytes + b] ?? 0);
    }
    values.push(value);
  }
  return values;
}

export interface StringPreview {
  /** Escaped, display-ready text — printable ASCII as-is, \0 \t \n \r \" \\ as short escapes,
   * anything else as \xNN. Never contains a literal newline/control character itself, so it's
   * always safe to show on one line (a hover hint, a Watch row, an inline decoration, ...). */
  text: string;
  /** True when the raw bytes end with a 0 byte (the classic C-string convention) — that
   * terminator byte is excluded from `text` when true. */
  nullTerminated: boolean;
}

const SHORT_ESCAPES: Record<number, string> = { 0: '\\0', 9: '\\t', 10: '\\n', 13: '\\r', 34: '\\"', 92: '\\\\' };

export function formatStringPreview(bytes: readonly number[]): StringPreview {
  const nullTerminated = bytes.length > 0 && bytes[bytes.length - 1] === 0;
  const content = nullTerminated ? bytes.slice(0, -1) : bytes;
  let text = '';
  for (const b of content) {
    const short = SHORT_ESCAPES[b];
    if (short) text += short;
    else if (b >= 0x20 && b < 0x7f) text += String.fromCharCode(b);
    else text += `\\x${b.toString(16).padStart(2, '0')}`;
  }
  return { text, nullTerminated };
}
