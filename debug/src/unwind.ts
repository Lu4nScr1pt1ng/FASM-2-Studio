// Reconstructs a call stack for a binary that carries no unwind information at all.
//
// A fasmg-assembled program has no DWARF, no .eh_frame and no symbol table, so gdb itself reports
// exactly one frame however deep the program actually is — and "how did I get here" is the question
// a large assembly project raises most often and had no way to answer.
//
// The trick this file rests on is that fasm2 Studio already extracts something better than CFI for
// this particular purpose: the listing. A listing entry carries an address *and the bytes that
// statement assembled to*, which between them name the exact address every `call` in the program
// pushes. Collected once at launch (see collectReturnSites), that is a precise, closed set of the
// only values a return address can have — not a heuristic about what a code address looks like.
// Recognising a stack word as a return address then becomes an exact set membership test rather
// than the "does this look like it points into the text segment" guess a scanning unwinder normally
// has to make.
//
// Detection has to work from the encoding rather than the listing's statement text, and that is not
// a stylistic preference: a `call` emitted from inside a macro shows the *macro invocation* as its
// text. Verified against a real fasm2 listing, where a statement reading "emitcall outer" assembles
// to "E8 12 00 00 00" — a direct near call that any text-matching rule would miss, in exactly the
// macro-heavy code this extension exists for.
import { ListingEntry } from '@fasm2-studio/server/src/listing/listingMap';

/** Legacy prefixes plus the 64-bit REX range, all of which may precede an opcode and none of which
 * change which opcode it is. Listed as the byte values a listing spells them with. */
const PREFIX_BYTES = new Set([
  0x66, 0x67, // operand-size, address-size
  0xf0, 0xf2, 0xf3, // lock, repne, rep
  0x2e, 0x36, 0x3e, 0x26, 0x64, 0x65, // segment overrides
]);

const CALL_NEAR_RELATIVE = 0xe8;
const CALL_FAR_ABSOLUTE = 0x9a; // 32-bit only; invalid in long mode, still emitted by 32-bit code
const GROUP_FF = 0xff;
/** The ModRM reg field values that make an "FF" opcode a call: /2 near indirect, /3 far indirect. */
const FF_CALL_EXTENSIONS = new Set([2, 3]);

/**
 * Whether `bytes` — one listing statement's encoding, as the listing spelled it ("E8", "17", ...) —
 * is a call instruction.
 *
 * Deliberately conservative in the one direction that matters. A missed call costs a frame in the
 * backtrace; a *false* call would invent a return site, and since a return site is what licenses
 * calling a stack word a return address, that would invent whole frames out of leftover stack. So
 * only the three encodings that really are calls are accepted, and anything unrecognised is not.
 */
export function isCallEncoding(bytes: readonly string[] | undefined): boolean {
  if (!bytes || bytes.length === 0) return false;
  let i = 0;
  while (i < bytes.length) {
    const byte = Number.parseInt(bytes[i], 16);
    if (Number.isNaN(byte)) return false;
    // REX is 0x40-0x4f and is always the *last* prefix before the opcode, but treating it as just
    // another skippable prefix costs nothing and needs no ordering rule.
    if (PREFIX_BYTES.has(byte) || (byte >= 0x40 && byte <= 0x4f)) {
      i++;
      continue;
    }
    if (byte === CALL_NEAR_RELATIVE || byte === CALL_FAR_ABSOLUTE) return true;
    if (byte !== GROUP_FF) return false;
    // "FF" is a whole group of unrelated instructions — inc, dec, push, jmp and call all share it —
    // told apart only by the reg field of the ModRM byte that follows.
    const modrm = Number.parseInt(bytes[i + 1] ?? '', 16);
    if (Number.isNaN(modrm)) return false;
    return FF_CALL_EXTENSIONS.has((modrm >> 3) & 7);
  }
  return false;
}

/**
 * Every address a `call` in this program pushes as its return address.
 *
 * The address *after* the call, which is the call's own address plus the length of its encoding —
 * and the listing states both exactly, so this needs no disassembler and no reads from the live
 * process. A statement the assembler emitted no bytes for (a bare label, a directive) cannot be a
 * call and is skipped by isCallEncoding.
 */
export function collectReturnSites(entries: readonly ListingEntry[]): Set<bigint> {
  const sites = new Set<bigint>();
  for (const entry of entries) {
    if (!isCallEncoding(entry.bytes)) continue;
    sites.add(entry.address + BigInt(entry.bytes?.length ?? 0));
  }
  return sites;
}

/** One machine word read off the stack, with the address it came from. */
export interface StackWord {
  address: bigint;
  value: bigint;
}

export interface UnwoundFrame {
  /** Where this frame is executing: the stop's own PC for the innermost frame, and for every caller
   * the return address that will resume it. */
  pc: bigint;
  /** The stack slot the return address was found in. Undefined for the innermost frame, which was
   * not recovered from the stack at all. */
  returnAddressAt?: bigint;
  /** How this frame was found — reported on the frame itself, because a frame-pointer walk and a
   * stack scan do not carry the same confidence and a reader is entitled to know which produced
   * what they are looking at. */
  via: 'stop' | 'frame-pointer' | 'stack-scan';
}

export interface UnwindOptions {
  /** Where the program is stopped. */
  pc: bigint;
  stackPointer: bigint;
  /** The frame pointer, when the target has one. A fasm program is under no obligation to maintain
   * it, which is why a failed frame-pointer walk falls back to a scan rather than giving up. */
  framePointer: bigint | undefined;
  /** 8 on x86-64, 4 on i386 — the width of a pushed return address. */
  wordBytes: number;
  /** The stack from the stack pointer upward, ascending by address. Everything this walk can reach
   * has to be in here: it performs no reads of its own, so a chain leaving this window ends there. */
  stack: readonly StackWord[];
  /** Whether `address` is one a call in this program pushes — see collectReturnSites. */
  isReturnSite: (address: bigint) => boolean;
  maxFrames: number;
}

/**
 * The call stack, innermost frame first.
 *
 * Two strategies, because the two kinds of assembly this has to work on are genuinely different.
 * Code that keeps a frame pointer ("push rbp / mov rbp, rsp") has an explicit linked list of frames
 * running up the stack, and following it gives the calls in their true nesting order with no
 * guessing. Code that does not — which is most hand-written assembly, since nothing makes it
 * necessary — leaves only the return addresses themselves, so those get scanned for.
 *
 * Where a frame pointer exists the two are combined, and the reason is a case the chain walk cannot
 * see on its own: the frames *below* the innermost frame-pointed one. A leaf routine that does not
 * bother with a prologue — the overwhelmingly common shape for a small helper — leaves rbp still
 * addressing its caller's frame, so the chain starting there skips straight past the caller and
 * reports it as though the leaf had been called from one level higher. Its return address is
 * sitting between the stack pointer and the frame pointer, in the one region the chain never looks
 * at. (Found by the end-to-end test, against a real three-deep fasm2 program: the middle frame
 * simply was not there.) So that region is scanned first, and the chain walked from the frame
 * pointer up, which are disjoint by construction.
 *
 * With no usable frame pointer at all the scan covers the whole window instead. Its results are
 * honestly ordered — a return address deeper in the stack was pushed earlier — but a scan cannot
 * tell a live frame from a dead one left behind by a call that already returned, which is why every
 * frame records which strategy produced it.
 */
export function unwindStack(options: UnwindOptions): UnwoundFrame[] {
  const { pc, stackPointer, framePointer, wordBytes, stack, isReturnSite, maxFrames } = options;
  const frames: UnwoundFrame[] = [{ pc, via: 'stop' }];
  const byAddress = new Map<bigint, bigint>(stack.map((w) => [w.address, w.value]));
  const word = (address: bigint): bigint | undefined => byAddress.get(address);

  const chain = walkFramePointers(framePointer, stackPointer, BigInt(wordBytes), word, isReturnSite, maxFrames);
  // Below the first frame-pointed frame when there is a chain; the whole stack when there is not.
  const scanEnd = chain.length > 0 && framePointer !== undefined ? framePointer : undefined;
  for (const { address, value } of stack) {
    if (frames.length >= maxFrames) break;
    if (scanEnd !== undefined && address >= scanEnd) break;
    if (!isReturnSite(value)) continue;
    frames.push({ pc: value, returnAddressAt: address, via: 'stack-scan' });
  }
  return [...frames, ...chain].slice(0, maxFrames);
}

/**
 * Follows the saved-rbp chain: at each frame the frame pointer addresses the caller's saved frame
 * pointer, with the return address in the word directly above it.
 *
 * Every step is validated rather than trusted, because an uninitialised rbp holding a plausible
 * number is the normal state of a fasm program that never set one up, and a chain walked out of one
 * would report frames that do not exist. Three conditions have to hold: the frame pointer is inside
 * the stack window that was actually read, the word above it is an address some call in this program
 * really pushes, and the next link points *higher* up the stack than this one. The last is what
 * guarantees termination — the stack grows down, so a caller's frame is always at a higher address,
 * and any chain that fails to advance is a cycle rather than a caller.
 */
function walkFramePointers(
  framePointer: bigint | undefined,
  stackPointer: bigint,
  wordBytes: bigint,
  word: (address: bigint) => bigint | undefined,
  isReturnSite: (address: bigint) => boolean,
  maxFrames: number,
): UnwoundFrame[] {
  const frames: UnwoundFrame[] = [];
  let current = framePointer;
  while (current !== undefined && frames.length < maxFrames - 1) {
    if (current < stackPointer) break;
    const saved = word(current);
    const returnAddressAt = current + wordBytes;
    const returnAddress = word(returnAddressAt);
    if (saved === undefined || returnAddress === undefined) break;
    if (!isReturnSite(returnAddress)) break;
    frames.push({ pc: returnAddress, returnAddressAt, via: 'frame-pointer' });
    if (saved <= current) break;
    current = saved;
  }
  return frames;
}
