import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildAddressLineMap, buildCandidateSequence, correlateListing, MAX_LOOKAHEAD, parseListingFile } from '../src/listingMap';

const FIXTURES = path.join(__dirname, 'fixtures');

describe('parseListingFile (against real fasm2 -i "include \'listing.inc\'" output)', () => {
  it('parses a simple single-file listing, including zero-byte directive lines', () => {
    const content = fs.readFileSync(path.join(FIXTURES, 'simple.lst'), 'utf8');
    const entries = parseListingFile(content);
    assert.deepStrictEqual(
      entries.map((e) => [e.address.toString(16), e.text]),
      [
        ['0', 'format binary'],
        ['0', 'use i386'],
        ['0', 'start:'],
        ['0', 'mov eax, 1'],
        ['6', 'mov ebx, 2'],
        ['c', 'add eax, ebx'],
        ['f', 'int 0x80'],
      ],
    );
  });

  it('collapses a macro invocation into a single entry and merges wrapped byte-dump continuation lines', () => {
    const content = fs.readFileSync(path.join(FIXTURES, 'with-macro-and-include.lst'), 'utf8');
    const entries = parseListingFile(content);
    assert.deepStrictEqual(
      entries.map((e) => e.text),
      ['format binary', 'use i386', 'start:', 'addtwo 3, 4', 'nop', 'mov ebx, 99'],
    );
    // The 2-instruction macro expansion (mov+add, 10 bytes) is one entry at the call site.
    const call = entries.find((e) => e.text === 'addtwo 3, 4')!;
    assert.strictEqual(call.address, 0n);
    const nop = entries.find((e) => e.text === 'nop')!;
    assert.strictEqual(nop.address, 0xan);
  });

  it('normalizes irregular whitespace the same way fasmg does and strips inline comments', () => {
    const content = fs.readFileSync(path.join(FIXTURES, 'spacing.lst'), 'utf8');
    const entries = parseListingFile(content);
    assert.deepStrictEqual(
      entries.map((e) => e.text),
      ['format binary', 'use i386', 'start:', 'mov eax, 1', 'mov ebx,2'],
    );
  });
});

describe('buildCandidateSequence', () => {
  it('follows include directives depth-first and skips blank lines', () => {
    const candidates = buildCandidateSequence(path.join(FIXTURES, 'with-macro-and-include.asm'));
    assert.deepStrictEqual(
      candidates.map((c) => `${path.basename(c.fsPath)}:${c.line} ${c.text}`),
      [
        'with-macro-and-include.asm:1 format binary',
        'with-macro-and-include.asm:2 use i386',
        'helper.inc:1 macro addtwo? a*, b*',
        'helper.inc:2 mov eax, a',
        'helper.inc:3 add eax, b',
        'helper.inc:4 end macro',
        'with-macro-and-include.asm:6 start:',
        'with-macro-and-include.asm:7 addtwo 3, 4',
        'with-macro-and-include.asm:8 nop',
        'with-macro-and-include.asm:9 mov ebx, 99',
      ],
    );
  });

  it('terminates on a circular include (A includes B includes A) instead of recursing forever', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fasm2-studio-circular-include-test-'));
    try {
      fs.writeFileSync(path.join(dir, 'a.inc'), "A_SYM = 1\ninclude 'b.inc'\n", 'utf8');
      fs.writeFileSync(path.join(dir, 'b.inc'), "B_SYM = 2\ninclude 'a.inc'\n", 'utf8');

      const candidates = buildCandidateSequence(path.join(dir, 'a.inc'));
      const texts = candidates.map((c) => c.text);

      // Each file is visited exactly once despite the cycle: a.inc's own two lines, plus
      // b.inc's two lines reached through the first include, and no more after that.
      assert.deepStrictEqual(texts, ['A_SYM = 1', 'B_SYM = 2']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('terminates on a file that includes itself directly', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fasm2-studio-self-include-test-'));
    try {
      fs.writeFileSync(path.join(dir, 'self.inc'), "SELF_SYM = 1\ninclude 'self.inc'\n", 'utf8');

      const candidates = buildCandidateSequence(path.join(dir, 'self.inc'));
      assert.deepStrictEqual(candidates.map((c) => c.text), ['SELF_SYM = 1']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('correlateListing / buildAddressLineMap (end-to-end, real captured output)', () => {
  it('maps addresses to the correct source line for a simple single-file program', () => {
    const map = buildAddressLineMap(path.join(FIXTURES, 'simple.lst'), path.join(FIXTURES, 'simple.asm'));
    const at = (addr: number) => map.addressToLocation.get(BigInt(addr));
    // format binary/use i386/start: are zero-byte directives that also nominally sit at address
    // 0; the *last* statement recorded there wins, because that's the real instruction ("mov
    // eax, 1") that actually executes when the PC is at that address — the directives before it
    // carry no runtime meaning, so showing them instead would be a strictly worse answer.
    assert.strictEqual(at(0)!.line, 5);
    assert.strictEqual(at(6)!.line, 6);
    assert.strictEqual(at(0xc)!.line, 7);
    assert.strictEqual(at(0xf)!.line, 8);
  });

  it('maps a macro invocation to its call site, not the macro body, across an include boundary', () => {
    const entryPath = path.join(FIXTURES, 'with-macro-and-include.asm');
    const map = buildAddressLineMap(path.join(FIXTURES, 'with-macro-and-include.lst'), entryPath);

    // The macro call is also fasm2's first real instruction, sharing address 0 with the
    // zero-byte directives before it — "last wins" (see the single-file test) resolves that to
    // the call site itself, on line 7, in main.asm — never a line inside helper.inc's macro body.
    const atEntry = map.addressToLocation.get(0n);
    assert.strictEqual(atEntry!.fsPath, entryPath);
    assert.strictEqual(atEntry!.line, 7);

    const bpAddress = map.locationToAddress.get(`${entryPath}:7`);
    assert.strictEqual(bpAddress, 0n, 'expected the breakpoint address for line 7 to be 0');
  });

  it('never throws when the listing references a candidate that cannot be found', () => {
    const entries = parseListingFile('[0000000000000000]                                    this text matches nothing\n');
    assert.doesNotThrow(() => correlateListing(entries, []));
    const map = correlateListing(entries, []);
    assert.strictEqual(map.addressToLocation.size, 0);
  });

  it('bounds the forward search so a real match just past the lookahead window is left unmapped rather than scanned for unboundedly', () => {
    // A long run of candidates that never match anything, followed by the real target sitting
    // just beyond the search window used internally by correlateListing.
    const filler = Array.from({ length: MAX_LOOKAHEAD }, (_, i) => ({ fsPath: '/f.asm', line: i + 1, text: `filler_${i}` }));
    const target = { fsPath: '/f.asm', line: MAX_LOOKAHEAD + 1, text: 'target line' };

    const entries = parseListingFile('[0000000000000000]                                    target line\n');
    const map = correlateListing(entries, [...filler, target]);

    assert.strictEqual(map.addressToLocation.size, 0, 'a match past the lookahead window should not be found');
  });

  it('still finds a match sitting well within the lookahead window, past a long run of misses', () => {
    const filler = Array.from({ length: 200 }, (_, i) => ({ fsPath: '/f.asm', line: i + 1, text: `filler_${i}` }));
    const target = { fsPath: '/f.asm', line: 201, text: 'target line' };

    const entries = parseListingFile('[0000000000000000]                                    target line\n');
    const map = correlateListing(entries, [...filler, target]);

    assert.strictEqual(map.addressToLocation.get(0n)?.line, 201);
  });
});
