import * as assert from 'assert';
import {
  changeReportingNames,
  decodeEflags,
  decodeExtendedFloat,
  decodeMxcsr,
  decodeSegmentSelector,
  decodeX87Control,
  decodeX87Status,
  decodeX87Tags,
  EFLAGS_BITS,
  float32FromBits,
  float64FromBits,
  formatBitFieldSummary,
  formatChangedSummary,
  formatExtendedFloat,
  formatMaskRegister,
  formatPkru,
  formatRegisterDelta,
  formatSegmentSelector,
  popCount,
  formatVectorValueCompact,
  isReservedRegisterMnemonic,
  PSEUDO_REGISTER_WIDTH_BITS,
  registerWidthBits,
  VECTOR_WIDTH_BITS,
  vectorLaneGroups,
  vectorSubRegisterViews,
  evaluateJumpConditions,
  formatBinaryGrouped,
  formatBytesLittleEndian,
  formatEflagsSummary,
  formatHexPadded,
  formatRegisterDetailed,
  formatRegisterValue,
  formatRegisterValueCompact,
  gdbRegisterName,
  packedAsciiText,
  parseUserNumber,
  REGISTER_WIDTH_BITS,
  resolveRegisterGroups,
  subRegisterViews,
  unsignedCastType,
  wideParentOf32BitView,
} from '../src/registers';
import { syscallName, SYSCALL_ARGUMENT_REGISTERS } from '../src/syscalls';

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

  it('offers no counter-based rows when the counter register was not read', () => {
    // The flags alone cannot answer them, and a row guessing at rcx would be worse than no row.
    const mnemonics = evaluateJumpConditions(0n).map((c) => c.mnemonics);
    assert.strictEqual(mnemonics.some((m) => m.startsWith('loop') || m === 'jrcxz'), false);
  });

  it('answers jrcxz from the counter register, which reads no flag at all', () => {
    const taken = (value: bigint): boolean =>
      evaluateJumpConditions(0n, { name: 'rcx', value, bits: 64 }).find((c) => c.mnemonics === 'jrcxz')!.taken;
    assert.strictEqual(taken(0n), true);
    assert.strictEqual(taken(1n), false);
  });

  it('names the counter register the way the target spells it', () => {
    const i386 = evaluateJumpConditions(0n, { name: 'ecx', value: 0n, bits: 32 });
    assert.ok(i386.some((c) => c.mnemonics === 'jecxz'), 'a 32-bit target has no jrcxz');
  });

  it('answers loop from the counter *after* its decrement, which is the whole trap', () => {
    // `loop` decrements first and branches while the result is non-zero, so rcx=1 is the last
    // iteration and rcx=2 is not — a reading nothing else on screen performs.
    const loopTaken = (value: bigint): boolean =>
      evaluateJumpConditions(0n, { name: 'rcx', value, bits: 64 }).find((c) => c.mnemonics === 'loop')!.taken;
    assert.strictEqual(loopTaken(2n), true, 'decrements to 1, which is non-zero');
    assert.strictEqual(loopTaken(1n), false, 'decrements to 0, so this is the last iteration');
  });

  it('calls out the zero counter that makes loop run 2^64 times instead of none', () => {
    // The worst outcome this instruction has, reached from the most innocent-looking register
    // value: 0 decrements to all-ones rather than stopping.
    const loop = evaluateJumpConditions(0n, { name: 'rcx', value: 0n, bits: 64 }).find((c) => c.mnemonics === 'loop')!;
    assert.strictEqual(loop.taken, true);
    assert.match(loop.meaning, /2\^64/);
  });

  it('gates loope and loopne on ZF as well as the decremented counter', () => {
    const byMnemonics = (zf: boolean): Map<string, boolean> =>
      new Map(evaluateJumpConditions(zf ? 0x40n : 0n, { name: 'rcx', value: 5n, bits: 64 }).map((c) => [c.mnemonics, c.taken]));
    assert.strictEqual(byMnemonics(true).get('loope / loopz'), true);
    assert.strictEqual(byMnemonics(true).get('loopne / loopnz'), false);
    assert.strictEqual(byMnemonics(false).get('loope / loopz'), false);
    assert.strictEqual(byMnemonics(false).get('loopne / loopnz'), true);
  });
});

describe('changeReportingNames', () => {
  it('maps a displayed vector register onto every raw name gdb reports a change under', () => {
    // gdb answers "-data-list-changed-registers" in terms of raw registers, and the ymm0 this panel
    // displays is a pseudo-register assembled from raw xmm0 and raw ymm0h. Confirmed against gdb
    // 16.3: a "movdqu xmm0, ..." reports register 40 (xmm0) and never the ymm0 pseudo, so matching
    // on the displayed name alone would leave the Vector header claiming nothing had moved.
    const names = changeReportingNames('ymm0');
    assert.ok(names.includes('xmm0'), 'the low half is what a movdqu reports');
    assert.ok(names.includes('ymm0h'), 'the upper half is a raw register of its own');
    assert.ok(names.includes('ymm0'));
  });

  it('covers the AVX-512 halves for a zmm-width target too', () => {
    const names = changeReportingNames('zmm7');
    for (const expected of ['xmm7', 'ymm7', 'zmm7', 'ymm7h', 'zmm7h']) assert.ok(names.includes(expected), expected);
  });

  it('is the identity for every group that already displays raw registers', () => {
    for (const name of ['rax', 'rip', 'eflags', 'cs', 'st0', 'fctrl', 'mxcsr', 'fs_base', 'k1']) {
      assert.deepStrictEqual(changeReportingNames(name), [name]);
    }
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

  it('refuses a mistyped hex literal rather than setting the register to the "0" inside it', () => {
    // "0xzz" contains exactly one number — the leading 0 — and scavenging it would silently zero
    // the register over a typo. Same for any other stray word with a digit in it.
    assert.strictEqual(parseUserNumber('0xzz', 32, 0x2an), undefined);
    assert.strictEqual(parseUserNumber('0xzz', 32), undefined);
    assert.strictEqual(parseUserNumber('eax4', 32, 0x2an), undefined);
    assert.strictEqual(parseUserNumber('take 5', 32, 0x2an), undefined);
  });
});

describe('wideParentOf32BitView', () => {
  it('maps every 32-bit view to the 64-bit register a write to it must zero the upper half of', () => {
    assert.strictEqual(wideParentOf32BitView('eax'), 'rax');
    assert.strictEqual(wideParentOf32BitView('esp'), 'rsp');
    assert.strictEqual(wideParentOf32BitView('r12d'), 'r12');
  });

  it('claims no parent for the widths x86-64 does *not* zero-extend from', () => {
    // "mov al, 1" and "mov ax, 1" leave everything above them untouched; only the 32-bit write is
    // special. Redirecting those to the parent would wipe bits the instruction preserves.
    for (const name of ['al', 'ah', 'ax', 'sil', 'r12b', 'r12w']) {
      assert.strictEqual(wideParentOf32BitView(name), undefined, name);
    }
  });

  it('claims no parent for a register that has none', () => {
    assert.strictEqual(wideParentOf32BitView('rax'), undefined);
    assert.strictEqual(wideParentOf32BitView('eflags'), undefined);
    assert.strictEqual(wideParentOf32BitView('cs'), undefined);
  });
});

describe('gdbRegisterName', () => {
  it('translates the one spelling fasm and gdb disagree on: r8b-r15b vs r8l-r15l', () => {
    // gdb does not reject "$r12b" — it reads it as an invented convenience variable, so a write to
    // it reports success and changes no register at all. See GDB_REGISTER_ALIASES.
    for (const n of [8, 9, 10, 11, 12, 13, 14, 15]) {
      assert.strictEqual(gdbRegisterName(`r${n}b`), `r${n}l`);
    }
  });

  it('leaves every register whose two spellings already agree exactly as written', () => {
    for (const name of ['rax', 'eax', 'ax', 'al', 'ah', 'sil', 'dil', 'bpl', 'spl', 'r12', 'r12d', 'r12w', 'rip', 'eflags', 'cs']) {
      assert.strictEqual(gdbRegisterName(name), name, name);
    }
  });

  it('covers every "b"-suffixed name the width table claims to know', () => {
    // Guards the two tables drifting apart: a name offered for hover/Watch that gdb silently
    // misreads is worse than one that is not offered.
    for (const name of Object.keys(REGISTER_WIDTH_BITS).filter((n) => /^r\d+b$/.test(n))) {
      assert.notStrictEqual(gdbRegisterName(name), name, name);
    }
  });
});

// The two register-name lists a real x86-64 target reports, captured from gdb 16.3 against a
// running process — and captured *twice on purpose*, before and after the process started, because
// they differ. The pre-run list is what gdb knows from the binary's architecture; the post-run list
// is what it knows from the live process's XSAVE state, and only that one has the AVX registers.
// Trimmed to the entries these tests actually exercise, with gdb's empty-string padding kept where
// it sits, since the *index* of a name in this array is the register number gdb answers to.
/** gdb leaves unnamed slots in its register-number space. Only their *count* carries information —
 * an entry's index in this array is the register number gdb answers to — so the runs are written as
 * counts rather than as a hundred-odd empty strings, and the arrays are otherwise verbatim. */
const padding = (count: number): string[] => Array.from({ length: count }, () => '');

// Verbatim, not trimmed. An earlier version of this file kept only the entries the assertions
// mentioned, which quietly weakened the coverage test below into a check against a list no gdb ever
// produces: the real one also reports every sub-register (al, ah, ax, eax, r8l, r8w, r8d, ...) and
// the ymm upper halves as top-level entries of their own. Two things only the real list can catch
// live in here — that a 64-bit target reports "eax" as well as "rax", so slot order rather than
// mere presence is what picks the right one, and that the low byte of r8-r15 is spelled "r8l".
const X86_64_BEFORE_RUN = [
  'rax', 'rbx', 'rcx', 'rdx', 'rsi', 'rdi', 'rbp', 'rsp', 'r8', 'r9', 'r10', 'r11', 'r12', 'r13', 'r14', 'r15',
  'rip', 'eflags', 'cs', 'ss', 'ds', 'es', 'fs', 'gs', 'st0', 'st1', 'st2', 'st3', 'st4', 'st5', 'st6', 'st7',
  'fctrl', 'fstat', 'ftag', 'fiseg', 'fioff', 'foseg', 'fooff', 'fop', 'xmm0', 'xmm1', 'xmm2', 'xmm3', 'xmm4',
  'xmm5', 'xmm6', 'xmm7', 'xmm8', 'xmm9', 'xmm10', 'xmm11', 'xmm12', 'xmm13', 'xmm14', 'xmm15', 'mxcsr',
  ...padding(95), 'fs_base', 'gs_base', 'orig_rax', 'al', 'bl', 'cl', 'dl', 'sil', 'dil', 'bpl', 'spl', 'r8l',
  'r9l', 'r10l', 'r11l', 'r12l', 'r13l', 'r14l', 'r15l', 'ah', 'bh', 'ch', 'dh', 'ax', 'bx', 'cx', 'dx', 'si',
  'di', 'bp', ...padding(1), 'r8w', 'r9w', 'r10w', 'r11w', 'r12w', 'r13w', 'r14w', 'r15w', 'eax', 'ebx', 'ecx',
  'edx', 'esi', 'edi', 'ebp', 'esp', 'r8d', 'r9d', 'r10d', 'r11d', 'r12d', 'r13d', 'r14d', 'r15d',
];

const X86_64_AFTER_RUN = [
  'rax', 'rbx', 'rcx', 'rdx', 'rsi', 'rdi', 'rbp', 'rsp', 'r8', 'r9', 'r10', 'r11', 'r12', 'r13', 'r14', 'r15',
  'rip', 'eflags', 'cs', 'ss', 'ds', 'es', 'fs', 'gs', 'st0', 'st1', 'st2', 'st3', 'st4', 'st5', 'st6', 'st7',
  'fctrl', 'fstat', 'ftag', 'fiseg', 'fioff', 'foseg', 'fooff', 'fop', 'xmm0', 'xmm1', 'xmm2', 'xmm3', 'xmm4',
  'xmm5', 'xmm6', 'xmm7', 'xmm8', 'xmm9', 'xmm10', 'xmm11', 'xmm12', 'xmm13', 'xmm14', 'xmm15', 'mxcsr',
  'ymm0h', 'ymm1h', 'ymm2h', 'ymm3h', 'ymm4h', 'ymm5h', 'ymm6h', 'ymm7h', 'ymm8h', 'ymm9h', 'ymm10h', 'ymm11h',
  'ymm12h', 'ymm13h', 'ymm14h', 'ymm15h', ...padding(78), 'pkru', 'fs_base', 'gs_base', 'orig_rax', 'al', 'bl',
  'cl', 'dl', 'sil', 'dil', 'bpl', 'spl', 'r8l', 'r9l', 'r10l', 'r11l', 'r12l', 'r13l', 'r14l', 'r15l', 'ah',
  'bh', 'ch', 'dh', 'ax', 'bx', 'cx', 'dx', 'si', 'di', 'bp', ...padding(1), 'r8w', 'r9w', 'r10w', 'r11w',
  'r12w', 'r13w', 'r14w', 'r15w', 'eax', 'ebx', 'ecx', 'edx', 'esi', 'edi', 'ebp', 'esp', 'r8d', 'r9d', 'r10d',
  'r11d', 'r12d', 'r13d', 'r14d', 'r15d', 'ymm0', 'ymm1', 'ymm2', 'ymm3', 'ymm4', 'ymm5', 'ymm6', 'ymm7',
  'ymm8', 'ymm9', 'ymm10', 'ymm11', 'ymm12', 'ymm13', 'ymm14', 'ymm15',
];

describe('resolveRegisterGroups — the vector, x87 and thread groups', () => {
  it('picks xmm before the process has started, since gdb reports no ymm registers until then', () => {
    const groups = resolveRegisterGroups(X86_64_BEFORE_RUN);
    assert.strictEqual(groups.vector.length, 16);
    assert.strictEqual(groups.vector[0], 'xmm0');
  });

  it('picks ymm once the process is running and gdb has re-read the CPU\'s actual extensions', () => {
    // The bug this guards is invisible without both fixtures: resolving the register set only at
    // launch is resolving it from the list that has no AVX registers in it at all.
    const groups = resolveRegisterGroups(X86_64_AFTER_RUN);
    assert.strictEqual(groups.vector[0], 'ymm0');
    assert.strictEqual(groups.vector.length, 16);
  });

  it('lists each SIMD register once, at its widest reported name — never xmm0 and ymm0 as two rows', () => {
    const groups = resolveRegisterGroups(X86_64_AFTER_RUN);
    assert.deepStrictEqual(groups.vector.filter((n) => /mm0$/.test(n)), ['ymm0']);
    assert.strictEqual(groups.vector.includes('xmm0'), false);
  });

  it('groups the x87 stack apart from the x87 environment words', () => {
    const groups = resolveRegisterGroups(X86_64_AFTER_RUN);
    assert.deepStrictEqual(groups.x87, ['st0', 'st1', 'st2', 'st3', 'st4', 'st5', 'st6', 'st7']);
    assert.deepStrictEqual(groups.x87Control, ['fctrl', 'fstat', 'ftag', 'fop', 'fiseg', 'fioff', 'foseg', 'fooff']);
    assert.strictEqual(groups.mxcsrName, 'mxcsr');
  });

  it('groups the TLS bases, the syscall number and the protection-key rights together', () => {
    const groups = resolveRegisterGroups(X86_64_AFTER_RUN);
    assert.deepStrictEqual(groups.thread, ['fs_base', 'gs_base', 'orig_rax', 'pkru']);
  });

  it('leaves no register gdb reports out of every group at once', () => {
    // The real gap this guards: pkru was reported by gdb, had a width entry, resolved in hover and
    // Watch — and appeared in no group, so the panel gave a reader no way to discover it exists.
    // Every non-padding name gdb reports for a live x86-64 target has to be reachable from the
    // panel — as a group member, or as a child view of one.
    const groups = resolveRegisterGroups(X86_64_AFTER_RUN);
    const placed = new Set([
      ...groups.generalPurpose, ...groups.pointers, ...groups.segment, ...groups.vector,
      ...groups.x87, ...groups.x87Control, ...groups.mask, ...groups.thread,
      groups.eflagsName, groups.mxcsrName,
    ]);
    // Every name reachable by expanding a placed register rather than as a row of its own. The two
    // kinds are named explicitly rather than skipped by a loose pattern, so that a register gdb
    // starts reporting which is genuinely *not* covered still fails this test.
    const asChildView = (name: string): boolean =>
      // The narrower views of a placed integer register: al/ah/ax/eax under rax, r8l/r8w/r8d under
      // r8 (gdb spells the low byte "r8l"; fasm spells it "r8b" — see gdbRegisterName).
      [...groups.generalPurpose, ...groups.pointers].some((parent) =>
        subRegisterViews(parent, 0n).some((sub) => sub.name === name || gdbRegisterName(sub.name) === name)) ||
      // The halves of a placed vector register: xmm0 is the low 128 bits of the ymm0 that is
      // placed, and ymm0h is the upper half gdb assembles it from.
      groups.vector.some((parent) => changeReportingNames(parent).includes(name));

    const unreachable = X86_64_AFTER_RUN.filter((name) => name.length > 0 && !placed.has(name) && !asChildView(name));
    assert.deepStrictEqual(unreachable, []);
  });

  it('records gdb\'s own register number for each name, counting empty padding slots', () => {
    // st0 sits at index 24 in this list, and "-data-list-register-values x 24" is the only way to
    // ask for its raw 80 bits — no expression form returns them. The rest are here because the
    // padding runs between them are exactly what a hand-trimmed fixture gets wrong: fs_base is the
    // 152nd slot, not the 59th it would be if the empty ones were dropped.
    const groups = resolveRegisterGroups(X86_64_AFTER_RUN);
    assert.strictEqual(groups.numbers.get('st0'), 24);
    assert.strictEqual(groups.numbers.get('mxcsr'), 56);
    assert.strictEqual(groups.numbers.get('pkru'), 151);
    assert.strictEqual(groups.numbers.get('fs_base'), 152);
    assert.strictEqual(groups.numbers.get(''), undefined);
    // Every name resolves back from its number, which is the only form
    // "-data-list-changed-registers" answers in.
    assert.strictEqual(groups.namesByNumber.get(24), 'st0');
    assert.strictEqual(groups.namesByNumber.get(151), 'pkru');
    // Slots 73-150 are the unnamed run between the ymm upper halves and pkru.
    assert.strictEqual(groups.namesByNumber.get(100), undefined, 'a padding slot names no register');
  });

  it('picks the 64-bit name even though the target reports the 32-bit one too', () => {
    // Not hypothetical, and the reason GP_SLOTS is an ordered candidate list rather than a set: a
    // real x86-64 gdb reports "eax" and "rax" both, as separate top-level entries. Matching on mere
    // presence would make which one appears depend on gdb's own array order.
    assert.strictEqual(X86_64_AFTER_RUN.includes('eax'), true, 'fixture must keep the 32-bit pseudo-registers');
    const groups = resolveRegisterGroups(X86_64_AFTER_RUN);
    assert.deepStrictEqual(groups.generalPurpose.slice(0, 4), ['rax', 'rbx', 'rcx', 'rdx']);
    assert.deepStrictEqual(groups.pointers, ['rbp', 'rsp', 'rip']);
    assert.strictEqual(groups.generalPurpose.includes('eax'), false);
  });

  it('gives a 32-bit target its xmm registers and its x87 stack too', () => {
    const groups = resolveRegisterGroups(I386_REGISTER_NAMES);
    assert.deepStrictEqual(groups.vector, ['xmm0', 'xmm1', 'xmm2', 'xmm3', 'xmm4', 'xmm5', 'xmm6', 'xmm7']);
    assert.strictEqual(groups.x87.length, 8);
    assert.strictEqual(groups.mxcsrName, 'mxcsr');
    // No fs_base/gs_base/orig_rax on i386 — the group simply does not appear.
    assert.deepStrictEqual(groups.thread, []);
  });
});

describe('reserved mnemonics vs gdb\'s own pseudo-registers', () => {
  it('treats every name fasm reserves as a register that outranks a program symbol', () => {
    for (const name of ['rax', 'al', 'xmm0', 'ymm15', 'zmm31', 'st0', 'st7', 'k1', 'eflags']) {
      assert.strictEqual(isReservedRegisterMnemonic(name), true, name);
    }
  });

  it('does not reserve the names gdb adds on top of the ISA — a program may legitimately define one', () => {
    // This is the whole reason the two maps are separate: `orig_rax` is a perfectly legal label
    // name in fasm, and resolving it as a register ahead of the program's own symbols would
    // describe the wrong thing entirely.
    for (const name of ['fs_base', 'gs_base', 'orig_rax', 'mxcsr', 'fctrl', 'pkru']) {
      assert.strictEqual(isReservedRegisterMnemonic(name), false, name);
      assert.notStrictEqual(PSEUDO_REGISTER_WIDTH_BITS[name], undefined, name);
    }
  });

  it('still knows the width of a pseudo-register, for the panel rows that do display one', () => {
    assert.strictEqual(registerWidthBits('fs_base'), 64);
    assert.strictEqual(registerWidthBits('mxcsr'), 32);
    assert.strictEqual(registerWidthBits('fctrl'), 16);
    assert.strictEqual(registerWidthBits('rax'), 64);
    assert.strictEqual(registerWidthBits('nonsense'), undefined);
  });

  it('gives the SIMD registers widths outside RegisterBits, since no unsigned cast names one', () => {
    assert.strictEqual(VECTOR_WIDTH_BITS.xmm0, 128);
    assert.strictEqual(VECTOR_WIDTH_BITS.ymm0, 256);
    assert.strictEqual(VECTOR_WIDTH_BITS.zmm0, 512);
    assert.strictEqual(REGISTER_WIDTH_BITS.xmm0, undefined);
  });
});

describe('decodeMxcsr', () => {
  it('reads the power-on default (0x1f80) as every exception masked and nothing raised', () => {
    // Cross-checked against gdb's own rendering of the same register, which prints exactly this
    // set of names for a freshly started process.
    assert.strictEqual(formatBitFieldSummary(decodeMxcsr(0x1f80n)), '[ IM DM ZM OM UM PM ]');
  });

  it('surfaces a sticky exception flag, which is the reason to look at this register at all', () => {
    const fields = new Map(decodeMxcsr(0x1f85n).map((f) => [f.name, f.value]));
    assert.strictEqual(fields.get('IE'), 1); // invalid operation
    assert.strictEqual(fields.get('ZE'), 1); // divide by zero
    assert.strictEqual(fields.get('DE'), 0);
  });

  it('names the rounding mode rather than leaving RC as a number', () => {
    const rc = decodeMxcsr(0x7f80n).find((f) => f.name === 'RC')!;
    assert.strictEqual(rc.value, 3);
    assert.strictEqual(rc.meaning, 'toward zero (truncate)');
  });

  it('reads FZ and DAZ, the two bits that silently change what float arithmetic means', () => {
    const fields = new Map(decodeMxcsr(0x9f40n).map((f) => [f.name, f.value]));
    assert.strictEqual(fields.get('FZ'), 1);
    assert.strictEqual(fields.get('DAZ'), 1);
  });
});

describe('decodeX87Control / decodeX87Status / decodeX87Tags', () => {
  it('reads the x87 control word default (0x37f) as extended precision, round to nearest', () => {
    const fields = new Map(decodeX87Control(0x37fn).map((f) => [f.name, f]));
    assert.strictEqual(fields.get('PC')!.value, 3);
    assert.strictEqual(fields.get('PC')!.meaning, 'extended (64-bit mantissa — the default)');
    assert.strictEqual(fields.get('RC')!.value, 0);
    assert.strictEqual(fields.get('IM')!.value, 1);
  });

  it('reads TOP out of the status word — which physical register st0 currently names', () => {
    // 0x3000 is TOP = 6, the value a real program shows after two pushes onto an empty stack
    // (verified live against gdb with two flds outstanding).
    const top = decodeX87Status(0x3000n).find((f) => f.name === 'TOP')!;
    assert.strictEqual(top.value, 6);
  });

  it('reads the comparison result out of C0/C2/C3 rather than EFLAGS, where x87 does not put it', () => {
    const fields = new Map(decodeX87Status(0x4000n).map((f) => [f.name, f.value]));
    assert.strictEqual(fields.get('C3'), 1); // "equal"
    assert.strictEqual(fields.get('C0'), 0);
    assert.strictEqual(fields.get('C2'), 0); // ordered — no NaN involved
  });

  it('flags a stack fault, and the direction C1 gives it', () => {
    const fields = new Map(decodeX87Status(0x241n).map((f) => [f.name, f.value]));
    assert.strictEqual(fields.get('SF'), 1);
    assert.strictEqual(fields.get('IE'), 1);
    assert.strictEqual(fields.get('C1'), 1); // overflow rather than underflow
  });

  it('reads all eight tag states out of the tag word, two bits each', () => {
    // 0xfff is what a program with two values pushed actually reports: R0-R5 empty, R6/R7 valid
    // (verified live — R6 and R7 are the two the pushes landed in, with TOP at 6).
    const tags = decodeX87Tags(0xfffn);
    assert.strictEqual(tags.length, 8);
    assert.strictEqual(tags[0].state, 'empty');
    assert.strictEqual(tags[5].state, 'empty');
    assert.strictEqual(tags[6].state, 'valid');
    assert.strictEqual(tags[7].state, 'valid');
  });

  it('reads an all-empty tag word (0xffff), the state a program starts in', () => {
    assert.ok(decodeX87Tags(0xffffn).every((t) => t.state === 'empty'));
  });
});

describe('formatBitFieldSummary', () => {
  it('names a set one-bit flag, but shows a multi-bit field\'s value', () => {
    // "[ TOP ]" would say the field is set when what it holds is which register st0 is.
    assert.strictEqual(formatBitFieldSummary(decodeX87Status(0x3000n)), '[ TOP=6 ]');
  });

  it('says so plainly when nothing is set', () => {
    assert.strictEqual(formatBitFieldSummary(decodeMxcsr(0n)), '[ ]');
  });
});

describe('decodeSegmentSelector / formatSegmentSelector', () => {
  it('reads the ordinary 64-bit user code selector (0x33) as GDT entry 6, ring 3', () => {
    // The value every x86-64 Linux user process actually has in cs, and as plain hex it says
    // nothing at all — which is the entire reason this decoding exists.
    assert.deepStrictEqual(decodeSegmentSelector(0x33n), { index: 6, table: 'GDT', rpl: 3 });
    assert.strictEqual(formatSegmentSelector(0x33n), 'GDT[6] ring 3');
  });

  it('reads the matching stack selector (0x2b) as GDT entry 5, ring 3', () => {
    assert.strictEqual(formatSegmentSelector(0x2bn), 'GDT[5] ring 3');
  });

  it('reads the LDT bit', () => {
    assert.deepStrictEqual(decodeSegmentSelector(0x37n), { index: 6, table: 'LDT', rpl: 3 });
  });

  it('calls a null selector what it is instead of reading off three zero fields', () => {
    assert.strictEqual(formatSegmentSelector(0n), 'null selector (unused)');
  });
});

describe('formatMaskRegister / popCount', () => {
  it('reads a mask in binary, where a lane index can be counted off directly', () => {
    // The whole reason a k register does not lead with hex like every other integer register: its
    // value is positional, and "0xff" makes the reader do the expansion in their head.
    assert.strictEqual(formatMaskRegister(0xffn), '0b1111_1111  8 lanes');
  });

  it('names one set lane in the singular', () => {
    assert.strictEqual(formatMaskRegister(1n), '0b0001  1 lane');
  });

  it('calls an all-zero mask what it is rather than printing 64 zeroes', () => {
    assert.strictEqual(formatMaskRegister(0n), '0b0  no lanes');
  });

  it('shows only as many nibbles as the highest set bit needs', () => {
    // A mask that writes lanes 0 and 9 of a 64-lane operation: three nibbles, not sixteen.
    assert.strictEqual(formatMaskRegister(0x201n), '0b0010_0000_0001  2 lanes');
  });

  it('counts the lanes of a full 64-bit mask', () => {
    assert.strictEqual(popCount((1n << 64n) - 1n), 64);
    assert.strictEqual(popCount(0n), 0);
  });
});

describe('formatPkru', () => {
  it('says nothing is restricted for the value every ordinary program has', () => {
    assert.strictEqual(formatPkru(0n), 'all 16 keys unrestricted');
  });

  it('reads the access-disable and write-disable bits of a key apart', () => {
    assert.strictEqual(formatPkru(0b01n), 'key0 no access');
    assert.strictEqual(formatPkru(0b10n), 'key0 read-only');
    // AD set makes WD moot — no access already covers no write.
    assert.strictEqual(formatPkru(0b11n), 'key0 no access');
  });

  it('names the key a restriction belongs to', () => {
    assert.strictEqual(formatPkru(1n << 6n), 'key3 no access');
    assert.strictEqual(formatPkru((1n << 6n) | (1n << 31n)), 'key3 no access, key15 read-only');
  });

  it('inverts the list for the value a Linux process actually starts with', () => {
    // 0x55555554 is the kernel's own init_pkru: key 0 usable, every other key access-disabled.
    // Read the obvious way round this is a fifteen-item list that buries its only fact.
    assert.strictEqual(formatPkru(0x55555554n), 'key0 unrestricted, 15 restricted');
  });

  it('says so when every key is restricted, rather than naming an empty set', () => {
    assert.strictEqual(formatPkru(0x55555555n), 'no keys unrestricted, 16 restricted');
  });
});

describe('formatChangedSummary', () => {
  it('says nothing at all when nothing moved', () => {
    assert.strictEqual(formatChangedSummary([]), '');
  });

  it('lists the registers that moved', () => {
    assert.strictEqual(formatChangedSummary(['rax', 'rcx']), 'changed: rax, rcx');
  });

  it('stops listing and starts counting once a call has touched half the register file', () => {
    assert.strictEqual(
      formatChangedSummary(['rax', 'rbx', 'rcx', 'rdx', 'rsi', 'rdi', 'r8', 'r9']),
      'changed: rax, rbx, rcx, rdx, rsi, rdi, +2 more',
    );
  });
});

describe('formatRegisterDelta', () => {
  it('reads a push as the -8 it is, not as an unsigned wrap', () => {
    // The case that motivates a signed delta at all: rsp moving down wraps past zero if the
    // subtraction is done unsigned, and "+18446744073709551608" is not what a push did.
    assert.strictEqual(formatRegisterDelta(64, 0x7fffffffd198n, 0x7fffffffd190n), '0x00007fffffffd198  (-8 = -0x8)');
  });

  it('reads a prologue reserving stack space', () => {
    assert.strictEqual(formatRegisterDelta(64, 0x1000n, 0xfd8n), '0x0000000000001000  (-40 = -0x28)');
  });

  it('reads an increment forwards', () => {
    assert.strictEqual(formatRegisterDelta(64, 0n, 42n), '0x0000000000000000  (+42 = +0x2a)');
  });

  it('handles a 32-bit register wrapping past zero', () => {
    // "dec eax" at zero: down by one, not up by 4294967295.
    assert.strictEqual(formatRegisterDelta(32, 0n, 0xffffffffn), '0x00000000  (-1 = -0x1)');
  });
});

describe('vector lane readings', () => {
  it('reads a packed pair of doubles — the reading an addpd/mulpd operates on', () => {
    // 1.5 and -2.25, laid out the way "dq 1.5, -2.25" puts them in memory: lane 0 in the low bits.
    const value = (0xc002000000000000n << 64n) | 0x3ff8000000000000n;
    const doubles = vectorLaneGroups(128, value).find((g) => g.kind === 'float64')!;
    assert.strictEqual(doubles.label, '2 x double');
    assert.deepStrictEqual(doubles.lanes, ['1.5', '-2.25']);
  });

  it('reads the same bits as four floats, sixteen bytes, and every width between', () => {
    const value = (0xc002000000000000n << 64n) | 0x3ff8000000000000n;
    const kinds = vectorLaneGroups(128, value).map((g) => g.label);
    assert.deepStrictEqual(kinds, ['2 x double', '4 x float', '2 x qword', '4 x dword', '8 x word', '16 x byte']);
    assert.strictEqual(vectorLaneGroups(128, value).find((g) => g.kind === 'int8')!.lanes.length, 16);
  });

  it('scales the lane count with the register width', () => {
    assert.strictEqual(vectorLaneGroups(256, 0n).find((g) => g.kind === 'float64')!.lanes.length, 4);
    assert.strictEqual(vectorLaneGroups(512, 0n).find((g) => g.kind === 'int8')!.lanes.length, 64);
  });

  it('numbers lanes from the low-order end, the end every SIMD instruction numbers from', () => {
    const qwords = vectorLaneGroups(128, (0xaaaan << 64n) | 0xbbbbn).find((g) => g.kind === 'int64')!;
    assert.deepStrictEqual(qwords.lanes, ['0xbbbb', '0xaaaa']);
  });

  it('offers the narrower aliases of a wide register, the way al/ax sit under rax', () => {
    const views = vectorSubRegisterViews('zmm3', (1n << 200n) | 0x42n);
    assert.deepStrictEqual(views.map((v) => v.name), ['ymm3', 'xmm3']);
    assert.strictEqual(views[1].bits, 128);
    assert.strictEqual(views[1].value, 0x42n);
  });

  it('has no narrower alias to offer for an xmm register, which is already the narrowest', () => {
    assert.deepStrictEqual(vectorSubRegisterViews('xmm3', 1n), []);
  });

  it('shows an untouched vector register as three characters, not sixty-four zeros', () => {
    assert.strictEqual(formatVectorValueCompact(256, 0n), '0x0');
  });

  it('reads a register loaded with text as text — what movdqu over a string leaves behind', () => {
    // "SIMD/x86-64!!!!!" loaded by a movdqu, exactly as a live run produces it.
    const value = 0x212121212134362d3638782f444d4953n;
    assert.strictEqual(formatVectorValueCompact(128, value), `0x${value.toString(16)}  'SIMD/x86-64!!!!!'`);
  });
});

describe('float32FromBits / float64FromBits', () => {
  it('decodes the IEEE-754 bit patterns without asking gdb for a second opinion', () => {
    assert.strictEqual(float64FromBits(0x3ff8000000000000n), 1.5);
    assert.strictEqual(float64FromBits(0xc002000000000000n), -2.25);
    assert.strictEqual(float32FromBits(0x3fc00000n), 1.5);
  });

  it('decodes the values no numeric reading of the hex would reveal', () => {
    assert.ok(Number.isNaN(float64FromBits(0x7ff8000000000000n)));
    assert.strictEqual(float64FromBits(0x7ff0000000000000n), Infinity);
    assert.ok(Object.is(float64FromBits(0x8000000000000000n), -0));
  });
});

describe('decodeExtendedFloat', () => {
  // Every bit pattern below was read back out of a real x87 register with gdb 16.3 after setting
  // the register to the stated value — not derived from the format description.
  it('takes apart the 80 bits gdb reports for a normal value', () => {
    const d = decodeExtendedFloat(0x3fff8000000000000000n); // 1.0
    assert.strictEqual(d.classification, 'normal');
    assert.strictEqual(d.negative, false);
    assert.strictEqual(d.exponent, 0);
    assert.strictEqual(d.integerBit, true);
    assert.strictEqual(d.significand, 0x8000000000000000n);
  });

  it('reads the sign and scale of a negative value', () => {
    const d = decodeExtendedFloat(0xbfffc000000000000000n); // -1.5
    assert.strictEqual(d.classification, 'normal');
    assert.strictEqual(d.negative, true);
    assert.strictEqual(d.exponent, 0);
  });

  it('reads a value scaled above 1', () => {
    const d = decodeExtendedFloat(0x4000c8f5c28f5c28f800n); // 3.14
    assert.strictEqual(d.exponent, 1);
    assert.strictEqual(d.significand, 0xc8f5c28f5c28f800n);
  });

  it('classifies zero, infinity and both kinds of NaN', () => {
    assert.strictEqual(decodeExtendedFloat(0n).classification, 'zero');
    assert.strictEqual(decodeExtendedFloat(0x7fff8000000000000000n).classification, 'infinity');
    assert.strictEqual(decodeExtendedFloat(0x7fffc000000000000000n).classification, 'quiet NaN');
    assert.strictEqual(decodeExtendedFloat(0x7fffa000000000000000n).classification, 'signaling NaN');
  });

  it('classifies an unnormal as unsupported — a value no FPU since the 387 can produce', () => {
    // Integer bit clear at a non-zero exponent. Seeing one means something wrote raw bytes over
    // the x87 state, and no decimal reading of the register would ever say so.
    assert.strictEqual(decodeExtendedFloat(0x40004000000000000000n).classification, 'unsupported');
    assert.strictEqual(decodeExtendedFloat(0x7fff4000000000000000n).classification, 'unsupported');
  });

  it('classifies a denormal without calling it unsupported — it has a well-defined value', () => {
    assert.strictEqual(decodeExtendedFloat(0x00000000000000000001n).classification, 'denormal');
  });

  it('summarises the structure on one line, without recomputing a decimal it cannot hold exactly', () => {
    assert.strictEqual(formatExtendedFloat(0xbfffc000000000000000n), 'normal  sign -  exp 2^0  significand 0xc000000000000000');
    assert.strictEqual(formatExtendedFloat(0n), 'zero  significand 0x0000000000000000');
  });
});

describe('syscallName', () => {
  it('names the x86-64 calls a fasm program actually makes', () => {
    assert.strictEqual(syscallName('x86_64', 0n), 'read');
    assert.strictEqual(syscallName('x86_64', 1n), 'write');
    assert.strictEqual(syscallName('x86_64', 59n), 'execve');
    assert.strictEqual(syscallName('x86_64', 60n), 'exit');
  });

  it('uses a genuinely different table for i386, where the same numbers mean other calls', () => {
    // The failure this prevents is silent: picking the wrong table names the wrong syscall rather
    // than failing to name one.
    assert.strictEqual(syscallName('i386', 1n), 'exit');
    assert.strictEqual(syscallName('i386', 4n), 'write');
    assert.notStrictEqual(syscallName('i386', 60n), syscallName('x86_64', 60n));
  });

  it('names nothing for the -1 Linux reports when the program is not in a syscall', () => {
    assert.strictEqual(syscallName('x86_64', 0xffffffffffffffffn), undefined);
    assert.strictEqual(syscallName('x86_64', -1n), undefined);
  });

  it('names nothing for a number past the end of the table rather than inventing a call', () => {
    assert.strictEqual(syscallName('x86_64', 9999n), undefined);
  });

  it('records that the fourth syscall argument is r10, not rcx', () => {
    // The classic silent bug: rcx is overwritten by the syscall instruction itself, so code that
    // passes argument four there assembles fine and passes garbage.
    assert.strictEqual(SYSCALL_ARGUMENT_REGISTERS.x86_64[3], 'r10');
    assert.strictEqual(SYSCALL_ARGUMENT_REGISTERS.i386[3], 'esi');
  });
});
