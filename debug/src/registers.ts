// Pure register-metadata logic: bit widths, grouping into display categories, and EFLAGS-bit
// decoding. Deliberately architecture-agnostic — resolveRegisterGroups() only ever picks from
// whatever register names gdb itself reports for the *actual connected target* (via its
// "-data-list-register-names" MI command, called once in session.ts right after gdb loads the
// program). This matters because gdb reports a completely different register set for a 32-bit
// (i386) target than a 64-bit (x86-64) one — "eax"/"ebx"/... vs "rax"/"rbx"/..., no "r8"-"r15",
// no "rip" (just "eip") — and a debugger that hardcodes the 64-bit names will find *none* of them
// on a 32-bit target, reading back as a wall of "<unavailable>" for every single register (a real
// bug this replaces: fixed in the 0.16.0 pass after a user hit it debugging a
// "format ELF executable 3" — EM_386 — 32-bit program).
//
// Confirmed empirically against real gdb (16.3) MI output for both a 32-bit and 64-bit fasm2 ELF
// binary — see debug/test/registers.test.ts — rather than assumed from documentation alone:
// i386:   eax,ecx,edx,ebx,esp,ebp,esi,edi,eip,eflags,cs,ss,ds,es,fs,gs,st0..st7,...
// x86-64: rax,rbx,rcx,rdx,rsi,rdi,rbp,rsp,r8..r15,rip,eflags,cs,ss,ds,es,fs,gs,st0..st7,...
// Note gdb's own array order differs between the two (i386 groups eax/ecx/edx/ebx together;
// x86-64 groups rax/rbx/rcx/rdx) — GP_SLOTS below imposes one fixed, assembly-reading-order
// sequence regardless of architecture, so the two look the same shape in the UI.

export type RegisterBits = 8 | 16 | 32 | 64;

/** Every x86/x86-64 register name gdb might report as a `$`-prefixed convenience register,
 * mapped to its bit width — covers whatever mnemonic a hover in real assembly source might land
 * on, not just the curated set the Registers scope groups below display. */
export const REGISTER_WIDTH_BITS: Record<string, RegisterBits> = {
  rax: 64, rbx: 64, rcx: 64, rdx: 64, rsi: 64, rdi: 64, rbp: 64, rsp: 64, rip: 64,
  r8: 64, r9: 64, r10: 64, r11: 64, r12: 64, r13: 64, r14: 64, r15: 64,
  eax: 32, ebx: 32, ecx: 32, edx: 32, esi: 32, edi: 32, ebp: 32, esp: 32, eip: 32, eflags: 32,
  r8d: 32, r9d: 32, r10d: 32, r11d: 32, r12d: 32, r13d: 32, r14d: 32, r15d: 32,
  ax: 16, bx: 16, cx: 16, dx: 16, si: 16, di: 16, bp: 16, sp: 16,
  r8w: 16, r9w: 16, r10w: 16, r11w: 16, r12w: 16, r13w: 16, r14w: 16, r15w: 16,
  cs: 16, ss: 16, ds: 16, es: 16, fs: 16, gs: 16,
  al: 8, bl: 8, cl: 8, dl: 8, ah: 8, bh: 8, ch: 8, dh: 8, sil: 8, dil: 8, bpl: 8, spl: 8,
  r8b: 8, r9b: 8, r10b: 8, r11b: 8, r12b: 8, r13b: 8, r14b: 8, r15b: 8,
};

/** The narrower views of one wide register, widest first — "what does al hold right now" is a
 * question asked constantly while reading assembly, and the answer is always already inside the
 * value the wide register was read as, so it never costs another gdb round-trip. `shift` is the
 * bit offset of the view within its parent: 8 for the legacy high-byte names (ah/bh/ch/dh),
 * 0 for everything else. */
export interface SubRegisterView {
  name: string;
  bits: RegisterBits;
  shift: number;
}

// Keyed by the *widest* name; a 32-bit target's own "eax" entry is listed separately rather than
// derived, since on i386 there is no rax for eax to be a view of.
const SUB_REGISTER_NAMES: Record<string, string[]> = {
  rax: ['eax', 'ax', 'al', 'ah'], rbx: ['ebx', 'bx', 'bl', 'bh'],
  rcx: ['ecx', 'cx', 'cl', 'ch'], rdx: ['edx', 'dx', 'dl', 'dh'],
  rsi: ['esi', 'si', 'sil'], rdi: ['edi', 'di', 'dil'],
  rbp: ['ebp', 'bp', 'bpl'], rsp: ['esp', 'sp', 'spl'],
  eax: ['ax', 'al', 'ah'], ebx: ['bx', 'bl', 'bh'], ecx: ['cx', 'cl', 'ch'], edx: ['dx', 'dl', 'dh'],
  esi: ['si', 'sil'], edi: ['di', 'dil'], ebp: ['bp', 'bpl'], esp: ['sp', 'spl'],
  r8: ['r8d', 'r8w', 'r8b'], r9: ['r9d', 'r9w', 'r9b'], r10: ['r10d', 'r10w', 'r10b'], r11: ['r11d', 'r11w', 'r11b'],
  r12: ['r12d', 'r12w', 'r12b'], r13: ['r13d', 'r13w', 'r13b'], r14: ['r14d', 'r14w', 'r14b'], r15: ['r15d', 'r15w', 'r15b'],
};

/** The narrower registers that alias part of `name`, each with the slice of `value` it holds.
 * Empty for a register with no narrower name (rip/eip, the segment registers, eflags). */
export function subRegisterViews(name: string, value: bigint): Array<SubRegisterView & { value: bigint }> {
  return (SUB_REGISTER_NAMES[name] ?? []).map((sub) => {
    const bits = REGISTER_WIDTH_BITS[sub];
    const shift = sub.endsWith('h') && sub.length === 2 ? 8 : 0;
    return { name: sub, bits, shift, value: (value >> BigInt(shift)) & ((1n << BigInt(bits)) - 1n) };
  });
}

export interface RegisterGroups {
  /** eax/ebx/ecx/edx/esi/edi (or rax/rbx/.../r15 on 64-bit) — the general-purpose data registers. */
  generalPurpose: string[];
  /** ebp/esp/eip (or rbp/rsp/rip) — the "where in memory/code am I" registers, kept apart from
   * the general-purpose set since they're conventionally read differently (addresses, not data). */
  pointers: string[];
  /** cs/ss/ds/es/fs/gs, whichever the target actually exposes. */
  segment: string[];
  /** "eflags" itself, if the target reports it (true for every real x86/x86-64 target). */
  eflagsName: string | undefined;
}

// Each "slot" is a list of name candidates for one logical register, in priority order — a target
// reports at most one of them (e.g. a 32-bit target has "eax" but never "rax"), so the first match
// found in the target's own reported name set wins. Order here is the fixed *display* order,
// independent of whatever order gdb's own register-names array happens to list them in.
const GP_SLOTS: string[][] = [
  ['rax', 'eax'], ['rbx', 'ebx'], ['rcx', 'ecx'], ['rdx', 'edx'], ['rsi', 'esi'], ['rdi', 'edi'],
  ['r8'], ['r9'], ['r10'], ['r11'], ['r12'], ['r13'], ['r14'], ['r15'],
];
const POINTER_SLOTS: string[][] = [['rbp', 'ebp'], ['rsp', 'esp'], ['rip', 'eip']];
const SEGMENT_SLOTS: string[][] = [['cs'], ['ss'], ['ds'], ['es'], ['fs'], ['gs']];

function pickAvailable(slots: string[][], available: ReadonlySet<string>): string[] {
  const picked: string[] = [];
  for (const slot of slots) {
    const found = slot.find((name) => available.has(name));
    if (found) picked.push(found);
  }
  return picked;
}

/** `registerNames` is gdb's own raw "-data-list-register-names" result — includes empty-string
 * placeholder entries for unused register numbers on some architectures, which are simply
 * ignored here (never a valid register name to match against). */
export function resolveRegisterGroups(registerNames: readonly string[]): RegisterGroups {
  const available = new Set(registerNames.map((n) => n.toLowerCase()).filter((n) => n.length > 0));
  return {
    generalPurpose: pickAvailable(GP_SLOTS, available),
    pointers: pickAvailable(POINTER_SLOTS, available),
    segment: pickAvailable(SEGMENT_SLOTS, available),
    eflagsName: available.has('eflags') ? 'eflags' : undefined,
  };
}

export interface EflagsBitInfo {
  name: string;
  bit: number;
  /** 1 for an ordinary single-bit flag; 2 for the one multi-bit field, IOPL. */
  width: 1 | 2;
  description: string;
}

/** The standard x86/x86-64 EFLAGS/RFLAGS bit layout (identical in the low 32 bits of both) —
 * every documented bit, not just the handful an assembly programmer checks daily, since the
 * point of this view is to show *everything* rather than a curated guess at what matters. */
export const EFLAGS_BITS: EflagsBitInfo[] = [
  { name: 'CF', bit: 0, width: 1, description: 'Carry Flag — set when an arithmetic op carried/borrowed out of the top bit.' },
  { name: 'PF', bit: 2, width: 1, description: 'Parity Flag — set when the low byte of the result has an even number of set bits.' },
  { name: 'AF', bit: 4, width: 1, description: 'Auxiliary Carry Flag — set on a carry/borrow out of bit 3 (used by BCD arithmetic).' },
  { name: 'ZF', bit: 6, width: 1, description: 'Zero Flag — set when the result was zero.' },
  { name: 'SF', bit: 7, width: 1, description: "Sign Flag — copy of the result's most significant bit (1 = negative in two's complement)." },
  { name: 'TF', bit: 8, width: 1, description: 'Trap Flag — enables single-step (one instruction at a time) debugging mode.' },
  { name: 'IF', bit: 9, width: 1, description: 'Interrupt Enable Flag — set when maskable hardware interrupts are allowed.' },
  { name: 'DF', bit: 10, width: 1, description: 'Direction Flag — string instructions (movs/cmps/...) increment when clear, decrement when set.' },
  { name: 'OF', bit: 11, width: 1, description: 'Overflow Flag — set when a *signed* arithmetic op overflowed (distinct from CF, which tracks unsigned overflow).' },
  { name: 'IOPL', bit: 12, width: 2, description: "I/O Privilege Level — the minimum privilege ring allowed to execute I/O instructions (0-3, protected/long mode only)." },
  { name: 'NT', bit: 14, width: 1, description: 'Nested Task — set when the current task was entered via a CALL/interrupt from another task (affects IRET).' },
  { name: 'RF', bit: 16, width: 1, description: 'Resume Flag — temporarily suppresses debug-exception traps, used to resume execution after hitting a breakpoint.' },
  { name: 'VM', bit: 17, width: 1, description: 'Virtual-8086 Mode — set while running as a virtual 8086 task inside protected mode.' },
  { name: 'AC', bit: 18, width: 1, description: 'Alignment Check — enables faulting on unaligned memory references (also needs the AM bit in CR0).' },
  { name: 'VIF', bit: 19, width: 1, description: 'Virtual Interrupt Flag — a virtualized copy of IF, used by virtual-8086/protected-mode extensions.' },
  { name: 'VIP', bit: 20, width: 1, description: 'Virtual Interrupt Pending — set to indicate a virtual interrupt is waiting to be delivered.' },
  { name: 'ID', bit: 21, width: 1, description: 'ID Flag — software toggles this to test whether the CPU supports the CPUID instruction.' },
];

export interface DecodedEflagsBit {
  name: string;
  value: number;
  description: string;
}

export function decodeEflags(value: bigint): DecodedEflagsBit[] {
  return EFLAGS_BITS.map((f) => {
    const mask = (1n << BigInt(f.width)) - 1n;
    const bits = Number((value >> BigInt(f.bit)) & mask);
    return { name: f.name, value: bits, description: f.description };
  });
}

const UNSIGNED_CAST_TYPE: Record<RegisterBits, string> = {
  8: 'unsigned char',
  16: 'unsigned short',
  32: 'unsigned int',
  64: 'unsigned long',
};

export function unsignedCastType(bits: RegisterBits): string {
  return UNSIGNED_CAST_TYPE[bits];
}

/**
 * Above this magnitude a decimal reading stops being information and becomes noise: nobody reads
 * "140737488346304" as an address, and nothing useful is lost by leaving a value that large as hex
 * alone. Applied to *both* readings independently, which is what makes the common cases come out
 * right — a 64-bit register holding -1 shows "-1" and drops the 20-digit unsigned reading, while a
 * 64-bit register holding a stack pointer shows neither and stays pure hex.
 */
const DECIMAL_READABLE_LIMIT = 1n << 32n;

export interface CompactValueOptions {
  /** Show a quoted rendering when every byte of the value is printable text — the packed-character
   * literals ("mov eax, 'PATH'") that only assembly really has, unreadable as hex or decimal. */
  ascii?: boolean;
  /** Appended after an arrow: what the value points at, when it lands inside a known source label
   * (see session.ts's describeAddress). */
  pointsTo?: string;
}

/** Extracts `value` as its individual bytes, least-significant first — the order they actually sit
 * in memory on x86, and (because fasm packs a character literal with its first character in the
 * lowest byte) also the order the characters of a packed string literal appear in. */
export function valueBytesLittleEndian(bits: RegisterBits, value: bigint): number[] {
  const bytes: number[] = [];
  for (let i = 0; i < bits / 8; i++) bytes.push(Number((value >> BigInt(i * 8)) & 0xffn));
  return bytes;
}

/** The value read as packed text, or undefined when it isn't plausibly text at all. Trailing zero
 * bytes are dropped (an unfilled register holding a short literal), but an *interior* zero, any
 * non-printable byte, or fewer than two characters left over all disqualify it — one stray
 * printable byte is just a small number, and calling it text would mislead far more often than it
 * would help. */
export function packedAsciiText(bits: RegisterBits, value: bigint): string | undefined {
  const bytes = valueBytesLittleEndian(bits, value);
  while (bytes.length > 0 && bytes[bytes.length - 1] === 0) bytes.pop();
  if (bytes.length < 2 || bytes.some((b) => b < 0x20 || b > 0x7e)) return undefined;
  return bytes.map((b) => (b === 0x27 || b === 0x5c ? `\\${String.fromCharCode(b)}` : String.fromCharCode(b))).join('');
}

/**
 * The value as one short line, for a UI row that already shows the register's name in its own
 * column — everything the old three-column "name = hex  decimal  binary" form said, minus what it
 * was saying twice.
 *
 * The redundancy that form carried was real and worth naming: the name repeated the row's own name
 * column; the padded hex spent sixteen characters saying "zero"; and the full binary expansion
 * (79 characters at 64 bits) pushed everything actually distinguishing one register from another
 * off the visible width of the panel. So "r15" read as a wall of text whose only content was that
 * it held nothing at all. Here it reads "0x0".
 *
 * What survives is what a reader is actually scanning for: hex always (the assembly-native base,
 * and copy-pasteable straight back into a Watch expression or gdb), plus whichever decimal readings
 * carry information for this particular value, plus the two annotations only assembly needs
 * (packed text, and the label a pointer lands in). The full-width hex, the binary expansion and the
 * byte breakdown all still exist — they moved into the register's own expandable children, where
 * they cost nothing until asked for.
 */
export function formatRegisterValueCompact(bits: RegisterBits, value: bigint, options: CompactValueOptions = {}): string {
  const parts = [`0x${value.toString(16)}`];

  // A value that resolved to a label is known to be an address, and no decimal reading of an
  // address has ever told anyone anything — "msg+0x8" is the answer that column was standing in for.
  if (!options.pointsTo) {
    // A decimal column that would read character-for-character like the hex one already shown
    // (every value below 10) is pure duplication — the exact thing this format exists to drop.
    if (value >= 10n && value < DECIMAL_READABLE_LIMIT) parts.push(value.toString());
    const negative = ((value >> BigInt(bits - 1)) & 1n) === 1n;
    const signed = value - (1n << BigInt(bits));
    if (negative && signed > -DECIMAL_READABLE_LIMIT) parts.push(signed.toString());
  }

  const text = options.ascii ? packedAsciiText(bits, value) : undefined;
  if (text !== undefined) parts.push(`'${text}'`);
  if (options.pointsTo) parts.push(`→ ${options.pointsTo}`);
  return parts.join('  ');
}

/** Full width, zero-padded — the form that makes two registers comparable digit by digit, kept for
 * the detail rows and hover where there is room for it. */
export function formatHexPadded(bits: RegisterBits, value: bigint): string {
  return `0x${value.toString(16).padStart(bits / 4, '0')}`;
}

/** The full binary expansion, grouped into bytes (spaces) and nibbles (underscores) so a bit
 * position can actually be counted off against an instruction's operand size. */
export function formatBinaryGrouped(bits: RegisterBits, value: bigint): string {
  const bytes: string[] = [];
  for (let shift = bits - 8; shift >= 0; shift -= 8) {
    const byte = Number((value >> BigInt(shift)) & 0xffn).toString(2).padStart(8, '0');
    bytes.push(`${byte.slice(0, 4)}_${byte.slice(4)}`);
  }
  return `0b${bytes.join(' ')}`;
}

/** The individual bytes as hex, in memory order (little-endian) — what a `db`-level reader of the
 * same value would see, and what makes an endianness mistake visible instead of theoretical. */
export function formatBytesLittleEndian(bits: RegisterBits, value: bigint): string {
  return valueBytesLittleEndian(bits, value)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join(' ');
}

/** The compact value with the register's name in front — for the places with no name column of
 * their own to carry it (Watch, the Debug Console, inline decorations, an array element row). */
export function formatRegisterValue(name: string, bits: RegisterBits, value: bigint, options: CompactValueOptions = {}): string {
  return `${name} = ${formatRegisterValueCompact(bits, value, options)}`;
}

/**
 * The multi-line form for a hover — the one context with room to answer every reading of the value
 * at once, so nothing has to be chosen between. Sub-register views are included because "what is in
 * al right now" is answered by the same bits already read, and hovering `al` in source where the
 * program only ever loaded `rax` should not come back empty.
 */
export function formatRegisterDetailed(name: string, bits: RegisterBits, value: bigint, options: CompactValueOptions = {}): string {
  const lines = [
    `${name}  (${bits}-bit register)`,
    `${formatHexPadded(bits, value)}  ${value.toString()}`,
    formatBinaryGrouped(bits, value),
    `bytes: ${formatBytesLittleEndian(bits, value)}  (little-endian)`,
  ];
  const negative = ((value >> BigInt(bits - 1)) & 1n) === 1n;
  if (negative) lines[1] += `  signed: ${(value - (1n << BigInt(bits))).toString()}`;

  const subs = subRegisterViews(name, value);
  if (subs.length > 0) lines.push(subs.map((s) => `${s.name} = ${formatHexPadded(s.bits, s.value)}`).join('   '));

  const text = packedAsciiText(bits, value);
  if (text !== undefined) lines.push(`as text: '${text}'`);
  if (options.pointsTo) lines.push(`→ ${options.pointsTo}`);
  return lines.join('\n');
}

// Strips the "name = " prefix a labelled display string carries before parseUserNumber goes looking
// for numbers in it. Not cosmetic: register names contain digits ("r15", "r8d"), and a bare scan
// would happily read the "15" out of "r15 = 0x0" and treat it as the value the user typed.
const LABEL_PREFIX_RE = /^\s*[$A-Za-z_][A-Za-z0-9_]*\s*=\s*/;
// Everything a display string can carry *after* its numeric columns — the packed-text rendering and
// the "→ label+0x8" pointer annotation, both of which contain digits that are not the value.
const ANNOTATION_TAIL_RE = /\s*(?:→|').*$/s;
// Numeric columns, in the order the alternation has to be tried: a "0x"/"0b" literal has to win
// over reading its own leading "0" as a decimal.
const NUMBER_TOKEN_RE = /0x[0-9a-f]+|0b[01_]+|-?\d+/gi;

/**
 * Parses user input for "set this register to a new value", accepting decimal, `0x.../0b...`,
 * and the asm-style `...h` hex suffix (e.g. "1234h") — since this is what someone debugging
 * assembly is used to typing. A negative decimal wraps to the register's own two's-complement bit
 * pattern (so "-1" on a 32-bit register becomes 0xffffffff) rather than being rejected, since
 * that's a genuinely useful shorthand at this level.
 *
 * VS Code pre-fills the edit box with the *entire* current display string, not just one column, so
 * editing only the decimal reading of "0x2a  42" still submits both columns back — and naively
 * grabbing "the first 0x... substring" from that (a real bug this replaces) would silently keep the
 * old hex value and ignore what the user actually changed.
 *
 * `current` is what the register holds right now, and it settles that question outright rather than
 * by inference: every numeric column in the submitted string that still agrees with `current` was
 * left alone, so whatever is left over is the edit. That works for a display of any shape — two
 * columns, three, a signed reading alongside an unsigned one — where the older "whichever column
 * disagrees with the other two" rule needed exactly three of them and could not tell which of two
 * disagreeing columns was the new one. The inference is kept as the fallback for when the current
 * value could not be read back.
 */
export function parseUserNumber(input: string, bits: RegisterBits, current?: bigint): bigint | undefined {
  const trimmed = input.trim();
  const modulus = 1n << BigInt(bits);
  const wrap = (v: bigint): bigint => ((v % modulus) + modulus) % modulus;

  if (/^0x[0-9a-f]+$/i.test(trimmed)) return wrap(BigInt(trimmed));
  if (/^0b[01]+$/i.test(trimmed)) return wrap(BigInt(trimmed));
  if (/^[0-9a-f]+h$/i.test(trimmed)) return wrap(BigInt(`0x${trimmed.slice(0, -1)}`));
  if (/^-?\d+$/.test(trimmed)) return wrap(BigInt(trimmed));

  const columns = trimmed.replace(LABEL_PREFIX_RE, '').replace(ANNOTATION_TAIL_RE, '');
  const values = [...columns.matchAll(NUMBER_TOKEN_RE)].map((m) => wrap(BigInt(m[0].replace(/_/g, ''))));

  if (values.length > 0 && current !== undefined) {
    const edited = values.filter((v) => v !== wrap(current));
    if (edited.length === 0) return wrap(current); // re-submitted unedited — a no-op, not a failure
    if (edited.every((v) => v === edited[0])) return edited[0];
    // More than one column was edited, to different values — no principled way to pick one, so fall
    // through to the last-resort pull below rather than guessing.
  } else if (values.length > 0) {
    if (values.every((v) => v === values[0])) return values[0];
    // The odd-one-out rule: unedited columns still agree with each other, so a lone dissenter among
    // two or more agreeing ones is the edit.
    const odd = values.filter((v) => values.filter((o) => o === v).length === 1);
    const agreed = values.find((v) => values.filter((o) => o === v).length > 1);
    if (odd.length === 1 && agreed !== undefined) return odd[0];
  }

  const hexMatch = /0x[0-9a-f]+/i.exec(trimmed);
  if (hexMatch) return wrap(BigInt(hexMatch[0]));
  return undefined;
}

export interface JumpCondition {
  /** Every conditional-jump mnemonic that tests this exact condition, as fasm spells them —
   * synonyms are one row, since "jb" and "jnae" are the same instruction encoding. */
  mnemonics: string;
  taken: boolean;
  /** What the condition means in the comparison that usually sets it, and the flag test itself. */
  meaning: string;
}

/**
 * Which conditional jumps would be taken if one were executed right now.
 *
 * This is the question EFLAGS actually gets read for. Answering it from the individual bits is a
 * small piece of memorised bit algebra — "jg is taken when ZF=0 and SF=OF" — that a person
 * re-derives at every single breakpoint while stepping through a comparison, and gets wrong in
 * exactly the places it matters (the signed/unsigned pairs: jb vs jl, ja vs jg). The flags are
 * already read to display them; deriving this costs nothing more.
 */
export function evaluateJumpConditions(eflags: bigint): JumpCondition[] {
  const bit = (n: number): boolean => ((eflags >> BigInt(n)) & 1n) === 1n;
  const cf = bit(0), pf = bit(2), zf = bit(6), sf = bit(7), of = bit(11);
  return [
    { mnemonics: 'je / jz', taken: zf, meaning: 'equal / zero — ZF=1' },
    { mnemonics: 'jne / jnz', taken: !zf, meaning: 'not equal / not zero — ZF=0' },
    { mnemonics: 'jb / jc / jnae', taken: cf, meaning: 'unsigned below (<) — CF=1' },
    { mnemonics: 'jae / jnc / jnb', taken: !cf, meaning: 'unsigned above or equal (>=) — CF=0' },
    { mnemonics: 'jbe / jna', taken: cf || zf, meaning: 'unsigned below or equal (<=) — CF=1 or ZF=1' },
    { mnemonics: 'ja / jnbe', taken: !cf && !zf, meaning: 'unsigned above (>) — CF=0 and ZF=0' },
    { mnemonics: 'jl / jnge', taken: sf !== of, meaning: 'signed less (<) — SF≠OF' },
    { mnemonics: 'jge / jnl', taken: sf === of, meaning: 'signed greater or equal (>=) — SF=OF' },
    { mnemonics: 'jle / jng', taken: zf || sf !== of, meaning: 'signed less or equal (<=) — ZF=1 or SF≠OF' },
    { mnemonics: 'jg / jnle', taken: !zf && sf === of, meaning: 'signed greater (>) — ZF=0 and SF=OF' },
    { mnemonics: 'js', taken: sf, meaning: 'negative result — SF=1' },
    { mnemonics: 'jns', taken: !sf, meaning: 'non-negative result — SF=0' },
    { mnemonics: 'jo', taken: of, meaning: 'signed overflow — OF=1' },
    { mnemonics: 'jno', taken: !of, meaning: 'no signed overflow — OF=0' },
    { mnemonics: 'jp / jpe', taken: pf, meaning: 'even parity in the low byte — PF=1' },
    { mnemonics: 'jnp / jpo', taken: !pf, meaning: 'odd parity in the low byte — PF=0' },
  ];
}

/** The one-line "what is set right now" summary shown next to the Flags group itself — the same
 * "[ IF ZF ]" shape gdb's own console prints, built from the already-decoded bits rather than a
 * second round-trip asking gdb to format the register it was just asked for the value of. */
export function formatEflagsSummary(value: bigint): string {
  const set = decodeEflags(value).filter((f) => f.value !== 0);
  if (set.length === 0) return '[ ]';
  return `[ ${set.map((f) => (f.name === 'IOPL' ? `IOPL=${f.value}` : f.name)).join(' ')} ]`;
}
