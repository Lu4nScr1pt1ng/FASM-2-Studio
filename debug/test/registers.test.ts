import * as assert from 'assert';
import { decodeEflags, EFLAGS_BITS, formatRegisterValue, parseUserNumber, REGISTER_WIDTH_BITS, resolveRegisterGroups, unsignedCastType } from '../src/registers';

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

describe('formatRegisterValue', () => {
  it('renders hex/decimal/binary from the same value, so they can never disagree', () => {
    const text = formatRegisterValue('eax', 32, 0xffffffffn);
    assert.strictEqual(text, 'eax = 0xffffffff  4294967295  0b1111_1111_1111_1111_1111_1111_1111_1111');
  });

  it('pads hex/binary to the full register width even for a small value', () => {
    const text = formatRegisterValue('al', 8, 1n);
    assert.strictEqual(text, 'al = 0x01  1  0b0000_0001');
  });

  it('formats correctly at 16-bit width too (segment registers, ax/bx/.../sp)', () => {
    const text = formatRegisterValue('cs', 16, 0x23n);
    assert.strictEqual(text, 'cs = 0x0023  35  0b0000_0000_0010_0011');
  });

  it('never truncates or misaligns hex/binary at the maximum 8-bit value (0xff)', () => {
    const text = formatRegisterValue('bl', 8, 0xffn);
    assert.strictEqual(text, 'bl = 0xff  255  0b1111_1111');
  });

  it('never truncates or misaligns hex/binary at the maximum 16-bit value (0xffff)', () => {
    const text = formatRegisterValue('ax', 16, 0xffffn);
    assert.strictEqual(text, 'ax = 0xffff  65535  0b1111_1111_1111_1111');
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

  it('falls back to pulling a leading 0x... out of a pasted display string (re-submitting an unedited value is a no-op)', () => {
    assert.strictEqual(parseUserNumber('eax = 0x0000002a  42  0b0000...', 32), 0x2an);
  });

  it('returns undefined for genuinely unparseable input', () => {
    assert.strictEqual(parseUserNumber('not a number', 32), undefined);
  });
});
