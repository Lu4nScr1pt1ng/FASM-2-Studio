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

/** Renders one bit pattern in every base at once — hex and binary always agree with the decimal
 * value because all three come from the same parsed bigint, not three separate gdb round-trips
 * that could each format the same register differently (gdb defaults to *signed* decimal for
 * a plain register, e.g. -1 for 0xffffffff, which reads as a bug more than a feature here). */
export function formatRegisterValue(name: string, bits: RegisterBits, value: bigint): string {
  const hex = value.toString(16).padStart(bits / 4, '0');
  const bin = value
    .toString(2)
    .padStart(bits, '0')
    .replace(/(.{4})(?=.)/g, '$1_');
  return `${name} = 0x${hex}  ${value.toString()}  0b${bin}`;
}

/**
 * Parses user input for "set this register to a new value", accepting decimal, `0x.../0b...`,
 * and the asm-style `...h` hex suffix (e.g. "1234h") — since this is what someone debugging
 * assembly is used to typing. A negative decimal wraps to the register's own two's-complement bit
 * pattern (so "-1" on a 32-bit register becomes 0xffffffff) rather than being rejected, since
 * that's a genuinely useful shorthand at this level. Falls back to pulling the leading `0x...`
 * out of our own hover/Registers-panel display string, so re-submitting an unedited value (VS
 * Code pre-fills the edit box with the current display text) is a no-op instead of an error.
 */
export function parseUserNumber(input: string, bits: RegisterBits): bigint | undefined {
  const trimmed = input.trim();
  const modulus = 1n << BigInt(bits);

  let value: bigint | undefined;
  if (/^0x[0-9a-f]+$/i.test(trimmed)) value = BigInt(trimmed);
  else if (/^0b[01]+$/i.test(trimmed)) value = BigInt(trimmed);
  else if (/^[0-9a-f]+h$/i.test(trimmed)) value = BigInt(`0x${trimmed.slice(0, -1)}`);
  else if (/^-?\d+$/.test(trimmed)) value = BigInt(trimmed);
  else {
    const hexMatch = /0x[0-9a-f]+/i.exec(trimmed);
    if (hexMatch) value = BigInt(hexMatch[0]);
  }

  if (value === undefined) return undefined;
  return ((value % modulus) + modulus) % modulus;
}
