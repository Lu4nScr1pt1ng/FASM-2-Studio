import * as assert from 'assert';
import {
  decodeEflags,
  EFLAGS_BITS,
  evaluateJumpConditions,
  formatBinaryGrouped,
  formatBytesLittleEndian,
  formatEflagsSummary,
  formatHexPadded,
  formatRegisterDetailed,
  formatRegisterValue,
  formatRegisterValueCompact,
  packedAsciiText,
  parseUserNumber,
  REGISTER_WIDTH_BITS,
  resolveRegisterGroups,
  subRegisterViews,
  unsignedCastType,
} from '../src/registers';

// Real "-data-list-register-names" output, captured from gdb 16.3 against actual fasm2-compiled
// ELF binaries (a 32-bit "format ELF executable 3" and a 64-bit "format ELF64 executable 3") —
// see the commit this file was added in for how (a plain `gdb --interpreter=mi3 prog < cmds.txt`
// session). Grounding the test in what gdb *actually* reports, not an assumption about it, is the
// whole point: this is exactly the data that exposed the original "<unavailable>" bug on 32-bit
// targets in the first place.
const I386_REGISTER_NAMES = [
  'eax', 'ecx', 'edx', 'ebx', 'esp', 'ebp', 'esi', 'edi', 'eip', 'eflags', 'cs', 'ss', 'ds', 'es', 'fs', 'gs',
  'st0', 'st1', 'st2', 'st3', 'st4', 'st5', 'st6', 'st7', 'fctrl', 'fstat', 'ftag', 'fiseg', 'fioff', 'foseg', 'fooff', 'fop',
  'xmm0', 'xmm1', 'xmm2', 'xmm3', 'xmm4', 'xmm5', 'xmm6', 'xmm7', 'mxcsr',
];

const X86_64_REGISTER_NAMES = [
  'rax', 'rbx', 'rcx', 'rdx', 'rsi', 'rdi', 'rbp', 'rsp',
  'r8', 'r9', 'r10', 'r11', 'r12', 'r13', 'r14', 'r15',
  'rip', 'eflags', 'cs', 'ss', 'ds', 'es', 'fs', 'gs',
];

describe('resolveRegisterGroups', () => {
  it('groups a 32-bit (i386) target onto its own e-prefixed registers, not the 64-bit r-prefixed names', () => {
    const groups = resolveRegisterGroups(I386_REGISTER_NAMES);
    assert.deepStrictEqual(groups.generalPurpose, ['eax', 'ebx', 'ecx', 'edx', 'esi', 'edi']);
    assert.deepStrictEqual(groups.pointers, ['ebp', 'esp', 'eip']);
    assert.deepStrictEqual(groups.segment, ['cs', 'ss', 'ds', 'es', 'fs', 'gs']);
    assert.strictEqual(groups.eflagsName, 'eflags');
  });

  it('groups a 64-bit (x86-64) target onto rax/rbx/... plus r8-r15, in a fixed reading order regardless of gdb\'s own array order', () => {
    const groups = resolveRegisterGroups(X86_64_REGISTER_NAMES);
    assert.deepStrictEqual(
      groups.generalPurpose,
      ['rax', 'rbx', 'rcx', 'rdx', 'rsi', 'rdi', 'r8', 'r9', 'r10', 'r11', 'r12', 'r13', 'r14', 'r15'],
    );
    assert.deepStrictEqual(groups.pointers, ['rbp', 'rsp', 'rip']);
    assert.deepStrictEqual(groups.segment, ['cs', 'ss', 'ds', 'es', 'fs', 'gs']);
    assert.strictEqual(groups.eflagsName, 'eflags');
  });

  it('never puts both the 32-bit and 64-bit name for the same logical register in the same group', () => {
    // The real regression this guards: a 64-bit target's register-names array *also* contains
    // "eax"/"ebx"/... as sub-register aliases (see X86_64 fixture above's tail entries in a real
    // capture) — picking both would double-count the same physical register under two names.
    const groups = resolveRegisterGroups([...X86_64_REGISTER_NAMES, 'eax', 'ebx', 'ecx', 'edx', 'esi', 'edi', 'ebp', 'esp']);
    assert.deepStrictEqual(groups.generalPurpose.filter((n) => n === 'rax' || n === 'eax'), ['rax']);
  });

  it('ignores empty-string placeholder entries (gdb pads unused register-number slots with them)', () => {
    const groups = resolveRegisterGroups(['eax', '', '', 'ebx', 'ecx', 'edx', 'esi', 'edi', 'ebp', 'esp', 'eip', 'eflags']);
    assert.strictEqual(groups.generalPurpose.length, 6);
  });

  it('drops a group entirely (rather than padding with placeholders) when the target reports none of its members', () => {
    const groups = resolveRegisterGroups(['eax']);
    assert.deepStrictEqual(groups.pointers, []);
    assert.deepStrictEqual(groups.segment, []);
    assert.strictEqual(groups.eflagsName, undefined);
  });

  it('is case-insensitive against gdb\'s own reported names', () => {
    const groups = resolveRegisterGroups(['EAX', 'EBX']);
    assert.deepStrictEqual(groups.generalPurpose, ['eax', 'ebx']);
  });
});

describe('REGISTER_WIDTH_BITS', () => {
  it('covers segment registers (cs/ss/ds/es/fs/gs) at 16 bits', () => {
    for (const seg of ['cs', 'ss', 'ds', 'es', 'fs', 'gs']) {
      assert.strictEqual(REGISTER_WIDTH_BITS[seg], 16, seg);
    }
  });

  it('covers eip (32-bit instruction pointer), not just rip', () => {
    assert.strictEqual(REGISTER_WIDTH_BITS.eip, 32);
    assert.strictEqual(REGISTER_WIDTH_BITS.rip, 64);
  });
});

describe('decodeEflags', () => {
  it('decodes a real post-boot flags value (0x202: reserved bit 1 always set, plus IF)', () => {
    const bits = decodeEflags(0x202n);
    const byName = new Map(bits.map((b) => [b.name, b.value]));
    assert.strictEqual(byName.get('IF'), 1);
    assert.strictEqual(byName.get('ZF'), 0);
    assert.strictEqual(byName.get('CF'), 0);
  });

  it('decodes ZF/CF/SF/OF set together, matching a real "cmp" that produced a zero, negative-adjacent result', () => {
    // CF(0)=1, ZF(6)=1, SF(7)=1, OF(11)=1 -> 0x8C1
    const bits = decodeEflags(0x8c1n);
    const byName = new Map(bits.map((b) => [b.name, b.value]));
    assert.strictEqual(byName.get('CF'), 1);
    assert.strictEqual(byName.get('ZF'), 1);
    assert.strictEqual(byName.get('SF'), 1);
    assert.strictEqual(byName.get('OF'), 1);
    assert.strictEqual(byName.get('PF'), 0);
  });

  it('decodes the 2-bit IOPL field as a single 0-3 value, not two separate 1-bit flags', () => {
    const bits = decodeEflags(0x3000n); // IOPL = 3 (bits 12-13 both set)
    const iopl = bits.find((b) => b.name === 'IOPL')!;
    assert.strictEqual(iopl.value, 3);
  });

  it('produces exactly one entry per documented bit, every entry with a non-empty description', () => {
    const bits = decodeEflags(0n);
    assert.strictEqual(bits.length, EFLAGS_BITS.length);
    for (const b of bits) assert.ok(b.description.length > 10, `${b.name} has no real description`);
  });
});

describe('formatRegisterValueCompact', () => {
  it('renders an empty 64-bit register as "0x0", not sixteen zeroes and a 64-digit binary expansion', () => {
    // The specific complaint this format exists to answer: "r15 = 0x0000000000000000  0
    // 0b0000_..._0000" is 100 characters saying one thing, and pushes every register that *does*
    // hold something off the visible width of the panel.
    assert.strictEqual(formatRegisterValueCompact(64, 0n), '0x0');
  });

  it('drops the decimal column when it would read identically to the hex one already shown', () => {
    assert.strictEqual(formatRegisterValueCompact(64, 9n), '0x9');
    assert.strictEqual(formatRegisterValueCompact(64, 10n), '0xa  10');
  });

  it('shows the two\'s-complement reading alongside the unsigned one when the sign bit is set', () => {
    assert.strictEqual(formatRegisterValueCompact(32, 0xffffffffn), '0xffffffff  4294967295  -1');
    assert.strictEqual(formatRegisterValueCompact(8, 0xffn), '0xff  255  -1');
  });

  it('keeps a small negative readable at 64 bits while dropping the 20-digit unsigned reading of it', () => {
    // Neither "18446744073709551614" nor a 64-digit binary string tells anyone this is -2.
    assert.strictEqual(formatRegisterValueCompact(64, 0xfffffffffffffffen), '0xfffffffffffffffe  -2');
  });

  it('leaves a pointer-sized value as pure hex, since neither decimal reading of it means anything', () => {
    assert.strictEqual(formatRegisterValueCompact(64, 0x7ffd1234abcdn), '0x7ffd1234abcd');
  });

  it('shows a packed character literal as text, which no numeric base makes readable', () => {
    // "mov eax, 'PATH'" — fasm packs the first character into the lowest byte.
    assert.strictEqual(formatRegisterValueCompact(32, 0x48544150n, { ascii: true }), "0x48544150  1213481296  'PATH'");
  });

  it('appends what the value points at, when the caller resolved it to a label', () => {
    assert.strictEqual(formatRegisterValueCompact(64, 0x402008n, { pointsTo: 'msg+0x8' }), '0x402008  → msg+0x8');
  });
});

describe('packedAsciiText', () => {
  it('reads the bytes in fasm\'s own packing order (first character in the lowest byte)', () => {
    assert.strictEqual(packedAsciiText(32, 0x48544150n), 'PATH');
  });

  it('ignores trailing zero bytes, so a short literal in a wide register still reads as text', () => {
    assert.strictEqual(packedAsciiText(64, 0x4948n), 'HI');
  });

  it('refuses a single printable byte — that is a small number, not text', () => {
    assert.strictEqual(packedAsciiText(64, 0x41n), undefined);
  });

  it('refuses anything with a non-printable or interior zero byte', () => {
    assert.strictEqual(packedAsciiText(32, 0x41004142n), undefined);
    assert.strictEqual(packedAsciiText(32, 0x7ffd1234n), undefined);
  });

  it('escapes the quote and backslash that would otherwise break out of the rendered literal', () => {
    assert.strictEqual(packedAsciiText(16, 0x5c27n), "\\'\\\\");
  });
});

describe('formatHexPadded / formatBinaryGrouped / formatBytesLittleEndian', () => {
  it('pads hex to the register\'s full width, so two registers line up digit for digit', () => {
    assert.strictEqual(formatHexPadded(64, 0x2an), '0x000000000000002a');
    assert.strictEqual(formatHexPadded(8, 1n), '0x01');
  });

  it('groups binary into bytes and nibbles, so a bit position can be counted off', () => {
    assert.strictEqual(formatBinaryGrouped(8, 0xffn), '0b1111_1111');
    assert.strictEqual(formatBinaryGrouped(16, 0x23n), '0b0000_0000 0010_0011');
    assert.strictEqual(formatBinaryGrouped(32, 0xffffffffn), '0b1111_1111 1111_1111 1111_1111 1111_1111');
  });

  it('lists bytes in memory order (little-endian), which is what makes an endianness mistake visible', () => {
    assert.strictEqual(formatBytesLittleEndian(32, 0x12345678n), '78 56 34 12');
  });
});

describe('subRegisterViews', () => {
  it('slices a 64-bit register into every narrower name that aliases it, high byte included', () => {
    const views = subRegisterViews('rax', 0x1122334455667788n);
    assert.deepStrictEqual(
      views.map((v) => [v.name, v.value.toString(16)]),
      [['eax', '55667788'], ['ax', '7788'], ['al', '88'], ['ah', '77']],
    );
  });

  it('uses the "d"/"w"/"b" suffix names for r8-r15, which have no legacy high-byte view', () => {
    assert.deepStrictEqual(subRegisterViews('r12', 0xffn).map((v) => v.name), ['r12d', 'r12w', 'r12b']);
  });

  it('slices a 32-bit target\'s own registers too, where there is no 64-bit name above them', () => {
    assert.deepStrictEqual(subRegisterViews('eax', 0x1234n).map((v) => v.name), ['ax', 'al', 'ah']);
  });

  it('returns nothing for a register with no narrower name at all', () => {
    assert.deepStrictEqual(subRegisterViews('rip', 0x400000n), []);
    assert.deepStrictEqual(subRegisterViews('cs', 0x33n), []);
  });
});

describe('formatRegisterValue / formatRegisterDetailed', () => {
  it('puts the name in front only for the callers that have no name column of their own', () => {
    assert.strictEqual(formatRegisterValue('eax', 32, 0x2an), 'eax = 0x2a  42');
  });

  it('answers every reading of the value at once in the hover form, sub-registers included', () => {
    const text = formatRegisterDetailed('rax', 64, 0x2an);
    assert.strictEqual(
      text,
      [
        'rax  (64-bit register)',
        '0x000000000000002a  42',
        '0b0000_0000 0000_0000 0000_0000 0000_0000 0000_0000 0000_0000 0000_0000 0010_1010',
        'bytes: 2a 00 00 00 00 00 00 00  (little-endian)',
        'eax = 0x0000002a   ax = 0x002a   al = 0x2a   ah = 0x00',
      ].join('\n'),
    );
  });

  it('spells out the signed reading and the resolved label when either applies', () => {
    const text = formatRegisterDetailed('rsi', 64, 0xffffffffffffffffn, { pointsTo: 'buffer+0x4' });
    assert.ok(text.includes('signed: -1'), text);
    assert.ok(text.endsWith('→ buffer+0x4'), text);
  });
});

describe('evaluateJumpConditions', () => {
  it('agrees with the hardware on the signed/unsigned pair that is easiest to get backwards', () => {
    // After "cmp 1, 2" on unsigned: CF=1 (below). SF=1, OF=0 -> SF≠OF, so signed less too.
    const afterCmp = evaluateJumpConditions(0x81n); // CF=1, SF=1
    const byMnemonics = new Map(afterCmp.map((c) => [c.mnemonics, c.taken]));
    assert.strictEqual(byMnemonics.get('jb / jc / jnae'), true);
    assert.strictEqual(byMnemonics.get('ja / jnbe'), false);
    assert.strictEqual(byMnemonics.get('jl / jnge'), true);
    assert.strictEqual(byMnemonics.get('jg / jnle'), false);
  });

  it('reports both halves of every condition, never both taken at once', () => {
    for (const flags of [0n, 0x202n, 0x246n, 0x8c1n]) {
      const conditions = evaluateJumpConditions(flags);
      assert.strictEqual(conditions.find((c) => c.mnemonics === 'je / jz')!.taken, !conditions.find((c) => c.mnemonics === 'jne / jnz')!.taken);
      assert.strictEqual(conditions.find((c) => c.mnemonics === 'jl / jnge')!.taken, !conditions.find((c) => c.mnemonics === 'jge / jnl')!.taken);
      for (const c of conditions) assert.ok(c.meaning.length > 5, c.mnemonics);
    }
  });

  it('treats a zero result as equal, not-below and not-above at the same time', () => {
    const byMnemonics = new Map(evaluateJumpConditions(0x40n).map((c) => [c.mnemonics, c.taken])); // ZF only
    assert.strictEqual(byMnemonics.get('je / jz'), true);
    assert.strictEqual(byMnemonics.get('jbe / jna'), true);
    assert.strictEqual(byMnemonics.get('ja / jnbe'), false);
    assert.strictEqual(byMnemonics.get('jae / jnc / jnb'), true);
  });
});

describe('formatEflagsSummary', () => {
  it('names only the set flags, the way gdb\'s own console prints them', () => {
    assert.strictEqual(formatEflagsSummary(0x246n), '[ PF ZF IF ]');
    assert.strictEqual(formatEflagsSummary(0x202n), '[ IF ]');
  });

  it('spells out IOPL as a level rather than listing it as if it were a single set bit', () => {
    assert.strictEqual(formatEflagsSummary(0x3000n), '[ IOPL=3 ]');
  });

  it('says so plainly when nothing at all is set', () => {
    assert.strictEqual(formatEflagsSummary(0n), '[ ]');
  });
});

describe('unsignedCastType', () => {
  it('maps every register bit width to its gdb C-expression unsigned type', () => {
    assert.strictEqual(unsignedCastType(8), 'unsigned char');
    assert.strictEqual(unsignedCastType(16), 'unsigned short');
    assert.strictEqual(unsignedCastType(32), 'unsigned int');
    assert.strictEqual(unsignedCastType(64), 'unsigned long');
  });
});

describe('parseUserNumber', () => {
  it('parses plain decimal, 0x-hex, 0b-binary, and asm-style "h"-suffixed hex', () => {
    assert.strictEqual(parseUserNumber('42', 32), 42n);
    assert.strictEqual(parseUserNumber('0x2a', 32), 0x2an);
    assert.strictEqual(parseUserNumber('0b101010', 32), 0b101010n);
    assert.strictEqual(parseUserNumber('2Ah', 32), 0x2an);
  });

  it('wraps a negative decimal to the register\'s own two\'s-complement bit pattern', () => {
    assert.strictEqual(parseUserNumber('-1', 32), 0xffffffffn);
    assert.strictEqual(parseUserNumber('-1', 8), 0xffn);
    assert.strictEqual(parseUserNumber('-1', 16), 0xffffn);
    assert.strictEqual(parseUserNumber('-2', 16), 0xfffen);
  });

  it('rejects (wraps modulo) a value that overflows a narrower width, rather than silently keeping high bits', () => {
    // Writing 0x1FF into an 8-bit register should behave the same way real hardware truncation
    // would (0x1FF mod 256 = 0xFF) -- confirms the modulus math in parseUserNumber is keyed off
    // the *target* register's own width, not a fixed 32/64-bit assumption.
    assert.strictEqual(parseUserNumber('0x1FF', 8), 0xffn);
    assert.strictEqual(parseUserNumber('0x1FFFF', 16), 0xffffn);
  });

  it('re-submitting the whole pre-filled display string unedited is a no-op', () => {
    // VS Code pre-fills the Registers panel's edit box with the *entire* current display line,
    // not a bare number — clicking to edit and pressing Enter without changing anything must
    // round-trip to the same value.
    assert.strictEqual(parseUserNumber('eax = 0x0000002a  42  0b00000000000000000000000000101010', 32), 0x2an);
  });

  it('picks up an edit made to just the hex column of the pre-filled display string, leaving decimal/binary as they were', () => {
    // Real bug: the old fallback always grabbed the *first* "0x..." substring in the string,
    // regardless of which column the user actually edited — so editing decimal or binary had no
    // effect at all, only hex ever "worked". This is the one case that already worked before the
    // fix; kept as a named case for symmetry with the two below.
    assert.strictEqual(parseUserNumber('eax = 0x000000ff  42  0b00000000000000000000000000101010', 32), 0xffn);
  });

  it('picks up an edit made to just the decimal column, even though hex/binary in the string are now stale', () => {
    assert.strictEqual(parseUserNumber('eax = 0x0000002a  100  0b00000000000000000000000000101010', 32), 100n);
  });

  it('picks up an edit made to just the binary column, even though hex/decimal in the string are now stale', () => {
    assert.strictEqual(parseUserNumber('eax = 0x0000002a  42  0b00000000000000000000000011111111', 32), 0xffn);
  });

  it('handles the eflags row\'s extra decoded-flags suffix (e.g. "  [ IF ]") without it interfering with the three-column parse', () => {
    assert.strictEqual(parseUserNumber('eflags = 0x00000202  514  0b00000000000000000000001000000010  [ IF ]', 32), 514n);
    // Editing decimal still works with the trailing flags text present.
    assert.strictEqual(parseUserNumber('eflags = 0x00000202  70  0b00000000000000000000001000000010  [ IF ]', 32), 70n);
  });

  it('resolves an edit to the compact two-column display by diffing against what the register holds', () => {
    // The compact form has no third column to break a tie with, so the *current* value is what says
    // which column moved: "0x2a" still agrees with it, "100" does not.
    assert.strictEqual(parseUserNumber('0x2a  100', 32, 0x2an), 100n);
    assert.strictEqual(parseUserNumber('0x64  42', 32, 0x2an), 0x64n);
  });

  it('treats a re-submitted, unedited compact display string as a no-op', () => {
    assert.strictEqual(parseUserNumber('0x2a  42', 32, 0x2an), 0x2an);
    // Both decimal readings of a negative value agree with the current one once wrapped.
    assert.strictEqual(parseUserNumber('0xffffffff  4294967295  -1', 32, 0xffffffffn), 0xffffffffn);
  });

  it('is not fooled by the digits in a register name or in a "→ label+0x8" annotation', () => {
    // Real hazard: a bare scan would read the "15" out of "r15" and the "0x8" out of the annotation.
    assert.strictEqual(parseUserNumber('r15 = 0x2a  100', 64, 0x2an), 100n);
    assert.strictEqual(parseUserNumber('0x402008  → msg+0x8', 64, 0x402008n), 0x402008n);
    assert.strictEqual(parseUserNumber("0x48544150  1213481296  'PATH'", 32, 0x48544150n), 0x48544150n);
  });

  it('falls back to the odd-column-out inference when the current value could not be read back', () => {
    assert.strictEqual(parseUserNumber('eax = 0x0000002a  100  0b00000000000000000000000000101010', 32, undefined), 100n);
  });

  it('falls back to pulling a leading 0x... when the string isn\'t a recognizable display shape', () => {
    assert.strictEqual(parseUserNumber('some text with 0x2a in it', 32), 0x2an);
  });

  it('returns undefined for genuinely unparseable input', () => {
    assert.strictEqual(parseUserNumber('not a number', 32), undefined);
  });
});
