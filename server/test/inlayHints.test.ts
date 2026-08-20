import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { URI } from 'vscode-uri';
import { runDiagnostics } from '../src/features/diagnostics';
import { bundledListingIncPath, getInlayHints, hintLabel, ListingMapStore, uriToFsPath } from '../src/features/inlayHints';
import { buildCandidateSequence, correlateListing, parseListingFile } from '../src/listing/listingMap';
import { makeTempDir, removeTempDir } from './tempDir';

const FIXTURES = path.join(__dirname, 'fixtures');

describe('hintLabel', () => {
  it('renders an address padded to a fixed width, so the hints form a column', () => {
    assert.strictEqual(hintLabel('address', 0x400078n, 5), '0x00400078');
  });

  it('renders a size on its own, singular for one byte', () => {
    assert.strictEqual(hintLabel('size', 0x400078n, 1), '1 byte');
    assert.strictEqual(hintLabel('size', 0x400078n, 5), '5 bytes');
  });

  it('renders both together', () => {
    assert.strictEqual(hintLabel('addressAndSize', 0x400078n, 5), '0x00400078 · 5 bytes');
  });

  it('says nothing at all when hints are off', () => {
    assert.strictEqual(hintLabel('off', 0x400078n, 5), undefined);
  });

  it('says nothing for a line with no address, whatever the mode', () => {
    assert.strictEqual(hintLabel('addressAndSize', undefined, 5), undefined);
  });

  it('omits the size in size mode for a line that emitted no bytes, rather than showing "0 bytes"', () => {
    // A `segment`/`entry`/bare-label line has an address but no byte dump — claiming zero bytes
    // would be a statement about the encoding that the listing never made.
    assert.strictEqual(hintLabel('size', 0x400078n, undefined), undefined);
  });

  it('still shows the address in addressAndSize mode for a line that emitted no bytes', () => {
    assert.strictEqual(hintLabel('addressAndSize', 0x400078n, undefined), '0x00400078');
  });

  it('widens past the padding rather than truncating a 64-bit address', () => {
    assert.strictEqual(hintLabel('address', 0x7ffff7a0d000n, undefined), '0x7FFFF7A0D000');
  });

  describe('byte modes', () => {
    const MOV = ['B8', '3C', '00', '00', '00'];

    it('renders the encoding as spaced uppercase hex', () => {
      assert.strictEqual(hintLabel('bytes', 0x400078n, 5, MOV), 'B8 3C 00 00 00');
    });

    it('uppercases an encoding the listing happened to spell in lowercase', () => {
      assert.strictEqual(hintLabel('bytes', 0x400078n, 2, ['cd', '80']), 'CD 80');
    });

    it('renders the address alongside the encoding', () => {
      assert.strictEqual(hintLabel('addressAndBytes', 0x400078n, 5, MOV), '0x00400078 · B8 3C 00 00 00');
    });

    it('says nothing in bytes mode for a line that emitted no code, the same as size mode', () => {
      assert.strictEqual(hintLabel('bytes', 0x400078n, undefined, undefined), undefined);
    });

    it('still shows the address in addressAndBytes mode for a line that emitted no code', () => {
      assert.strictEqual(hintLabel('addressAndBytes', 0x400078n, undefined, undefined), '0x00400078');
    });

    // A `format ELF64` line emits the whole 120-byte header; spelling it out inline would push the
    // source off the screen, and the count is the part that is actually informative there.
    it('elides an encoding too long to sit inline, naming its real length', () => {
      const header = Array.from({ length: 120 }, () => '00');
      const label = hintLabel('bytes', 0x400000n, 120, header);
      assert.ok(label, 'expected a label');
      assert.ok(label.endsWith('… (120 bytes)'), `expected an elided label, got: ${label}`);
      assert.strictEqual(label.split(' ').filter((t) => /^[0-9A-F]{2}$/.test(t)).length, 16);
    });

    it('shows a 15-byte encoding — x86\'s longest legal instruction — in full', () => {
      const longest = Array.from({ length: 15 }, (_, i) => i.toString(16).padStart(2, '0'));
      const label = hintLabel('bytes', 0x400000n, 15, longest);
      assert.ok(label && !label.includes('…'), `the longest real instruction should not be elided, got: ${label}`);
    });
  });
});

describe('uriToFsPath', () => {
  // Deliberately not a literal expected string: the correct fsPath for a "/"-separated URI is
  // itself platform-dependent (native separators, and on Windows a lowercased, backslashed drive
  // letter) — see uriToFsPath's own doc comment for why that used to be gotten wrong. URI.parse's
  // own .fsPath is the oracle these are checked against, since server.ts's sourceFsPath is built
  // the exact same way; what these tests actually cover is the file://-scheme guard around it.
  it('decodes a percent-escaped path', () => {
    const uri = 'file:///home/me/my%20project/a.asm';
    assert.strictEqual(uriToFsPath(uri), URI.parse(uri).fsPath);
  });

  it('resolves a Windows drive URI', () => {
    const uri = 'file:///c%3A/src/a.asm';
    assert.strictEqual(uriToFsPath(uri), URI.parse(uri).fsPath);
  });

  it('refuses a non-file scheme, which has no listing to be keyed by', () => {
    assert.strictEqual(uriToFsPath('untitled:Untitled-1'), undefined);
  });
});

describe('ListingMapStore', () => {
  const map = (files: string[]) => ({
    addressToLocation: new Map(),
    locationToAddress: new Map(),
    sizeByLocation: new Map(),
    bytesByLocation: new Map(),
    mappedLinesByFile: new Map(files.map((f) => [f, [1]])),
  });

  it('serves a fragment from the map of the program that includes it', () => {
    const store = new ListingMapStore();
    store.set('/p/main.asm', map(['/p/main.asm', '/p/helper.inc']));
    assert.ok(store.get('/p/helper.inc'), 'the included fragment should resolve to its program’s map');
    assert.strictEqual(store.get('/p/helper.inc'), store.get('/p/main.asm'));
  });

  it('knows nothing about a file no listing covered', () => {
    const store = new ListingMapStore();
    store.set('/p/main.asm', map(['/p/main.asm']));
    assert.strictEqual(store.get('/p/unrelated.asm'), undefined);
  });

  it('clears, so a stale map cannot outlive the setting that produced it', () => {
    const store = new ListingMapStore();
    store.set('/p/main.asm', map(['/p/main.asm']));
    store.clear();
    assert.strictEqual(store.get('/p/main.asm'), undefined);
  });
});

describe('getInlayHints', () => {
  const SOURCE = ['format ELF64 executable', 'entry $', '        mov     eax, 60   ; exit', '        syscall'].join('\n');

  function fixture(): { doc: TextDocument; map: ReturnType<typeof correlateListing> } {
    // Built from the URI, not a hand-picked literal: uriToFsPath (which getInlayHints looks the
    // map up by) resolves to the OS-native fsPath — "\" and a lowercased drive letter on Windows —
    // so a fixture that instead hardcoded a "/"-separated fsPath for its map keys would agree with
    // it only on POSIX, by accident of both sides happening to already use the native separator.
    const uri = URI.file('/p/main.asm').toString();
    const fsPath = uriToFsPath(uri)!;
    const doc = TextDocument.create(uri, 'fasm', 1, SOURCE);
    const map = {
      addressToLocation: new Map(),
      locationToAddress: new Map([
        [`${fsPath}:3`, 0x400078n],
        [`${fsPath}:4`, 0x40007dn],
      ]),
      sizeByLocation: new Map([[`${fsPath}:3`, 5]]),
      bytesByLocation: new Map([[`${fsPath}:3`, ['B8', '3C', '00', '00', '00']]]),
      mappedLinesByFile: new Map([[fsPath, [3, 4]]]),
    };
    return { doc, map };
  }

  const fullRange = { start: { line: 0, character: 0 }, end: { line: 3, character: 0 } };

  it('annotates only the lines that produced machine code', () => {
    const { doc, map } = fixture();
    const hints = getInlayHints(doc, fullRange, map, 'addressAndSize');
    assert.deepStrictEqual(
      hints.map((h) => [h.position.line, h.label]),
      [
        [2, '0x00400078 · 5 bytes'],
        [3, '0x0040007D'],
      ],
    );
  });

  it('anchors the hint after the trailing comment, not into the middle of it', () => {
    const { doc, map } = fixture();
    const [hint] = getInlayHints(doc, fullRange, map, 'address');
    // The line ends "; exit" — the hint must sit past it, at the end of the visible text.
    assert.strictEqual(hint.position.character, SOURCE.split('\n')[2].length);
  });

  it('only walks the requested range, since the client re-asks per viewport', () => {
    const { doc, map } = fixture();
    const hints = getInlayHints(doc, { start: { line: 3, character: 0 }, end: { line: 3, character: 0 } }, map, 'address');
    assert.deepStrictEqual(hints.map((h) => h.position.line), [3]);
  });

  it('produces nothing when off, and nothing when no listing has been built yet', () => {
    const { doc, map } = fixture();
    assert.deepStrictEqual(getInlayHints(doc, fullRange, map, 'off'), []);
    assert.deepStrictEqual(getInlayHints(doc, fullRange, undefined, 'addressAndSize'), []);
  });
});

/**
 * The whole pipeline against the real assembler: compile with the listing macro, parse what it
 * wrote, correlate it against the source, and read hints off the result. This is the test that
 * would have caught the listing landing at "<stem>.lst" rather than "<output>.lst" — every layer
 * above it was correct, and the file was simply never found.
 */
describe('inlay hints end to end (requires fasm2 on PATH)', function () {
  this.timeout(20000);

  const PROGRAM = [
    'format ELF64 executable',
    'segment readable executable',
    'entry $',
    '        mov     eax, 60',
    '        xor     edi, edi',
    '        syscall',
    '',
  ].join('\n');

  let tmpDir: string | undefined;

  before(function () {
    // Skipped rather than failed where no assembler is installed: the unit tests above cover the
    // logic, and this one is about agreeing with a tool that may not be present.
    if (!bundledListingIncPath()) this.skip();
  });

  after(async () => {
    await removeTempDir(tmpDir);
  });

  it('reports the real encoded size of each instruction', async function () {
    tmpDir = makeTempDir('fasm2-hints-');
    // Goes through a file:// URI and back rather than using path.join's result directly, the same
    // round trip server.ts makes for a real client (uriToFsPath(document.uri)): on Windows the two
    // are not always the same string even for the same file (a URI's drive letter is lowercased,
    // and mkdtempSync's is whatever the OS's own temp path casing happens to be) — a mismatch that
    // is exactly what broke every hint here before uriToFsPath normalized separators to match.
    const rawFsPath = path.join(tmpDir, 'prog.asm');
    fs.writeFileSync(rawFsPath, PROGRAM, 'utf8');
    const uri = URI.file(rawFsPath).toString();
    const sourceFsPath = uriToFsPath(uri)!;

    const result = await runDiagnostics({
      compilerPath: 'fasm2',
      sourceFsPath,
      cwd: tmpDir,
      listingInclude: bundledListingIncPath(),
    });

    if (result.toolError) this.skip(); // no usable fasm2 on this machine
    assert.ok(result.listing, 'the compile should have produced a listing');

    const map = correlateListing(result.listing, buildCandidateSequence(sourceFsPath));
    const doc = TextDocument.create(uri, 'fasm', 1, PROGRAM);
    const hints = getInlayHints(doc, { start: { line: 0, character: 0 }, end: { line: 6, character: 0 } }, map, 'size');

    // "mov eax, 60" is 5 bytes (B8 3C 00 00 00), "xor edi, edi" and "syscall" are 2 each.
    //
    // Line 0 is the interesting one: `format ELF64 executable` really does emit 120 bytes — a
    // 64-byte ELF header plus a 56-byte program header — and the listing spreads them over sixteen
    // lines. Reporting the full 120 rather than the 8 on the first line is what the continuation
    // handling in parseListingFile exists for.
    //
    // `segment` and `entry` emit nothing of their own and correctly carry no hint at all.
    assert.deepStrictEqual(
      hints.map((h) => [h.position.line, h.label]),
      [
        [0, '120 bytes'],
        [3, '5 bytes'],
        [4, '2 bytes'],
        [5, '2 bytes'],
      ],
    );
  });
});

describe('parseListingFile byte lengths', () => {
  it('counts the bytes of each statement, and leaves code-less statements without one', () => {
    const entries = parseListingFile(fs.readFileSync(path.join(FIXTURES, 'simple.lst'), 'utf8'));
    assert.ok(entries.length > 0);
    // Every byte list that exists must be non-empty and hold real hex pairs — an empty one would
    // render as a "0 bytes" hint, a claim the listing never made.
    for (const entry of entries) {
      if (entry.bytes === undefined) continue;
      assert.ok(entry.bytes.length > 0, `empty byte list for ${entry.text}`);
      for (const byte of entry.bytes) assert.match(byte, /^[0-9A-Fa-f]{2}$/, `bad byte in ${entry.text}`);
    }
  });
});
