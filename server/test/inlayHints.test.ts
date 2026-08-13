import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { URI } from 'vscode-uri';
import { runDiagnostics } from '../src/features/diagnostics';
import { bundledListingIncPath, getInlayHints, hintLabel, ListingMapStore, uriToFsPath } from '../src/features/inlayHints';
import { buildCandidateSequence, correlateListing, parseListingFile } from '../src/listing/listingMap';

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
});

describe('uriToFsPath', () => {
  it('decodes a percent-escaped path', () => {
    assert.strictEqual(uriToFsPath('file:///home/me/my%20project/a.asm'), '/home/me/my project/a.asm');
  });

  it('strips the leading slash a Windows drive URI carries', () => {
    assert.strictEqual(uriToFsPath('file:///c%3A/src/a.asm'), 'c:/src/a.asm');
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
    const fsPath = '/p/main.asm';
    const doc = TextDocument.create(URI.file(fsPath).toString(), 'fasm', 1, SOURCE);
    const map = {
      addressToLocation: new Map(),
      locationToAddress: new Map([
        [`${fsPath}:3`, 0x400078n],
        [`${fsPath}:4`, 0x40007dn],
      ]),
      sizeByLocation: new Map([[`${fsPath}:3`, 5]]),
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

  after(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reports the real encoded size of each instruction', async function () {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fasm2-hints-'));
    const sourceFsPath = path.join(tmpDir, 'prog.asm');
    fs.writeFileSync(sourceFsPath, PROGRAM, 'utf8');

    const result = await runDiagnostics({
      compilerPath: 'fasm2',
      sourceFsPath,
      cwd: tmpDir,
      listingInclude: bundledListingIncPath(),
    });

    if (result.toolError) this.skip(); // no usable fasm2 on this machine
    assert.ok(result.listing, 'the compile should have produced a listing');

    const map = correlateListing(result.listing, buildCandidateSequence(sourceFsPath));
    const doc = TextDocument.create(URI.file(sourceFsPath).toString(), 'fasm', 1, PROGRAM);
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
    // Every byteLength that exists must be a positive count, never zero or NaN — a "0 bytes" hint
    // would be a claim the listing never made.
    for (const entry of entries) {
      if (entry.byteLength !== undefined) assert.ok(entry.byteLength > 0, `bad byteLength for ${entry.text}`);
    }
  });
});
