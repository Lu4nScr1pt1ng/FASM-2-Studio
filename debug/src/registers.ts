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
//
// The same reported-names list carries far more than the integer registers, and the rest of it is
// where most of a real program's state actually lives:
//   st0-st7 fctrl fstat ftag fiseg fioff foseg fooff fop   — the x87 stack and its environment
//   xmm0-15 mxcsr                                          — SSE, and on x86-64 the *entire* float ABI
//   ymm0-15 (and their ymm0h-ymm15h upper halves), pkru    — AVX, reported only once running (below)
//   fs_base gs_base orig_rax                               — TLS, and the syscall number at a stop
// One thing about that list is worth stating outright, because it is not guessable: it *grows* once
// the process starts. Asked of a loaded-but-not-yet-running x86-64 target, gdb reports xmm0-15 and
// mxcsr but no ymm registers at all; asked again after the first stop, ymm0-15 and pkru have
// appeared, because gdb re-reads the target description from the live process (XSAVE) and only then
// knows which extensions the CPU actually has. So the names have to be resolved a second time at the
// first stop, or AVX would be permanently invisible on a machine that supports it.

export type RegisterBits = 8 | 16 | 32 | 64;

/** The SIMD register widths — deliberately *not* part of RegisterBits, which is the set of widths
 * that have a C `unsigned` type to cast to (see unsignedCastType); reading one of these goes
 * through its 64-bit lanes instead, since there is no portable cast that names a 128-bit value. */
export type VectorBits = 128 | 256 | 512;

/**
 * Every *reserved x86 mnemonic* gdb might report as a `$`-prefixed convenience register, mapped to
 * its bit width — covers whatever name a hover in real assembly source might land on, not just the
 * curated set the Registers scope groups below display.
 *
 * "Reserved mnemonic" is the membership rule, and it is load-bearing rather than descriptive: every
 * name in here is one fasm itself refuses to let you define a label with, which is exactly what
 * licenses hover and operand translation (operandExpression.ts) to resolve the name as a register
 * *before* consulting the program's own symbols. Names gdb exposes that fasm does not reserve —
 * `fs_base`, `orig_rax`, `mxcsr` — are a separate map below for that reason.
 */
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
  // The AVX-512 mask registers. Reserved mnemonics like the rest (`kmovq k1, rax`), and plain
  // 64-bit integers, so everything below treats them as ordinary registers.
  k0: 64, k1: 64, k2: 64, k3: 64, k4: 64, k5: 64, k6: 64, k7: 64,
};

/**
 * The registers gdb reports that are *not* fasm mnemonics, mapped to the width their value has.
 *
 * Kept apart from REGISTER_WIDTH_BITS for one specific reason: nothing stops a fasm program from
 * defining a label called `orig_rax`, or a constant called `fop`. For a real mnemonic, resolving a
 * hovered name as a register before looking at the program's own symbols is unambiguously right —
 * the symbol cannot exist. For these it is not, so they resolve *after* labels and constants, and
 * operand translation ignores them entirely (a name inside `[...]` came from fasm source, where
 * these are not spellable at all).
 *
 * The x87 environment registers are the widths the FPU architecturally defines (a 16-bit control
 * word, a 16-bit tag word), not the width gdb's own struct happens to print them at.
 */
export const PSEUDO_REGISTER_WIDTH_BITS: Record<string, RegisterBits> = {
  // TLS: on x86-64 the fs/gs *selectors* read as 0 and say nothing — the base is the real answer,
  // and the address `mov rax, [fs:0x28]` (the stack canary) actually reads from.
  fs_base: 64, gs_base: 64,
  // The syscall number the program entered the kernel with, preserved by Linux across the call
  // because rax itself has been overwritten with the return value by the time you can look.
  orig_rax: 64, orig_eax: 32,
  mxcsr: 32,
  fctrl: 16, fstat: 16, ftag: 16, fop: 16, fiseg: 16, foseg: 16,
  fioff: 32, fooff: 32,
  pkru: 32,
};

/** The width of `name` whether it is a reserved mnemonic or one of gdb's own additions — for the
 * display paths (the Registers panel, a Watch row the user typed themselves), which have already
 * decided this name means a register. Resolution *order* is the caller's problem, not this
 * function's: see PSEUDO_REGISTER_WIDTH_BITS on why hover cannot simply use this. */
export function registerWidthBits(name: string): RegisterBits | undefined {
  return REGISTER_WIDTH_BITS[name] ?? PSEUDO_REGISTER_WIDTH_BITS[name];
}

/** xmm0-31 / ymm0-31 / zmm0-31 — reserved mnemonics, so these resolve ahead of program symbols the
 * way the integer registers do, but at widths no `unsigned` cast can name (see VectorBits). */
export const VECTOR_WIDTH_BITS: Record<string, VectorBits> = Object.fromEntries(
  Array.from({ length: 32 }, (_, i) => i).flatMap((i) => [
    [`xmm${i}`, 128 as VectorBits],
    [`ymm${i}`, 256 as VectorBits],
    [`zmm${i}`, 512 as VectorBits],
  ]),
);

/** st0-st7 — the x87 register stack. 80-bit extended precision, which is neither a RegisterBits
 * width nor a SIMD one, and is the only value here that is not an integer at all. */
export const X87_REGISTER_NAMES: readonly string[] = Array.from({ length: 8 }, (_, i) => `st${i}`);
const X87_REGISTER_SET = new Set(X87_REGISTER_NAMES);

/** Whether `name` is a register mnemonic fasm reserves — the test that decides whether a hovered
 * name may be resolved as a register before the program's own labels are consulted. */
export function isReservedRegisterMnemonic(name: string): boolean {
  return REGISTER_WIDTH_BITS[name] !== undefined || VECTOR_WIDTH_BITS[name] !== undefined || X87_REGISTER_SET.has(name);
}

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

// The reverse of SUB_REGISTER_NAMES, restricted to the 32-bit views: "eax" -> "rax", "r12d" -> "r12".
// See wideParentOf32BitView for why only that width needs it.
const PARENT_OF_32_BIT_VIEW: Record<string, string> = Object.fromEntries(
  Object.entries(SUB_REGISTER_NAMES)
    .filter(([parent]) => REGISTER_WIDTH_BITS[parent] === 64)
    .flatMap(([parent, subs]) => subs.filter((s) => REGISTER_WIDTH_BITS[s] === 32).map((s) => [s, parent])),
);

/**
 * The 64-bit register a 32-bit name is a view of ("eax" -> "rax"), or undefined for a name that is
 * not one — including on a 32-bit target, where "eax" is a whole register in its own right and the
 * caller is expected to check that the parent actually exists before using this.
 *
 * This exists because of the one x86-64 rule that has no equivalent at any other width: a write to
 * a 32-bit register zeroes the upper half of its 64-bit parent, while a write to a 16- or 8-bit one
 * leaves everything above it alone. There is no instruction that writes eax and preserves the high
 * half of rax, so a debugger that offers "set eax" and produces one has put the CPU in a state the
 * program could not have reached — which is exactly the sort of thing you go to a debugger to rule
 * out. gdb's own `$eax = 1` does precisely that (verified against gdb 16.3: rax reads back
 * 0xffffffff00000001), so the write is redirected to the parent instead.
 */
export function wideParentOf32BitView(name: string): string | undefined {
  return PARENT_OF_32_BIT_VIEW[name];
}

/** The narrower registers that alias part of `name`, each with the slice of `value` it holds.
 * Empty for a register with no narrower name (rip/eip, the segment registers, eflags). */
export function subRegisterViews(name: string, value: bigint): Array<SubRegisterView & { value: bigint }> {
  return (SUB_REGISTER_NAMES[name] ?? []).map((sub) => {
    const bits = REGISTER_WIDTH_BITS[sub];
    const shift = sub.endsWith('h') && sub.length === 2 ? 8 : 0;
    return { name: sub, bits, shift, value: (value >> BigInt(shift)) & ((1n << BigInt(bits)) - 1n) };
  });
}

/**
 * The one place fasm's register spelling and gdb's disagree: the low byte of r8-r15 is `r8b`-`r15b`
 * in Intel/fasm syntax and `r8l`-`r15l` to gdb.
 *
 * This has to be translated rather than tolerated, because gdb does not reject the name it does not
 * know — `$r12b` is read as a *convenience variable*, which is a perfectly legal thing to invent on
 * the spot. `p $r12b` answers "void" and `set $r12b = 0x2a` assigns to that invented variable and
 * leaves the CPU untouched, reporting success (verified against gdb 16.3: r12 reads back unchanged
 * afterwards, while the same write to `$r12l` lands). A silent no-op on a register write is the
 * worst failure available here — you single-step on, believing a value you never set.
 */
const GDB_REGISTER_ALIASES: Record<string, string> = Object.fromEntries(
  [8, 9, 10, 11, 12, 13, 14, 15].map((n) => [`r${n}b`, `r${n}l`]),
);

/** `name` as gdb spells it in a `$`-expression. Identical to the input for every register whose two
 * spellings agree, which is all of them but the eight above. */
export function gdbRegisterName(name: string): string {
  return GDB_REGISTER_ALIASES[name] ?? name;
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
  /** One name per SIMD register index, at the widest width this target reports it: zmm0 if the CPU
   * has AVX-512, else ymm0 if it has AVX, else xmm0. Only the widest, because they are the *same
   * register* — xmm0 is the low 128 bits of ymm0 — and listing all three would be listing one
   * register three times. The narrower views are offered as children instead, exactly like al/ax
   * under rax. */
  vector: string[];
  /** st0-st7, the x87 register stack. */
  x87: string[];
  /** fctrl/fstat/ftag/fop/fiseg/fioff/foseg/fooff — the x87 environment: what the FPU is configured
   * to do, and what it has already done. */
  x87Control: string[];
  /** "mxcsr" — SSE's control/status word, the direct analogue of eflags for float code. */
  mxcsrName: string | undefined;
  /** k0-k7, the AVX-512 predicate masks. */
  mask: string[];
  /** fs_base/gs_base/orig_rax — thread-local storage and syscall context. */
  thread: string[];
  /** Each reported register's own index in gdb's list, which is the only handle
   * "-data-list-register-values" takes. Needed for the x87 stack, whose raw 80-bit bit pattern has
   * no expression form to ask for (`p/x $st0` is not something -data-evaluate-expression accepts). */
  numbers: ReadonlyMap<string, number>;
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
// Widest-first per index, which is what makes one row per *physical* register rather than one per
// name: a target reporting zmm4/ymm4/xmm4 has one 512-bit register, not three.
const VECTOR_SLOTS: string[][] = Array.from({ length: 32 }, (_, i) => [`zmm${i}`, `ymm${i}`, `xmm${i}`]);
const X87_SLOTS: string[][] = X87_REGISTER_NAMES.map((name) => [name]);
// Configuration before status before the last-instruction record: fctrl says what the FPU will do,
// fstat what it just did, and the four fiseg/fioff/foseg/fooff fields are the address of the last
// x87 instruction and its operand — read only when chasing down which instruction raised a flag.
const X87_CONTROL_SLOTS: string[][] = [['fctrl'], ['fstat'], ['ftag'], ['fop'], ['fiseg'], ['fioff'], ['foseg'], ['fooff']];
const MASK_SLOTS: string[][] = Array.from({ length: 8 }, (_, i) => [`k${i}`]);
const THREAD_SLOTS: string[][] = [['fs_base'], ['gs_base'], ['orig_rax', 'orig_eax']];

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
 * ignored here (never a valid register name to match against), though their *positions* still
 * count: an entry's index in this array is the register number gdb answers to. */
export function resolveRegisterGroups(registerNames: readonly string[]): RegisterGroups {
  const lowered = registerNames.map((n) => n.toLowerCase());
  const available = new Set(lowered.filter((n) => n.length > 0));
  const numbers = new Map<string, number>();
  lowered.forEach((name, index) => {
    // First occurrence wins — a name never repeats in a real target description, and a malformed
    // one that did would otherwise leave the *later* number in the map for no reason.
    if (name.length > 0 && !numbers.has(name)) numbers.set(name, index);
  });
  return {
    generalPurpose: pickAvailable(GP_SLOTS, available),
    pointers: pickAvailable(POINTER_SLOTS, available),
    segment: pickAvailable(SEGMENT_SLOTS, available),
    eflagsName: available.has('eflags') ? 'eflags' : undefined,
    vector: pickAvailable(VECTOR_SLOTS, available),
    x87: pickAvailable(X87_SLOTS, available),
    x87Control: pickAvailable(X87_CONTROL_SLOTS, available),
    mxcsrName: available.has('mxcsr') ? 'mxcsr' : undefined,
    mask: pickAvailable(MASK_SLOTS, available),
    thread: pickAvailable(THREAD_SLOTS, available),
    numbers,
  };
}

/** A packed field within a control/status word: `width` bits starting at `bit`. EFLAGS, MXCSR and
 * the two x87 words are all this same shape — a set of single-bit flags with one or two multi-bit
 * fields mixed in — so all four are described with this and decoded by decodeBitFields. */
export interface BitFieldInfo {
  name: string;
  bit: number;
  width: number;
  description: string;
  /** For a multi-bit field, what each of its values means — indexed by the field's value, so
   * "RC = 3" can read as "toward zero (truncate)" instead of as a number. */
  values?: readonly string[];
}

export interface DecodedBitField {
  name: string;
  value: number;
  /** How many bits the field occupies — what separates a flag, which is worth reading as set or
   * clear, from a small number that has to be shown as one. */
  width: number;
  description: string;
  /** The named meaning of `value` for a multi-bit field, or undefined for a field whose values are
   * not individually named (TOP, which is simply a register index). */
  meaning?: string;
}

function decodeBitFields(fields: readonly BitFieldInfo[], value: bigint): DecodedBitField[] {
  return fields.map((f) => {
    const bits = Number((value >> BigInt(f.bit)) & ((1n << BigInt(f.width)) - 1n));
    return { name: f.name, value: bits, width: f.width, description: f.description, meaning: f.values?.[bits] };
  });
}

/** The "[ ... ]" one-liner for a control/status word — the same shape gdb's own console prints for
 * eflags: set flags by name, multi-bit fields as "NAME=value". Zero-valued single-bit flags are
 * dropped, which is what keeps the line short enough to read at a glance. */
export function formatBitFieldSummary(decoded: readonly DecodedBitField[]): string {
  const shown = decoded.filter((f) => f.value !== 0);
  if (shown.length === 0) return '[ ]';
  // A multi-bit field's *name* alone would be a lie by omission: "[ TOP ]" says the field is set,
  // when what it holds is which register st0 currently is. Only a one-bit field is a flag.
  return `[ ${shown.map((f) => (f.width === 1 ? f.name : `${f.name}=${f.value}`)).join(' ')} ]`;
}

/** The IEEE-754 rounding modes, in the encoding both MXCSR's RC field and the x87 control word's
 * RC field use — the same two bits meaning the same four things in both places. */
const ROUNDING_MODES = [
  'to nearest, ties to even (the default)',
  'toward -infinity (down)',
  'toward +infinity (up)',
  'toward zero (truncate)',
] as const;

/** The standard x86/x86-64 EFLAGS/RFLAGS bit layout (identical in the low 32 bits of both) —
 * every documented bit, not just the handful an assembly programmer checks daily, since the
 * point of this view is to show *everything* rather than a curated guess at what matters. */
export const EFLAGS_BITS: readonly BitFieldInfo[] = [
  { name: 'CF', bit: 0, width: 1, description: 'Carry Flag — set when an arithmetic op carried/borrowed out of the top bit.' },
  { name: 'PF', bit: 2, width: 1, description: 'Parity Flag — set when the low byte of the result has an even number of set bits.' },
  { name: 'AF', bit: 4, width: 1, description: 'Auxiliary Carry Flag — set on a carry/borrow out of bit 3 (used by BCD arithmetic).' },
  { name: 'ZF', bit: 6, width: 1, description: 'Zero Flag — set when the result was zero.' },
  { name: 'SF', bit: 7, width: 1, description: "Sign Flag — copy of the result's most significant bit (1 = negative in two's complement)." },
  { name: 'TF', bit: 8, width: 1, description: 'Trap Flag — enables single-step (one instruction at a time) debugging mode.' },
  { name: 'IF', bit: 9, width: 1, description: 'Interrupt Enable Flag — set when maskable hardware interrupts are allowed.' },
  { name: 'DF', bit: 10, width: 1, description: 'Direction Flag — string instructions (movs/cmps/...) increment when clear, decrement when set.' },
  { name: 'OF', bit: 11, width: 1, description: 'Overflow Flag — set when a *signed* arithmetic op overflowed (distinct from CF, which tracks unsigned overflow).' },
  {
    name: 'IOPL', bit: 12, width: 2,
    description: 'I/O Privilege Level — the minimum privilege ring allowed to execute I/O instructions (protected/long mode only).',
    values: ['ring 0 (kernel)', 'ring 1', 'ring 2', 'ring 3 (user)'],
  },
  { name: 'NT', bit: 14, width: 1, description: 'Nested Task — set when the current task was entered via a CALL/interrupt from another task (affects IRET).' },
  { name: 'RF', bit: 16, width: 1, description: 'Resume Flag — temporarily suppresses debug-exception traps, used to resume execution after hitting a breakpoint.' },
  { name: 'VM', bit: 17, width: 1, description: 'Virtual-8086 Mode — set while running as a virtual 8086 task inside protected mode.' },
  { name: 'AC', bit: 18, width: 1, description: 'Alignment Check — enables faulting on unaligned memory references (also needs the AM bit in CR0).' },
  { name: 'VIF', bit: 19, width: 1, description: 'Virtual Interrupt Flag — a virtualized copy of IF, used by virtual-8086/protected-mode extensions.' },
  { name: 'VIP', bit: 20, width: 1, description: 'Virtual Interrupt Pending — set to indicate a virtual interrupt is waiting to be delivered.' },
  { name: 'ID', bit: 21, width: 1, description: 'ID Flag — software toggles this to test whether the CPU supports the CPUID instruction.' },
];

export function decodeEflags(value: bigint): DecodedBitField[] {
  return decodeBitFields(EFLAGS_BITS, value);
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
  /** Whether a decimal reading is one of the readings this value has at all. False for the values
   * that are bit patterns rather than quantities — a control/status word, a segment selector —
   * where nothing in the program ever adds one to them and "0x1f80  8064" spends a column saying
   * the same thing twice in a base nobody asked for. */
  decimal?: boolean;
}

/** Extracts `value` as its individual bytes, least-significant first — the order they actually sit
 * in memory on x86, and (because fasm packs a character literal with its first character in the
 * lowest byte) also the order the characters of a packed string literal appear in. */
export function valueBytesLittleEndian(bits: number, value: bigint): number[] {
  const bytes: number[] = [];
  for (let i = 0; i < bits / 8; i++) bytes.push(Number((value >> BigInt(i * 8)) & 0xffn));
  return bytes;
}

/** The value read as packed text, or undefined when it isn't plausibly text at all. Trailing zero
 * bytes are dropped (an unfilled register holding a short literal), but an *interior* zero, any
 * non-printable byte, or fewer than two characters left over all disqualify it — one stray
 * printable byte is just a small number, and calling it text would mislead far more often than it
 * would help. */
export function packedAsciiText(bits: number, value: bigint): string | undefined {
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
  if (!options.pointsTo && options.decimal !== false) {
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
export function formatHexPadded(bits: number, value: bigint): string {
  return `0x${value.toString(16).padStart(bits / 4, '0')}`;
}

/** The full binary expansion, grouped into bytes (spaces) and nibbles (underscores) so a bit
 * position can actually be counted off against an instruction's operand size. */
export function formatBinaryGrouped(bits: number, value: bigint): string {
  const bytes: string[] = [];
  for (let shift = bits - 8; shift >= 0; shift -= 8) {
    const byte = Number((value >> BigInt(shift)) & 0xffn).toString(2).padStart(8, '0');
    bytes.push(`${byte.slice(0, 4)}_${byte.slice(4)}`);
  }
  return `0b${bytes.join(' ')}`;
}

/** The individual bytes as hex, in memory order (little-endian) — what a `db`-level reader of the
 * same value would see, and what makes an endianness mistake visible instead of theoretical. */
export function formatBytesLittleEndian(bits: number, value: bigint): string {
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
export function parseUserNumber(input: string, bits: number, current?: bigint): bigint | undefined {
  const trimmed = input.trim();
  const modulus = 1n << BigInt(bits);
  const wrap = (v: bigint): bigint => ((v % modulus) + modulus) % modulus;

  if (/^0x[0-9a-f]+$/i.test(trimmed)) return wrap(BigInt(trimmed));
  if (/^0b[01]+$/i.test(trimmed)) return wrap(BigInt(trimmed));
  if (/^[0-9a-f]+h$/i.test(trimmed)) return wrap(BigInt(`0x${trimmed.slice(0, -1)}`));
  if (/^-?\d+$/.test(trimmed)) return wrap(BigInt(trimmed));

  const columns = trimmed.replace(LABEL_PREFIX_RE, '').replace(ANNOTATION_TAIL_RE, '');
  const tokens = [...columns.matchAll(NUMBER_TOKEN_RE)].map((m) => m[0]);
  const values = tokens.map((t) => wrap(BigInt(t.replace(/_/g, ''))));

  // Everything below reads a *display string* — several columns of the same value, one of them
  // edited. A lone bare decimal with no "0x"/"0b" column beside it is not that; it is a typo like
  // "0xzz", whose only number is the leading "0". Setting a register to zero because someone
  // mistyped a hex digit is worse than refusing, so that case is left to fail below.
  const looksLikeDisplayString = values.length > 1 || tokens.some((t) => /^0[xb]/i.test(t));

  if (looksLikeDisplayString && current !== undefined) {
    const edited = values.filter((v) => v !== wrap(current));
    if (edited.length === 0) return wrap(current); // re-submitted unedited — a no-op, not a failure
    if (edited.every((v) => v === edited[0])) return edited[0];
    // More than one column was edited, to different values — no principled way to pick one, so fall
    // through to the last-resort pull below rather than guessing.
  } else if (looksLikeDisplayString) {
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

/** The one-line "what is set right now" summary shown next to the Flags group itself — built from
 * the already-decoded bits rather than a second round-trip asking gdb to format the register it was
 * just asked for the value of, so the names can never disagree with the number beside them. */
export function formatEflagsSummary(value: bigint): string {
  return formatBitFieldSummary(decodeEflags(value));
}

/**
 * MXCSR — the control and status word for every SSE/AVX instruction.
 *
 * Worth reading for the same reason EFLAGS is: the low six bits are *sticky* exception flags, set
 * by a float operation that went wrong and never cleared by hardware afterwards. So an SSE program
 * producing a NaN out of nowhere has a record of where it came from sitting right here — IE set
 * means some operation was handed an invalid input, ZE means something divided by zero — and unlike
 * EFLAGS, nothing resets them between instructions, so the flag survives all the way to the next
 * time anyone looks.
 */
export const MXCSR_BITS: readonly BitFieldInfo[] = [
  { name: 'IE', bit: 0, width: 1, description: 'Invalid Operation — a sticky record that some SSE op was given an operand it could not act on (0/0, sqrt of a negative, an operation on a signaling NaN). Set by hardware, cleared only by software.' },
  { name: 'DE', bit: 1, width: 1, description: 'Denormal — an operand was denormalized (too small to represent with a full mantissa). Sticky.' },
  { name: 'ZE', bit: 2, width: 1, description: 'Divide-by-Zero — a finite non-zero value was divided by zero. Sticky.' },
  { name: 'OE', bit: 3, width: 1, description: 'Overflow — a result was too large in magnitude to represent, and became an infinity. Sticky.' },
  { name: 'UE', bit: 4, width: 1, description: 'Underflow — a result was too small in magnitude to represent normally. Sticky.' },
  { name: 'PE', bit: 5, width: 1, description: 'Precision — a result had to be rounded. Set by almost any real float arithmetic; rarely interesting on its own. Sticky.' },
  { name: 'DAZ', bit: 6, width: 1, description: 'Denormals Are Zero — treat denormal *inputs* as zero instead of handling them, trading exactness for speed.' },
  { name: 'IM', bit: 7, width: 1, description: 'Invalid Operation Mask — when set (the default), an invalid operation produces a NaN instead of raising #XF.' },
  { name: 'DM', bit: 8, width: 1, description: 'Denormal Mask — when set (the default), a denormal operand is handled silently instead of raising #XF.' },
  { name: 'ZM', bit: 9, width: 1, description: 'Divide-by-Zero Mask — when set (the default), division by zero produces an infinity instead of raising #XF.' },
  { name: 'OM', bit: 10, width: 1, description: 'Overflow Mask — when set (the default), overflow produces an infinity instead of raising #XF.' },
  { name: 'UM', bit: 11, width: 1, description: 'Underflow Mask — when set (the default), underflow produces a denormal or zero instead of raising #XF.' },
  { name: 'PM', bit: 12, width: 1, description: 'Precision Mask — when set (the default), rounding happens silently instead of raising #XF.' },
  { name: 'RC', bit: 13, width: 2, description: 'Rounding Control — how a result that cannot be represented exactly is rounded.', values: ROUNDING_MODES },
  { name: 'FZ', bit: 15, width: 1, description: 'Flush To Zero — produce a zero instead of a denormal *result*, trading exactness for speed.' },
];

export function decodeMxcsr(value: bigint): DecodedBitField[] {
  return decodeBitFields(MXCSR_BITS, value);
}

/**
 * The x87 control word (`fctrl`) — what the FPU is configured to do.
 *
 * The field that actually surprises people is PC: x87 computes at whatever precision this says, not
 * at the precision of the operands. A program whose results differ from the same arithmetic done in
 * SSE, or from the same arithmetic on another machine, is very often reading a PC that someone else
 * set. Its default (0x37f) is extended precision with everything masked.
 */
export const X87_CONTROL_BITS: readonly BitFieldInfo[] = [
  { name: 'IM', bit: 0, width: 1, description: 'Invalid Operation Mask — when set (the default), an invalid operation produces a NaN instead of raising #MF.' },
  { name: 'DM', bit: 1, width: 1, description: 'Denormal Operand Mask — when set (the default), a denormal operand is handled silently.' },
  { name: 'ZM', bit: 2, width: 1, description: 'Divide-by-Zero Mask — when set (the default), division by zero produces an infinity.' },
  { name: 'OM', bit: 3, width: 1, description: 'Overflow Mask — when set (the default), overflow produces an infinity.' },
  { name: 'UM', bit: 4, width: 1, description: 'Underflow Mask — when set (the default), underflow produces a denormal or zero.' },
  { name: 'PM', bit: 5, width: 1, description: 'Precision Mask — when set (the default), rounding happens silently.' },
  {
    name: 'PC', bit: 8, width: 2,
    description: 'Precision Control — the mantissa width every x87 computation is carried out at, regardless of the operand sizes involved.',
    values: ['single (24-bit mantissa)', '(reserved)', 'double (53-bit mantissa)', 'extended (64-bit mantissa — the default)'],
  },
  { name: 'RC', bit: 10, width: 2, description: 'Rounding Control — how a result that cannot be represented exactly is rounded.', values: ROUNDING_MODES },
  { name: 'X', bit: 12, width: 1, description: 'Infinity Control — a no-op on every FPU since the 387, kept only for compatibility.' },
];

export function decodeX87Control(value: bigint): DecodedBitField[] {
  return decodeBitFields(X87_CONTROL_BITS, value);
}

/**
 * The x87 status word (`fstat`) — what the FPU has already done.
 *
 * TOP is the field to know about: the x87 registers are a *stack*, and `st0` names whichever
 * physical register TOP currently points at. That is why an `fld` too many silently corrupts
 * everything after it — the stack wrapped, SF and IE went up, and every `st(n)` after that names a
 * different register than the source says it does. Reading TOP is how that becomes visible.
 *
 * C0-C3 are the comparison result: `fcom`/`fucom` leave their answer here rather than in EFLAGS,
 * which is why x87 comparison code goes through `fstsw ax` + `sahf` (or `fcomi`, which writes
 * EFLAGS directly).
 */
export const X87_STATUS_BITS: readonly BitFieldInfo[] = [
  { name: 'IE', bit: 0, width: 1, description: 'Invalid Operation — sticky: some x87 op was given an operand it could not act on, or the register stack overflowed/underflowed (see SF).' },
  { name: 'DE', bit: 1, width: 1, description: 'Denormal Operand — sticky.' },
  { name: 'ZE', bit: 2, width: 1, description: 'Divide-by-Zero — sticky.' },
  { name: 'OE', bit: 3, width: 1, description: 'Overflow — sticky.' },
  { name: 'UE', bit: 4, width: 1, description: 'Underflow — sticky.' },
  { name: 'PE', bit: 5, width: 1, description: 'Precision — a result had to be rounded. Sticky, and set by most real arithmetic.' },
  { name: 'SF', bit: 6, width: 1, description: 'Stack Fault — the register stack overflowed (one fld too many) or underflowed (one fstp too many). C1 then says which: 1 for overflow, 0 for underflow.' },
  { name: 'ES', bit: 7, width: 1, description: 'Error Summary — set while any unmasked exception flag above is set.' },
  { name: 'C0', bit: 8, width: 1, description: 'Condition Code 0 — after a compare, the "below" bit (the x87 equivalent of CF).' },
  { name: 'C1', bit: 9, width: 1, description: 'Condition Code 1 — the rounding direction after an arithmetic op, or the stack-fault direction when SF is set.' },
  { name: 'C2', bit: 10, width: 1, description: 'Condition Code 2 — after a compare, set when the operands were unordered (a NaN was involved).' },
  { name: 'TOP', bit: 11, width: 3, description: 'Stack Top — which physical register st0 currently names. Every st(n) is relative to this, so a corrupted TOP silently renames the whole stack.' },
  { name: 'C3', bit: 14, width: 1, description: 'Condition Code 3 — after a compare, the "equal" bit (the x87 equivalent of ZF).' },
  { name: 'B', bit: 15, width: 1, description: 'Busy — a hardwired copy of ES on every FPU since the 387.' },
];

export function decodeX87Status(value: bigint): DecodedBitField[] {
  return decodeBitFields(X87_STATUS_BITS, value);
}

/** What the two tag bits for one physical x87 register mean. "empty" is the ordinary state of a
 * register nothing has been pushed into, and the reason a freshly started program reads 0xffff. */
const X87_TAG_STATES = ['valid', 'zero', 'special (NaN, infinity, denormal or unsupported)', 'empty'] as const;

/** The x87 tag word (`ftag`), two bits per *physical* register — st0's own tag is at index TOP, not
 * at index 0, which is the whole reason this is worth decoding rather than reading as hex. */
export function decodeX87Tags(value: bigint): Array<{ physical: number; state: string }> {
  return Array.from({ length: 8 }, (_, physical) => ({
    physical,
    state: X87_TAG_STATES[Number((value >> BigInt(physical * 2)) & 3n)],
  }));
}

export interface DecodedSegmentSelector {
  /** The descriptor's index within its table — the part that actually identifies the segment. */
  index: number;
  /** 'GDT' or 'LDT', from the table-indicator bit. */
  table: 'GDT' | 'LDT';
  /** Requested Privilege Level, 0-3 — 3 for everything in a user-mode program. */
  rpl: number;
}

/**
 * A segment register's value is a *selector*, not an address and not a number: 13 bits of
 * descriptor-table index, one bit choosing which table, and two bits of privilege level. Read as
 * plain hex it is noise — "cs = 0x33" tells you nothing — and read as a selector it is the ordinary
 * user-mode 64-bit code segment (GDT entry 6, ring 3). This is the only reading of these registers
 * that ever says anything, which is why the segment rows show it instead of a decimal column.
 */
export function decodeSegmentSelector(value: bigint): DecodedSegmentSelector {
  return {
    index: Number((value >> 3n) & 0x1fffn),
    table: ((value >> 2n) & 1n) === 1n ? 'LDT' : 'GDT',
    rpl: Number(value & 3n),
  };
}

/** The selector as one short line for a register row that already shows the hex — "GDT[6] ring 3".
 * A null selector (0) is called what it is instead: every field of it is zero and reading them off
 * individually would only dress up "unused" as data. */
export function formatSegmentSelector(value: bigint): string {
  if (value === 0n) return 'null selector (unused)';
  const { index, table, rpl } = decodeSegmentSelector(value);
  return `${table}[${index}] ring ${rpl}`;
}

// ---------------------------------------------------------------------------------------------
// SIMD. A vector register has no single "the value" the way an integer register does: the same 128
// bits are four floats to one instruction and sixteen bytes to the next, and which reading is the
// real one is a property of the code, not of the register. So the row shows the bits, and every
// interpretation of them is offered as a child — all derived from the one value already read, so
// the choice costs nothing.
// ---------------------------------------------------------------------------------------------

/** The narrower registers that alias the low half of a vector register — xmm0 is the low 128 bits
 * of ymm0, which is the low 256 of zmm0. Exactly the al/ax/eax relationship one width class up,
 * and worth showing for the same reason: a program that only ever wrote `xmm0` still has its value
 * sitting in the low lanes of whatever wider name the target reports. */
export function vectorSubRegisterViews(name: string, value: bigint): Array<{ name: string; bits: VectorBits; value: bigint }> {
  const bits = VECTOR_WIDTH_BITS[name];
  const index = /^[xyz]mm(\d+)$/.exec(name)?.[1];
  if (bits === undefined || index === undefined) return [];
  const narrower: Array<[string, VectorBits]> = [[`ymm${index}`, 256], [`xmm${index}`, 128]];
  return narrower
    .filter(([, subBits]) => subBits < bits)
    .map(([subName, subBits]) => ({ name: subName, bits: subBits, value: value & ((1n << BigInt(subBits)) - 1n) }));
}

/** Reads `count` bits of `value` starting at lane `index` of that width, as an unsigned integer. */
function laneValue(value: bigint, index: number, laneBits: number): bigint {
  return (value >> BigInt(index * laneBits)) & ((1n << BigInt(laneBits)) - 1n);
}

const FLOAT_SCRATCH = new DataView(new ArrayBuffer(8));

/** The IEEE-754 single-precision number those 32 bits encode. Decoded here rather than asked of
 * gdb: it is the same value either way, and doing it from bits already in hand keeps every lane of
 * every vector register free of a round-trip. */
export function float32FromBits(bits: bigint): number {
  FLOAT_SCRATCH.setUint32(0, Number(bits & 0xffffffffn));
  return FLOAT_SCRATCH.getFloat32(0);
}

/** The IEEE-754 double-precision number those 64 bits encode. */
export function float64FromBits(bits: bigint): number {
  FLOAT_SCRATCH.setBigUint64(0, bits & 0xffffffffffffffffn);
  return FLOAT_SCRATCH.getFloat64(0);
}

/** A float as short a string as round-trips back to the same value, with the two spellings JS gets
 * wrong for this context fixed: negative zero is a distinct bit pattern worth seeing as `-0`, and
 * `Infinity` is spelled `inf` the way every debugger and every float printer does. */
export function formatFloat(value: number): string {
  if (Number.isNaN(value)) return 'nan';
  if (value === Infinity) return 'inf';
  if (value === -Infinity) return '-inf';
  if (value === 0) return Object.is(value, -0) ? '-0' : '0';
  return String(value);
}

export type VectorLaneKind = 'int8' | 'int16' | 'int32' | 'int64' | 'float32' | 'float64';

export interface VectorLaneGroup {
  kind: VectorLaneKind;
  /** How the row names this reading — "4 x float", "16 x byte". */
  label: string;
  /** One entry per lane, **lane 0 first**: the low-order end of the register, which is the end
   * every SIMD instruction numbers from. Note this is the opposite order from reading the hex,
   * where lane 0 is at the *right*. */
  lanes: string[];
  description: string;
}

const LANE_KIND_BITS: Record<VectorLaneKind, number> = { int8: 8, int16: 16, int32: 32, int64: 64, float32: 32, float64: 64 };

/**
 * Every reading of a vector register's bits, one group per lane width.
 *
 * All of them, rather than a guess at which one this program meant: the guess is not available —
 * nothing in the register says whether `movaps` put four floats or sixteen bytes there — and a
 * debugger that picks one silently is wrong exactly when the program is doing something surprising,
 * which is when someone is looking.
 */
export function vectorLaneGroups(bits: VectorBits, value: bigint): VectorLaneGroup[] {
  const groups: Array<{ kind: VectorLaneKind; noun: string; description: string; render: (lane: bigint) => string }> = [
    { kind: 'float64', noun: 'double', description: 'Read as packed IEEE-754 double-precision floats — what an "sd"/"pd" instruction (addsd, mulpd) operates on.', render: (lane) => formatFloat(float64FromBits(lane)) },
    { kind: 'float32', noun: 'float', description: 'Read as packed IEEE-754 single-precision floats — what an "ss"/"ps" instruction (addss, mulps) operates on.', render: (lane) => formatFloat(float32FromBits(lane)) },
    { kind: 'int64', noun: 'qword', description: 'Read as packed 64-bit integers.', render: (lane) => `0x${lane.toString(16)}` },
    { kind: 'int32', noun: 'dword', description: 'Read as packed 32-bit integers.', render: (lane) => `0x${lane.toString(16)}` },
    { kind: 'int16', noun: 'word', description: 'Read as packed 16-bit integers.', render: (lane) => `0x${lane.toString(16)}` },
    { kind: 'int8', noun: 'byte', description: 'Read as packed bytes — the reading a pcmpeqb/pshufb mask is written in.', render: (lane) => `0x${lane.toString(16).padStart(2, '0')}` },
  ];

  return groups.map(({ kind, noun, description, render }) => {
    const laneBits = LANE_KIND_BITS[kind];
    const count = bits / laneBits;
    return {
      kind,
      label: `${count} x ${noun}`,
      lanes: Array.from({ length: count }, (_, i) => render(laneValue(value, i, laneBits))),
      description,
    };
  });
}

/**
 * A vector register's value for a row that already carries its name.
 *
 * Plain unpadded hex, for the same reason every other row here is: 512 bits of zero-padding is 128
 * characters spent saying "this register was never touched". No decimal reading is offered at any
 * width — there is no instruction that treats a vector register as one 128-bit number, so a decimal
 * column here would be a reading of the bits that nothing in the program ever performs.
 *
 * The packed-text rendering survives, and earns its place more here than anywhere else: loading a
 * string sixteen bytes at a time through `movdqu` is exactly what SSE gets used for in the kind of
 * program this debugger is for.
 */
export function formatVectorValueCompact(bits: VectorBits, value: bigint): string {
  const parts = [`0x${value.toString(16)}`];
  const text = packedAsciiText(bits, value);
  if (text !== undefined) parts.push(`'${text}'`);
  return parts.join('  ');
}

/** The multi-line form for a hover over a vector register — the one place with room for every lane
 * reading at once, so nothing has to be chosen between. */
export function formatVectorDetailed(name: string, bits: VectorBits, value: bigint): string {
  const lines = [`${name}  (${bits}-bit vector register)`, formatHexPadded(bits, value)];
  for (const group of vectorLaneGroups(bits, value)) lines.push(`${group.label.padEnd(11)} ${group.lanes.join(', ')}`);
  const text = packedAsciiText(bits, value);
  if (text !== undefined) lines.push(`as text: '${text}'`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------------------------
// x87, whose 80-bit extended format is the one value here that is not an integer in any reading.
// ---------------------------------------------------------------------------------------------

export type ExtendedFloatClass =
  | 'zero'
  | 'denormal'
  | 'normal'
  | 'infinity'
  | 'quiet NaN'
  | 'signaling NaN'
  | 'unsupported';

export interface DecodedExtendedFloat {
  negative: boolean;
  /** The raw 15-bit exponent field, as stored (biased by 16383). */
  biasedExponent: number;
  /** The unbiased power of two this value is scaled by, or undefined for a value that has none
   * (zero, an infinity, a NaN). */
  exponent: number | undefined;
  /** The raw 64-bit significand, explicit integer bit included — x87 is the one IEEE format that
   * stores that bit rather than implying it, which is why it has states no other format does. */
  significand: bigint;
  /** Whether the explicit integer bit is set. Clear on anything but a denormal or a zero means the
   * value is one the FPU itself rejects — see the 'unsupported' class. */
  integerBit: boolean;
  classification: ExtendedFloatClass;
}

/**
 * Takes apart the 80 bits gdb hands back for one x87 register.
 *
 * Worth doing rather than settling for the decimal gdb prints, because the states that actually
 * cause trouble are invisible in a decimal reading. An *empty* register — one nothing has been
 * pushed into — is not zero; it holds whatever the last program to use the FPU left, and reads as a
 * perfectly plausible number. A register left holding an unnormal (explicit integer bit clear at a
 * non-zero exponent) is a value no instruction on any FPU since the 387 can produce, so seeing one
 * means something wrote raw bytes over the FPU state. Both read as ordinary decimals; only the bit
 * fields say what they are. (The tag word is the authority on empty — see decodeX87Tags — but a
 * value whose classification is 'unsupported' is a strong second opinion.)
 */
export function decodeExtendedFloat(raw: bigint): DecodedExtendedFloat {
  const negative = ((raw >> 79n) & 1n) === 1n;
  const biasedExponent = Number((raw >> 64n) & 0x7fffn);
  const significand = raw & 0xffffffffffffffffn;
  const integerBit = ((significand >> 63n) & 1n) === 1n;
  const fraction = significand & 0x7fffffffffffffffn;

  let classification: ExtendedFloatClass;
  let exponent: number | undefined;
  if (biasedExponent === 0x7fff) {
    // The explicit integer bit being clear at a maximal exponent is a pseudo-infinity or
    // pseudo-NaN: encodings the 8087 produced and every FPU since treats as invalid input.
    if (!integerBit) classification = 'unsupported';
    else if (fraction === 0n) classification = 'infinity';
    // Bit 62 is the quiet bit: set means the NaN propagates silently, clear means it raises.
    else classification = ((fraction >> 62n) & 1n) === 1n ? 'quiet NaN' : 'signaling NaN';
  } else if (biasedExponent === 0) {
    // A pseudo-denormal (integer bit set at a zero exponent) is likewise an encoding no current FPU
    // produces, but unlike the ones above it has a well-defined value, so it is not "unsupported".
    classification = significand === 0n ? 'zero' : 'denormal';
    if (classification === 'denormal') exponent = -16382;
  } else if (!integerBit) {
    classification = 'unsupported'; // an unnormal
  } else {
    classification = 'normal';
    exponent = biasedExponent - 16383;
  }
  return { negative, biasedExponent, exponent, significand, integerBit, classification };
}

/** The structural one-liner for an x87 register, to sit beside the decimal value gdb prints:
 * "normal  sign - exp 2^1  significand 0xc8f5c28f5c28f800". The decimal is deliberately not
 * recomputed here — an 80-bit significand does not fit in the 53 bits a JS number has, so any value
 * this file computed would be a rounded copy of one gdb can print exactly. */
export function formatExtendedFloat(raw: bigint): string {
  const d = decodeExtendedFloat(raw);
  const parts: string[] = [d.classification];
  if (d.classification !== 'zero') parts.push(d.negative ? 'sign -' : 'sign +');
  if (d.exponent !== undefined) parts.push(`exp 2^${d.exponent}`);
  parts.push(`significand 0x${d.significand.toString(16).padStart(16, '0')}`);
  return parts.join('  ');
}
