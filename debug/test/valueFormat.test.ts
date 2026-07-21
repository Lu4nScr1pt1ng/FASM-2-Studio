import * as assert from 'assert';
import { decodeLittleEndianElements, formatStringPreview, parseHexBytes, sizeName } from '../src/valueFormat';

describe('parseHexBytes', () => {
  it('parses gdb\'s real "-data-read-memory-bytes" contents field (confirmed against real gdb 16.3)', () => {
    // Real capture: "load a:byte from :%-1"-style checksum read at $esp for a fasm2-built 32-bit
    // ELF binary returned contents="01000000" for the 4 bytes of a little-endian 1.
    assert.deepStrictEqual(parseHexBytes('01000000'), [1, 0, 0, 0]);
    assert.deepStrictEqual(parseHexBytes('00000000'), [0, 0, 0, 0]);
  });

  it('handles an empty string without throwing', () => {
    assert.deepStrictEqual(parseHexBytes(''), []);
  });

  it('parses a full byte range including 0xff and 0x00 correctly', () => {
    assert.deepStrictEqual(parseHexBytes('ff00ab'), [0xff, 0x00, 0xab]);
  });
});

describe('decodeLittleEndianElements', () => {
  it('decodes 4 little-endian dwords out of a flat byte array', () => {
    // table dd 1, 2, 0x1000, 0xFFFFFFFF
    const bytes = parseHexBytes('01000000' + '02000000' + '00100000' + 'ffffffff');
    const values = decodeLittleEndianElements(bytes, 4, 4);
    assert.deepStrictEqual(values, [1n, 2n, 0x1000n, 0xffffffffn]);
  });

  it('decodes bytes (1-byte elements) as a plain array, same order as memory', () => {
    const bytes = parseHexBytes('0102030a0b');
    assert.deepStrictEqual(decodeLittleEndianElements(bytes, 1, 5), [1n, 2n, 3n, 10n, 11n]);
  });

  it('decodes words (2-byte little-endian elements)', () => {
    const bytes = parseHexBytes('3412'); // 0x1234
    assert.deepStrictEqual(decodeLittleEndianElements(bytes, 2, 1), [0x1234n]);
  });

  it('treats a missing trailing byte as zero rather than throwing (a short/truncated read)', () => {
    const values = decodeLittleEndianElements([1], 4, 1);
    assert.deepStrictEqual(values, [1n]);
  });

  it('only decodes as many elements as requested, ignoring extra bytes', () => {
    const bytes = parseHexBytes('01000000' + '02000000' + '03000000');
    assert.deepStrictEqual(decodeLittleEndianElements(bytes, 4, 2), [1n, 2n]);
  });
});

describe('formatStringPreview', () => {
  it('renders a plain ASCII string with no special characters unchanged', () => {
    const bytes = [...'Hello world!'].map((c) => c.charCodeAt(0));
    const preview = formatStringPreview(bytes);
    assert.strictEqual(preview.text, 'Hello world!');
    assert.strictEqual(preview.nullTerminated, false);
  });

  it('strips a trailing null terminator and flags it, the classic "db \'msg\',0" idiom', () => {
    const bytes = [...'Hi'].map((c) => c.charCodeAt(0)).concat(0);
    const preview = formatStringPreview(bytes);
    assert.strictEqual(preview.text, 'Hi');
    assert.strictEqual(preview.nullTerminated, true);
  });

  it('escapes \\r\\n as short escapes, not raw control characters (must render on one line)', () => {
    const bytes = [...'Hi'].map((c) => c.charCodeAt(0)).concat(13, 10);
    const preview = formatStringPreview(bytes);
    assert.strictEqual(preview.text, 'Hi\\r\\n');
    assert.ok(!preview.text.includes('\n'), 'must not contain a literal newline');
  });

  it('escapes a literal double quote and backslash so the result stays safe inside a quoted display string', () => {
    const bytes = [34, 92]; // '"' '\'
    const preview = formatStringPreview(bytes);
    assert.strictEqual(preview.text, '\\"\\\\');
  });

  it('escapes non-printable/high bytes as \\xNN', () => {
    const preview = formatStringPreview([0x01, 0xff, 0x80]);
    assert.strictEqual(preview.text, '\\x01\\xff\\x80');
  });

  it('handles an empty byte array without throwing', () => {
    assert.deepStrictEqual(formatStringPreview([]), { text: '', nullTerminated: false });
  });
});

describe('sizeName', () => {
  it('names every recognized fasmg size keyword', () => {
    assert.strictEqual(sizeName(1), 'byte');
    assert.strictEqual(sizeName(2), 'word');
    assert.strictEqual(sizeName(4), 'dword');
    assert.strictEqual(sizeName(8), 'qword');
    assert.strictEqual(sizeName(16), 'dqword');
  });

  it('falls back to a plain "N-byte" label for an unnamed size instead of throwing', () => {
    assert.strictEqual(sizeName(3), '3-byte');
  });
});
