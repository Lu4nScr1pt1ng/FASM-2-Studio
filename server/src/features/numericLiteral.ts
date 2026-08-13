// Reading a number in a base other than the one it is written in is constant, unavoidable work in
// assembly — a flag mask written as a hex constant, a bit position written in decimal, a character
// written as a byte. Every one of those is a context switch out of the editor to a calculator, for
// a conversion the editor already has everything it needs to do.
//
// Which literal forms exist here is not a matter of taste: it is exactly what fasmg's own
// `convert_number` (source/expressions.inc) accepts, cross-checked by assembling each form against
// fasm2/fasmg g.kp60 and fasm1 1.73.32, which agree.
//
// That routine recognizes two prefixes and five suffixes and nothing else:
//
//     cmp byte [edx],'$'    → hexadecimal
//     cmp word [edx],'0x'   → hexadecimal
//     suffix h → hex, b → binary, o/q → octal, d → decimal, anything else → plain decimal
//
// Two consequences are easy to get backwards. `0b1010` and `0o17` are *not* binary and octal: there
// is no `0b`/`0o` prefix in that code at all, so they fall through to the decimal path, which
// rejects the embedded letter — the assembler answers "invalid number". And the `0x` test is a
// two-byte compare against the literal characters, so it is the one case-sensitive comparison here;
// `0X1F` is rejected while `1FH` and `0xAb` are fine, the suffix and digits being folded through
// fasmg's `characters` table.
//
// Every base also accepts `_` and `'` between digits as separators, discarded before conversion.

/** Bases fasmg writes, keyed by the suffix letter that selects them. `q` is an alternative octal
 * suffix, and `d` an explicit decimal one (useful only to disambiguate inside a `hex`-defaulted
 * context, but legal everywhere). */
const SUFFIX_BASES: Record<string, number> = { h: 16, b: 2, o: 8, q: 8, d: 10 };

const DIGITS_FOR_BASE: Record<number, RegExp> = {
  2: /^[01]+$/,
  8: /^[0-7]+$/,
  10: /^[0-9]+$/,
  16: /^[0-9a-f]+$/,
};

export interface NumericLiteral {
  /** The literal exactly as written, for echoing back in the hover heading. */
  text: string;
  value: bigint;
  base: number;
}

/**
 * The integer a token denotes, or undefined if it is not a numeric literal at all.
 *
 * A token starting with a letter is never a number in fasm — identifiers may not start with a
 * digit, so the two can't collide — which is what makes `1010b` unambiguously binary rather than a
 * symbol named `1010b`.
 */
export function parseNumericLiteral(text: string): NumericLiteral | undefined {
  const parsed = parseDigits(text);
  if (parsed === undefined) return undefined;
  return { text, value: parsed.value, base: parsed.base };
}

function parseDigits(text: string): { value: bigint; base: number } | undefined {
  // Case-sensitive on purpose, and only here: `0X1F` is not a number to this assembler.
  if (text.startsWith('0x')) return digitsIn(text.slice(2).toLowerCase(), 16);

  const lower = text.toLowerCase();

  // `$` is fasm's other hex prefix, but a bare `$` is the current-address symbol and `$$` the
  // start of the current section — neither is a literal, and both reach here as words.
  if (lower.startsWith('$')) return digitsIn(lower.slice(1), 16);

  // A literal has to start with a digit. It is fasmg's *tokenizer*, not convert_number, that
  // decides this: a token beginning with a letter is a name, so `FFh` is an undefined symbol
  // rather than 255, and `0FFh` is how that value actually gets written.
  if (!/^[0-9]/.test(lower)) return undefined;

  const suffixBase = SUFFIX_BASES[lower.slice(-1)];
  if (suffixBase !== undefined && lower.length > 1) return digitsIn(lower.slice(0, -1), suffixBase);

  // Floating-point and anything else with a stray character falls out here: digitsIn accepts only
  // the digits of its base, and a plain run of decimal digits is the only remaining valid form.
  return digitsIn(lower, 10);
}

function digitsIn(rawDigits: string, base: number): { value: bigint; base: number } | undefined {
  const digits = rawDigits.replace(/[_']/g, '');
  if (!digits || !DIGITS_FOR_BASE[base].test(digits)) return undefined;
  let value = 0n;
  const radix = BigInt(base);
  for (const digit of digits) value = value * radix + BigInt(parseInt(digit, 16));
  return { value, base };
}

/** Widths a value is shown as a signed number in, when it has that width's sign bit set. */
const SIGNED_WIDTHS: ReadonlyArray<{ bits: number; label: string }> = [
  { bits: 8, label: 'byte' },
  { bits: 16, label: 'word' },
  { bits: 32, label: 'dword' },
  { bits: 64, label: 'qword' },
];

/**
 * How the same value reads as a signed integer, or undefined when that adds nothing.
 *
 * Only the narrowest width that can hold the value is considered, and only when its sign bit is
 * set: `0FFh` is worth flagging as -1 in a byte, while `1` is not worth flagging as 1 in every
 * width there is.
 */
export function signedReading(value: bigint): { text: string; label: string } | undefined {
  if (value < 0n) return undefined;
  const width = SIGNED_WIDTHS.find((w) => value < 1n << BigInt(w.bits));
  if (!width) return undefined;
  const signBit = 1n << BigInt(width.bits - 1);
  if (value < signBit) return undefined;
  return { text: (value - (1n << BigInt(width.bits))).toString(), label: width.label };
}

/** The printable ASCII character a value stands for, ready to paste as a fasm character literal.
 * Control codes and anything past 7-bit are excluded — there is no useful character to show. */
export function characterReading(value: bigint): string | undefined {
  if (value < 0x20n || value > 0x7en) return undefined;
  const char = String.fromCharCode(Number(value));
  return char === "'" ? '"\'"' : `'${char}'`;
}

/** Groups a binary string into nibbles (`1111_0000`), which is how bit patterns are actually read.
 * fasmg rejects `_` inside a literal, so this is display only and never round-trips as code. */
export function groupBinary(bits: string): string {
  const padded = bits.padStart(Math.ceil(bits.length / 4) * 4, '0');
  return (padded.match(/.{4}/g) ?? [padded]).join('_');
}
