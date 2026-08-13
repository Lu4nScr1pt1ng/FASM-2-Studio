import * as assert from 'assert';
import { characterReading, groupBinary, literalConversions, parseNumericLiteral, signedReading } from '../src/features/numericLiteral';

/** The integer a literal denotes, or undefined if it is not one. */
function valueOf(text: string): bigint | undefined {
  return parseNumericLiteral(text)?.value;
}

describe('parseNumericLiteral', () => {
  // Every expectation here was checked against the assembler itself before being written down —
  // fasm2/fasmg g.kp60 and fasm1 1.73.32 — and matches fasmg's own convert_number in
  // source/expressions.inc. Guessing at this grammar from C habits gets it wrong in both
  // directions, so the surprising cases are asserted explicitly rather than left implied.

  it('reads the two prefixes fasmg actually has', () => {
    assert.strictEqual(valueOf('0x1F'), 31n);
    assert.strictEqual(valueOf('0xAb'), 171n, 'hex digits are case-insensitive');
    assert.strictEqual(valueOf('$1F'), 31n, 'the pascal-style hex prefix');
  });

  it('rejects 0X with a capital X, which the assembler compares byte-for-byte', () => {
    // convert_number does `cmp word [edx],'0x'` — a literal two-byte comparison, and the only
    // case-sensitive test in the whole routine.
    assert.strictEqual(valueOf('0X1F'), undefined);
  });

  it('reads every base suffix, case-insensitively', () => {
    assert.strictEqual(valueOf('1Fh'), 31n);
    assert.strictEqual(valueOf('1FH'), 31n);
    assert.strictEqual(valueOf('1010b'), 10n);
    assert.strictEqual(valueOf('1010B'), 10n);
    assert.strictEqual(valueOf('17o'), 15n);
    assert.strictEqual(valueOf('17q'), 15n, 'q is the alternative octal suffix');
    assert.strictEqual(valueOf('99d'), 99n);
    assert.strictEqual(valueOf('99'), 99n);
  });

  it('rejects the C-style 0b and 0o prefixes, which this assembler does not have', () => {
    // The trap this test exists for: these *look* like binary and octal, but fasmg has no prefix
    // mechanism besides 0x, so they reach the decimal path and are rejected for the embedded
    // letter. Accepting them would report 0b1010 as 10 for source that does not assemble at all.
    assert.strictEqual(valueOf('0b1010'), undefined);
    assert.strictEqual(valueOf('0o17'), undefined);
    assert.strictEqual(valueOf('0d99'), undefined);
    assert.strictEqual(valueOf('0q17'), undefined);
  });

  it('reads 0b as zero with a binary suffix, not as an empty prefix', () => {
    assert.strictEqual(valueOf('0b'), 0n);
  });

  it('accepts _ and \' between digits, in every base', () => {
    assert.strictEqual(valueOf('1_000'), 1000n);
    assert.strictEqual(valueOf("1'000"), 1000n);
    assert.strictEqual(valueOf('0xFF_FF'), 65535n);
    assert.strictEqual(valueOf('1010_1010b'), 170n);
    assert.strictEqual(valueOf('0x_FF'), 255n, 'a separator may follow the prefix');
  });

  it('is not fooled by tokens that only look numeric', () => {
    assert.strictEqual(valueOf('FFh'), undefined, 'starts with a letter, so it is a symbol name');
    assert.strictEqual(valueOf('_100'), undefined);
    assert.strictEqual(valueOf('$'), undefined, 'the current-address symbol');
    assert.strictEqual(valueOf('$$'), undefined, 'the start of the current section');
    assert.strictEqual(valueOf('0x'), undefined, 'a prefix with no digits');
    assert.strictEqual(valueOf('1.5'), undefined, 'a float is not an integer literal');
    assert.strictEqual(valueOf('189b'), undefined, '8 and 9 are not binary digits');
    assert.strictEqual(valueOf('99o'), undefined, '9 is not an octal digit');
    assert.strictEqual(valueOf(''), undefined);
  });

  it('reports the base it was written in, so the hover can skip that row', () => {
    assert.strictEqual(parseNumericLiteral('0x1F')?.base, 16);
    assert.strictEqual(parseNumericLiteral('1010b')?.base, 2);
    assert.strictEqual(parseNumericLiteral('17o')?.base, 8);
    assert.strictEqual(parseNumericLiteral('99')?.base, 10);
  });

  it('handles values far past 64 bits without losing precision', () => {
    assert.strictEqual(valueOf('0xFFFFFFFFFFFFFFFF'), 18446744073709551615n);
    assert.strictEqual(valueOf('0x1FFFFFFFFFFFFFFFF'), 36893488147419103231n);
  });
});

describe('signedReading', () => {
  it('reads a value with its sign bit set as the negative it would be', () => {
    assert.deepStrictEqual(signedReading(0xffn), { text: '-1', label: 'byte' });
    assert.deepStrictEqual(signedReading(0x80n), { text: '-128', label: 'byte' });
    assert.deepStrictEqual(signedReading(0xffffn), { text: '-1', label: 'word' });
    assert.deepStrictEqual(signedReading(0xffffffffn), { text: '-1', label: 'dword' });
  });

  it('stays quiet when the value is positive in its own width', () => {
    // Otherwise every literal in a file would carry a meaningless "signed" row.
    assert.strictEqual(signedReading(1n), undefined);
    assert.strictEqual(signedReading(0x7fn), undefined);
    assert.strictEqual(signedReading(0x100n), undefined, 'fits a word, and is positive there');
  });

  it('stays quiet past 64 bits, where no machine width applies', () => {
    assert.strictEqual(signedReading(1n << 64n), undefined);
  });
});

describe('characterReading', () => {
  it('names the printable character a byte stands for', () => {
    assert.strictEqual(characterReading(0x41n), "'A'");
    assert.strictEqual(characterReading(0x20n), "' '");
  });

  it('quotes an apostrophe in a way fasm can actually read back', () => {
    assert.strictEqual(characterReading(0x27n), '"\'"');
  });

  it('offers nothing for control codes or values past 7-bit ASCII', () => {
    assert.strictEqual(characterReading(0x0an), undefined);
    assert.strictEqual(characterReading(0x7fn), undefined);
    assert.strictEqual(characterReading(0xe9n), undefined);
  });
});

describe('groupBinary', () => {
  it('pads to whole nibbles and groups them, the way bit patterns are read', () => {
    assert.strictEqual(groupBinary('1010'), '1010');
    assert.strictEqual(groupBinary('101'), '0101');
    assert.strictEqual(groupBinary('110101010'), '0001_1010_1010');
  });
});

describe('literalConversions', () => {
  const textFor = (word: string, label: string): string | undefined =>
    literalConversions(parseNumericLiteral(word)!).find((c) => c.label === label)?.text;

  it('offers every other base the same value can be written in', () => {
    assert.deepStrictEqual(
      literalConversions(parseNumericLiteral('255')!).map((c) => `${c.label}=${c.text}`),
      ['hexadecimal=0xFF', 'binary=1111_1111b', 'octal=377o'],
    );
  });

  it('never offers the base the literal is already written in', () => {
    assert.strictEqual(textFor('0x1F', 'hexadecimal'), undefined);
    assert.strictEqual(textFor('1010b', 'binary'), undefined);
    assert.strictEqual(textFor('17o', 'octal'), undefined);
    assert.strictEqual(textFor('99', 'decimal'), undefined);
  });

  it('reads the h-suffixed and $-prefixed hex forms as hex, so neither offers hex back', () => {
    assert.strictEqual(textFor('0FFh', 'hexadecimal'), undefined);
    assert.strictEqual(textFor('$FF', 'hexadecimal'), undefined);
    assert.strictEqual(textFor('0FFh', 'decimal'), '255');
  });

  it('writes hex in the "0x" form, which needs no leading-zero guard', () => {
    // The h-suffixed form of a value whose first digit is a letter has to be written "0FFh": a
    // token starting with a letter is a name. "0x" sidesteps that entirely.
    assert.strictEqual(textFor('255', 'hexadecimal'), '0xFF');
  });

  it('offers the character form only for printable ASCII', () => {
    assert.strictEqual(textFor('65', 'character'), "'A'");
    assert.strictEqual(textFor('10', 'character'), undefined);
    assert.strictEqual(textFor('300', 'character'), undefined);
  });

  it('never offers a rewrite that produces exactly what is already there', () => {
    for (const word of ['255', '0x1F', '1010b', '17o', '65', '7', '0']) {
      const literal = parseNumericLiteral(word)!;
      assert.ok(
        literalConversions(literal).every((c) => c.text !== word),
        `${word} offered itself back`,
      );
    }
  });
});
