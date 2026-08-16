import * as assert from 'assert';
import { ListingEntry } from '@fasm2-studio/server/src/listing/listingMap';
import { collectReturnSites, isCallEncoding, unwindStack, UnwindOptions } from '../src/unwind';

describe('isCallEncoding', () => {
  it('recognizes the direct near call every assembled "call label" produces', () => {
    // Straight from a real fasm2 listing: "call outer" at 0x400080 assembled to these five bytes.
    assert.strictEqual(isCallEncoding(['E8', '17', '00', '00', '00']), true);
  });

  it('recognizes an indirect call through a register ("call rax" -> FF D0)', () => {
    assert.strictEqual(isCallEncoding(['FF', 'D0']), true);
  });

  it('recognizes a call carrying a REX prefix, which says nothing about which opcode follows', () => {
    assert.strictEqual(isCallEncoding(['48', 'FF', 'D0']), true);
  });

  it('recognizes the 32-bit far call, which a 16/32-bit target can still emit', () => {
    assert.strictEqual(isCallEncoding(['9A', '00', '00', '00', '00', '00', '00']), true);
  });

  it('rejects the other instructions sharing the FF opcode group, told apart only by the ModRM reg field', () => {
    // The whole reason the ModRM byte has to be decoded rather than "FF" taken as a call: inc
    // (/0), dec (/1), jmp (/4) and push (/6) are all spelled FF too, and calling any of them a
    // call would invent a return site — and therefore invent stack frames out of leftover words.
    assert.strictEqual(isCallEncoding(['FF', 'C0']), false, 'inc eax is FF /0');
    assert.strictEqual(isCallEncoding(['FF', 'C8']), false, 'dec eax is FF /1');
    assert.strictEqual(isCallEncoding(['FF', 'E0']), false, 'jmp rax is FF /4');
    assert.strictEqual(isCallEncoding(['FF', 'F0']), false, 'push rax is FF /6');
  });

  it('accepts the two FF forms that are calls', () => {
    assert.strictEqual(isCallEncoding(['FF', 'D0']), true, 'FF /2 is a near indirect call');
    assert.strictEqual(isCallEncoding(['FF', 'D8']), true, 'FF /3 is a far indirect call');
  });

  it('rejects ordinary instructions, and a statement that assembled to no bytes at all', () => {
    assert.strictEqual(isCallEncoding(['B8', '01', '00', '00', '00']), false, 'mov eax, 1');
    assert.strictEqual(isCallEncoding(['C3']), false, 'ret');
    assert.strictEqual(isCallEncoding(['0F', '05']), false, 'syscall');
    assert.strictEqual(isCallEncoding([]), false);
    assert.strictEqual(isCallEncoding(undefined), false, 'a bare label emits nothing');
  });

  it('rejects an FF with no ModRM byte behind it rather than guessing', () => {
    assert.strictEqual(isCallEncoding(['FF']), false);
  });
});

describe('collectReturnSites', () => {
  const entry = (address: bigint, text: string, bytes?: string[]): ListingEntry => ({ address, text, bytes });

  it('records the address after each call, which is what that call pushes', () => {
    const sites = collectReturnSites([
      entry(0x400080n, 'call outer', ['E8', '17', '00', '00', '00']),
      entry(0x400085n, 'mov eax, 60', ['B8', '3C', '00', '00', '00']),
    ]);
    assert.deepStrictEqual([...sites], [0x400085n]);
  });

  it('finds a call the listing text does not name, because a macro emitted it', () => {
    // The reason detection reads the encoding and not the statement text. This is a real fasm2
    // listing line: the text is the macro invocation, and the bytes are a direct near call.
    const sites = collectReturnSites([entry(0x400085n, 'emitcall outer', ['E8', '12', '00', '00', '00'])]);
    assert.deepStrictEqual([...sites], [0x40008an]);
  });

  it('ignores everything that is not a call, so a stray stack word cannot pass as a return address', () => {
    const sites = collectReturnSites([
      entry(0x400000n, 'start:', undefined),
      entry(0x400000n, 'push rbp', ['55']),
      entry(0x400001n, 'jmp rax', ['FF', 'E0']),
      entry(0x400003n, 'ret', ['C3']),
    ]);
    assert.strictEqual(sites.size, 0);
  });
});

// A stack laid out the way two nested frames with prologues actually leave it, addresses ascending
// from the stack pointer. Frame layout, innermost first:
//   0x7000  saved rbp of the innermost frame -> 0x7010
//   0x7008  return address into the middle frame
//   0x7010  saved rbp of the middle frame    -> 0x7020
//   0x7018  return address into the outer frame
const RETURN_INTO_MIDDLE = 0x4000a5n;
const RETURN_INTO_OUTER = 0x400085n;
const NESTED_STACK = [
  { address: 0x7000n, value: 0x7010n },
  { address: 0x7008n, value: RETURN_INTO_MIDDLE },
  { address: 0x7010n, value: 0x7020n },
  { address: 0x7018n, value: RETURN_INTO_OUTER },
  { address: 0x7020n, value: 0n },
  { address: 0x7028n, value: 0n },
];

function options(overrides: Partial<UnwindOptions> = {}): UnwindOptions {
  const sites = new Set([RETURN_INTO_MIDDLE, RETURN_INTO_OUTER]);
  return {
    pc: 0x4000c0n,
    stackPointer: 0x7000n,
    framePointer: 0x7000n,
    wordBytes: 8,
    stack: NESTED_STACK,
    isReturnSite: (address) => sites.has(address),
    maxFrames: 64,
    ...overrides,
  };
}

describe('unwindStack — the frame-pointer chain', () => {
  it('follows the saved-rbp chain through nested frames, innermost first', () => {
    const frames = unwindStack(options());
    assert.deepStrictEqual(
      frames.map((f) => f.pc),
      [0x4000c0n, RETURN_INTO_MIDDLE, RETURN_INTO_OUTER],
    );
    assert.deepStrictEqual(
      frames.map((f) => f.via),
      ['stop', 'frame-pointer', 'frame-pointer'],
    );
  });

  it('reports where each return address was found, so a frame can be traced back to its slot', () => {
    const frames = unwindStack(options());
    assert.strictEqual(frames[0].returnAddressAt, undefined, 'the innermost frame came from the PC, not the stack');
    assert.strictEqual(frames[1].returnAddressAt, 0x7008n);
    assert.strictEqual(frames[2].returnAddressAt, 0x7018n);
  });

  it('stops where the chain leaves the stack window instead of reporting a frame it could not read', () => {
    const frames = unwindStack(options({ stack: NESTED_STACK.slice(0, 2) }));
    assert.deepStrictEqual(frames.map((f) => f.pc), [0x4000c0n, RETURN_INTO_MIDDLE]);
  });

  it('refuses a chain link whose return address is not one any call in this program pushes', () => {
    // An uninitialised rbp pointing at plausible-looking numbers is the normal state of a fasm
    // program that never set one up. Walking that would report frames out of leftover stack, so
    // the return address is checked against the listing before a frame is believed.
    const frames = unwindStack(options({ isReturnSite: () => false }));
    assert.deepStrictEqual(frames.map((f) => f.pc), [0x4000c0n]);
  });

  it('terminates on a chain that does not climb, rather than looping on it', () => {
    // A frame pointer pointing at itself: every read succeeds and the return address validates, so
    // only the "a caller's frame is always higher up the stack" rule ends this.
    const selfReferential = [
      { address: 0x7000n, value: 0x7000n },
      { address: 0x7008n, value: RETURN_INTO_MIDDLE },
    ];
    const frames = unwindStack(options({ stack: selfReferential }));
    assert.deepStrictEqual(frames.map((f) => f.pc), [0x4000c0n, RETURN_INTO_MIDDLE]);
  });

  it('never reports more than maxFrames, however long the chain claims to be', () => {
    // A chain that climbs by one word forever, with every link validating.
    const runaway = Array.from({ length: 200 }, (_, i) => ({
      address: 0x7000n + BigInt(i * 8),
      value: i % 2 === 0 ? 0x7000n + BigInt((i + 2) * 8) : RETURN_INTO_MIDDLE,
    }));
    const frames = unwindStack(options({ stack: runaway, maxFrames: 8 }));
    assert.strictEqual(frames.length, 8);
  });

  it('falls back to the scan when the frame pointer is below the stack pointer and cannot be a frame', () => {
    // rbp holding something that is not a frame pointer is the ordinary case, not a broken one —
    // it is whatever the program last used rbp for. Rejecting the chain is right; giving up on the
    // backtrace because of it would throw away the return addresses that are still on the stack.
    const frames = unwindStack(options({ framePointer: 0x6000n }));
    assert.deepStrictEqual(frames.map((f) => f.pc), [0x4000c0n, RETURN_INTO_MIDDLE, RETURN_INTO_OUTER]);
    assert.deepStrictEqual(frames.map((f) => f.via), ['stop', 'stack-scan', 'stack-scan']);
  });
});

describe('unwindStack — the scan fallback', () => {
  it('finds return addresses by scanning when the program keeps no frame pointer', () => {
    // Most hand-written assembly never sets up rbp, so there is no chain to walk — but the return
    // addresses the calls pushed are still sitting there, and the listing says exactly which values
    // those can be.
    const frames = unwindStack(options({ framePointer: undefined }));
    assert.deepStrictEqual(
      frames.map((f) => f.pc),
      [0x4000c0n, RETURN_INTO_MIDDLE, RETURN_INTO_OUTER],
    );
    assert.deepStrictEqual(frames.map((f) => f.via), ['stop', 'stack-scan', 'stack-scan']);
  });

  it('orders scanned frames by stack address, which is the order they were pushed in', () => {
    const frames = unwindStack(options({ framePointer: undefined }));
    assert.deepStrictEqual(frames.slice(1).map((f) => f.returnAddressAt), [0x7008n, 0x7018n]);
  });

  it('reports only the stop when nothing on the stack is a return address', () => {
    const frames = unwindStack(options({ framePointer: undefined, isReturnSite: () => false }));
    assert.deepStrictEqual(frames.map((f) => f.pc), [0x4000c0n]);
  });

  it('does not re-scan the region the frame-pointer chain already covered', () => {
    // The chain starts at the stack pointer here, so there is nothing below it to scan and every
    // frame has to come from the walk. Scanning the chain's own region too would report each of
    // these return addresses a second time.
    const frames = unwindStack(options());
    assert.strictEqual(frames.every((f) => f.via !== 'stack-scan'), true);
    assert.strictEqual(frames.length, 3);
  });

  it('finds the caller of a frameless leaf, which the chain walk steps straight over', () => {
    // The case the end-to-end test caught against a real three-deep program. A leaf that skips the
    // "push rbp / mov rbp, rsp" prologue — the normal shape for a small helper — leaves rbp still
    // addressing its *caller's* frame, so the chain starting there reports the caller's caller and
    // silently drops a frame. The leaf's own return address is below the frame pointer, in the one
    // region the chain never reads.
    //   0x7000  return address into the middle frame   <- rsp, pushed by the call into the leaf
    //   0x7008  saved rbp of the middle frame          <- rbp
    //   0x7010  return address into the outer frame
    const framelessLeaf = [
      { address: 0x7000n, value: RETURN_INTO_MIDDLE },
      { address: 0x7008n, value: 0x7020n },
      { address: 0x7010n, value: RETURN_INTO_OUTER },
      { address: 0x7020n, value: 0n },
    ];
    const frames = unwindStack(options({ stack: framelessLeaf, framePointer: 0x7008n }));
    assert.deepStrictEqual(
      frames.map((f) => f.pc),
      [0x4000c0n, RETURN_INTO_MIDDLE, RETURN_INTO_OUTER],
      'the middle frame is the one a chain-only walk loses',
    );
    assert.deepStrictEqual(frames.map((f) => f.via), ['stop', 'stack-scan', 'frame-pointer']);
  });
});
