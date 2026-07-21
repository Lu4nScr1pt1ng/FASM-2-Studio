import * as assert from 'assert';
import { ListingEntry } from '../src/listingMap';
import { buildConstantMap, buildSymbolAddressMap, formatConstantCompact, formatConstantDetailed } from '../src/symbols';

function entry(address: number, text: string): ListingEntry {
  return { address: BigInt(address), text };
}

describe('buildSymbolAddressMap', () => {
  it('resolves a data label ("argc dd ?") to its address and 4-byte (dd) size, one element', () => {
    // The exact listing shape a real "mov ecx,[esp] / mov [argc],ecx / ... / argc dd ?" program
    // produces (captured against a real fasm2-built 32-bit "format ELF executable 3" binary).
    const entries = [
      entry(0x8048074, 'mov ecx, [esp]'),
      entry(0x8048077, 'mov [argc], ecx'),
      entry(0x804807d, 'mov eax, 1'),
      entry(0x8049089, 'argc dd ?'),
    ];
    const symbols = buildSymbolAddressMap(entries);
    const argc = symbols.get('argc');
    assert.ok(argc);
    assert.strictEqual(argc!.address, 0x8049089n);
    assert.strictEqual(argc!.elementSizeBytes, 4);
    assert.strictEqual(argc!.elementCount, 1);
    assert.strictEqual(argc!.stringLengthBytes, undefined);
  });

  it('resolves a plain code label ("start:") to its address with no size — never guesses at instruction bytes', () => {
    const entries = [entry(0x8048074, 'start:'), entry(0x8048074, 'mov ecx, [esp]')];
    const symbols = buildSymbolAddressMap(entries);
    const start = symbols.get('start');
    assert.ok(start);
    assert.strictEqual(start!.address, 0x8048074n);
    assert.strictEqual(start!.elementSizeBytes, undefined);
  });

  it('resolves an area label ("cache::") the same as a plain label, address-only', () => {
    const entries = [entry(0x1000, 'cache::'), entry(0x1000, 'db 0')];
    const symbols = buildSymbolAddressMap(entries);
    assert.strictEqual(symbols.get('cache')!.address, 0x1000n);
  });

  it('infers sizes for every data-directive width, not just dd', () => {
    const entries = [
      entry(0, 'flag db ?'),
      entry(1, 'count dw 0'),
      entry(3, 'total dd 0'),
      entry(7, 'big dq 0'),
      entry(15, 'wide ddq 0'),
      entry(31, 'buf rb 16'),
    ];
    const symbols = buildSymbolAddressMap(entries);
    assert.strictEqual(symbols.get('flag')!.elementSizeBytes, 1);
    assert.strictEqual(symbols.get('count')!.elementSizeBytes, 2);
    assert.strictEqual(symbols.get('total')!.elementSizeBytes, 4);
    assert.strictEqual(symbols.get('big')!.elementSizeBytes, 8);
    assert.strictEqual(symbols.get('wide')!.elementSizeBytes, 16);
    assert.strictEqual(symbols.get('buf')!.elementSizeBytes, 1);
  });

  it('resolves an explicit "label NAME:size" directive using the built-in size keyword', () => {
    const entries = [entry(0x2000, 'label wchar:word at char')];
    const symbols = buildSymbolAddressMap(entries);
    const wchar = symbols.get('wchar');
    assert.ok(wchar);
    assert.strictEqual(wchar!.address, 0x2000n);
    assert.strictEqual(wchar!.elementSizeBytes, 2);
  });

  it('resolves "label NAME" with no size at all to an address-only symbol', () => {
    const entries = [entry(0x2000, 'label character')];
    const symbols = buildSymbolAddressMap(entries);
    assert.strictEqual(symbols.get('character')!.address, 0x2000n);
    assert.strictEqual(symbols.get('character')!.elementSizeBytes, undefined);
  });

  it('keeps the first definition when the same name is (re)defined more than once', () => {
    const entries = [entry(0x100, 'x dd 1'), entry(0x200, 'x dd 2')];
    const symbols = buildSymbolAddressMap(entries);
    assert.strictEqual(symbols.get('x')!.address, 0x100n);
  });

  it('ignores ordinary instruction lines and comments entirely', () => {
    const entries = [entry(0, 'mov eax, 1'), entry(3, 'add eax, ebx'), entry(6, 'nop')];
    const symbols = buildSymbolAddressMap(entries);
    assert.strictEqual(symbols.size, 0);
  });

  it('never throws on an empty or malformed entry list', () => {
    assert.doesNotThrow(() => buildSymbolAddressMap([]));
    assert.doesNotThrow(() => buildSymbolAddressMap([entry(0, ''), entry(0, '   '), entry(0, '::: garbled +')]));
  });

  describe('array (multi-element) declarations', () => {
    it('counts every comma-separated element of a "dd" array, not just the first', () => {
      const entries = [entry(0x100, 'table dd 10, 20, 30, 40')];
      const symbols = buildSymbolAddressMap(entries);
      const table = symbols.get('table')!;
      assert.strictEqual(table.elementSizeBytes, 4);
      assert.strictEqual(table.elementCount, 4);
      assert.strictEqual(table.stringLengthBytes, undefined);
    });

    it('does not split a comma that sits inside a "dup (...)" group', () => {
      const entries = [entry(0x100, 'buf db 2 dup (1, 2)')];
      const symbols = buildSymbolAddressMap(entries);
      const buf = symbols.get('buf')!;
      // The dup group is one top-level element to this lightweight scan (it doesn't evaluate the
      // "2 dup" repetition count) — the important thing is it isn't miscounted as 2 elements from
      // the comma *inside* the parentheses.
      assert.strictEqual(buf.elementCount, 1);
    });

    it('reads a "rb"-style reserve count as the element count when it is a plain integer literal', () => {
      const entries = [entry(0x100, 'buf rb 16')];
      const symbols = buildSymbolAddressMap(entries);
      assert.strictEqual(symbols.get('buf')!.elementCount, 16);
    });

    it('leaves elementCount undefined for a reserve directive whose count is a symbolic expression, rather than guessing', () => {
      const entries = [entry(0x100, 'buf rb BUFFER_SIZE')];
      const symbols = buildSymbolAddressMap(entries);
      assert.strictEqual(symbols.get('buf')!.elementCount, undefined);
      assert.strictEqual(symbols.get('buf')!.elementSizeBytes, 1);
    });
  });

  describe('string detection', () => {
    it('detects a classic "msg db \'text\', 0" buffer and computes its true combined byte length', () => {
      const entries = [entry(0x200, "msg db 'Hello world!', 13, 10, 0")];
      const symbols = buildSymbolAddressMap(entries);
      const msg = symbols.get('msg')!;
      assert.strictEqual(msg.elementSizeBytes, 1);
      // "Hello world!" = 12 bytes + 3 explicit single-byte values (13, 10, 0) = 15.
      assert.strictEqual(msg.stringLengthBytes, 15);
      assert.strictEqual(msg.elementCount, 4); // 1 string group + 3 numeric groups
    });

    it('does not set stringLengthBytes for a purely numeric "db" array with no string literal', () => {
      const entries = [entry(0x200, 'bytes db 1, 2, 3')];
      const symbols = buildSymbolAddressMap(entries);
      assert.strictEqual(symbols.get('bytes')!.stringLengthBytes, undefined);
    });

    it('does not treat a "dd"/"dw" string-containing declaration as a byte string (only db gets this treatment)', () => {
      // Real fasmg still allows a string in a wider directive, but this lightweight scan only
      // special-cases the common 1-byte-element "message buffer" idiom.
      const entries = [entry(0x200, "wide dd 'AB'")];
      const symbols = buildSymbolAddressMap(entries);
      const wide = symbols.get('wide')!;
      assert.strictEqual(wide.elementSizeBytes, 4);
      assert.strictEqual(wide.stringLengthBytes, undefined);
    });

    it('handles a bare string with no trailing numeric terminator at all', () => {
      const entries = [entry(0x200, "greeting db 'ABC'")];
      const symbols = buildSymbolAddressMap(entries);
      const sym = symbols.get('greeting');
      assert.ok(sym);
      assert.strictEqual(sym!.stringLengthBytes, 3);
      assert.strictEqual(sym!.elementCount, 1);
    });
  });
});

describe('buildConstantMap', () => {
  it('resolves "NAME = literal", the exact real listing shape for "FD_STDERR = 2"', () => {
    // Captured from a real fasm2 build (format ELF executable 3, "FD_STDERR = 2" /
    // "FD_STDOUT equ 1" followed by "mov eax, FD_STDERR") — the defining line keeps the address
    // of whatever code follows it (it emits no bytes of its own), and the listing never
    // substitutes the value at usage sites, only at the definition.
    const entries = [entry(0x8048054, 'entry start'), entry(0x8048054, 'FD_STDERR = 2'), entry(0x8048054, 'FD_STDOUT equ 1')];
    const constants = buildConstantMap(entries);
    const fdStderr = constants.get('FD_STDERR');
    assert.ok(fdStderr);
    assert.strictEqual(fdStderr!.value, 2n);
    assert.strictEqual(fdStderr!.definedVia, '=');
  });

  it('resolves "NAME equ literal" and "NAME reequ literal"', () => {
    const entries = [entry(0, 'FD_STDOUT equ 1'), entry(0, 'X reequ 5')];
    const constants = buildConstantMap(entries);
    assert.strictEqual(constants.get('FD_STDOUT')!.value, 1n);
    assert.strictEqual(constants.get('FD_STDOUT')!.definedVia, 'equ');
    assert.strictEqual(constants.get('X')!.value, 5n);
    assert.strictEqual(constants.get('X')!.definedVia, 'reequ');
  });

  it('resolves "NAME := literal" and "NAME =: literal" only when written with no space, matching fasmg itself', () => {
    const entries = [entry(0, 'A := 10'), entry(0, 'B =: 20')];
    const constants = buildConstantMap(entries);
    assert.strictEqual(constants.get('A')!.value, 10n);
    assert.strictEqual(constants.get('A')!.definedVia, ':=');
    assert.strictEqual(constants.get('B')!.value, 20n);
    assert.strictEqual(constants.get('B')!.definedVia, '=:');
  });

  it('resolves "define NAME literal" / "redefine NAME literal" -- the directive comes first, the name second', () => {
    const entries = [entry(0, 'define Y -5'), entry(0, 'redefine Y 7')];
    const constants = buildConstantMap(entries);
    // First definition wins, same convention as buildSymbolAddressMap.
    assert.strictEqual(constants.get('Y')!.value, -5n);
    assert.strictEqual(constants.get('Y')!.definedVia, 'define');
  });

  it('parses hex (0x.../...h), binary (0b.../...b), and negative literals', () => {
    const entries = [entry(0, 'A = 0x2a'), entry(0, 'B = 2Ah'), entry(0, 'C = 0b101010'), entry(0, 'D = 101010b'), entry(0, 'E = -1')];
    const constants = buildConstantMap(entries);
    assert.strictEqual(constants.get('A')!.value, 42n);
    assert.strictEqual(constants.get('B')!.value, 42n);
    assert.strictEqual(constants.get('C')!.value, 42n);
    assert.strictEqual(constants.get('D')!.value, 42n);
    assert.strictEqual(constants.get('E')!.value, -1n);
  });

  it('strips digit separators ("_"/"\'") from a literal before parsing, matching fasmg\'s own number syntax', () => {
    const entries = [entry(0, "A = 1'000'000")];
    const constants = buildConstantMap(entries);
    assert.strictEqual(constants.get('A')!.value, 1000000n);
  });

  it('leaves value undefined (but keeps the raw text) for a right-hand side that isn\'t a plain literal', () => {
    const entries = [entry(0, 'X = Y + 1')];
    const constants = buildConstantMap(entries);
    const x = constants.get('X');
    assert.ok(x);
    assert.strictEqual(x!.value, undefined);
    assert.strictEqual(x!.rawText, 'Y + 1');
  });

  it('never resolves the built-in pseudo-variables ($, $$, %, %%, ...) as if they were ordinary constants', () => {
    // These aren't really "defined" via "=" in real code, but a defensive check all the same —
    // mirrors server/src/parser/symbolIndex.ts's own BUILTIN_PSEUDO_VARIABLES exclusion.
    const entries = [entry(0, '$ = 5'), entry(0, '%% = 3')];
    const constants = buildConstantMap(entries);
    assert.strictEqual(constants.size, 0);
  });

  it('keeps the first definition when the same name is (re)defined more than once', () => {
    const entries = [entry(0, 'X = 1'), entry(0, 'X = 2')];
    const constants = buildConstantMap(entries);
    assert.strictEqual(constants.get('X')!.value, 1n);
  });

  it('ignores ordinary instruction lines and never throws on malformed input', () => {
    const entries = [entry(0, 'mov eax, 1'), entry(0, ''), entry(0, '=== garbled')];
    assert.doesNotThrow(() => {
      const constants = buildConstantMap(entries);
      assert.strictEqual(constants.size, 0);
    });
  });
});

describe('formatConstantDetailed / formatConstantCompact', () => {
  it('formats a resolved numeric constant as hex + decimal, both detailed and compact', () => {
    const c = { name: 'FD_STDERR', value: 2n, rawText: '2', definedVia: '=' as const };
    assert.strictEqual(formatConstantDetailed(c), 'FD_STDERR  (constant, defined via "=")\nvalue = 0x2  2');
    assert.strictEqual(formatConstantCompact(c), '0x2  2');
  });

  it('formats a negative constant with a signed hex representation', () => {
    const c = { name: 'X', value: -1n, rawText: '-1', definedVia: 'equ' as const };
    assert.strictEqual(formatConstantCompact(c), '-0x1  -1');
  });

  it('falls back to the raw definition text when the value could not be parsed', () => {
    const c = { name: 'X', value: undefined, rawText: 'Y + 1', definedVia: '=' as const };
    assert.strictEqual(formatConstantDetailed(c), 'X  (constant, defined via "=")\ntext: Y + 1  (not a plain number — this lightweight scan doesn\'t evaluate expressions)');
    assert.strictEqual(formatConstantCompact(c), '(constant) Y + 1');
  });
});
