import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { parseDocument } from '../src/parser/symbolIndex';
import { SymbolKind } from '../src/types';

const FIXTURES = path.join(__dirname, 'fixtures');

describe('symbolIndex', () => {
  it('extracts labels, constants, includes and macro/struct blocks from a synthetic file', () => {
    const src = [
      'format binary',
      'ROWS = 23',
      'BACKGROUND equ 0',
      'include \'listing.inc\'',
      'start:',
      '\tmov eax, 1',
      '.loop:',
      '\tdec eax',
      '\tjnz .loop',
      'macro foo? a*,b*',
      '\tmov a,b',
      'end macro',
      'struct point',
      '\tx dd ?',
      '\ty dd ?',
      'ends',
      'label alias at start',
    ].join('\n');

    const doc = parseDocument('file:///synthetic.asm', 1, src, 'fasm2');

    const byName = (name: string) => doc.symbols.filter((s) => s.name === name);

    assert.strictEqual(byName('ROWS')[0].kind, SymbolKind.Constant);
    assert.strictEqual(byName('ROWS')[0].value, '23');
    assert.strictEqual(byName('BACKGROUND')[0].kind, SymbolKind.Constant);
    assert.strictEqual(byName('start')[0].kind, SymbolKind.Label);
    assert.strictEqual(byName('.loop')[0].kind, SymbolKind.LocalLabel);
    assert.strictEqual(byName('.loop')[0].parentLabel, 'start');
    assert.strictEqual(byName('foo')[0].kind, SymbolKind.Macro);
    assert.strictEqual(byName('foo')[0].params, 'a*,b*');
    assert.strictEqual(byName('point')[0].kind, SymbolKind.Struct);
    assert.strictEqual(byName('alias')[0].kind, SymbolKind.Label);
    assert.strictEqual(byName('alias')[0].value, 'start');

    assert.strictEqual(doc.includes.length, 1);
    assert.strictEqual(doc.includes[0].path, 'listing.inc');
    assert.strictEqual(doc.formatDirective, 'binary');
  });

  it('parses the real tetros.asm example without throwing and finds its known labels', () => {
    const src = fs.readFileSync(path.join(FIXTURES, 'tetros.asm'), 'utf8');
    const doc = parseDocument('file:///tetros.asm', 1, src, 'fasm2');

    const names = new Set(doc.symbols.map((s) => s.name));
    assert.ok(names.has('start'), 'expected "start" label to be indexed');
    assert.ok(names.has('ROWS'), 'expected ROWS constant to be indexed');
    assert.ok(doc.includes.some((i) => i.path === 'listing.inc'));
    assert.strictEqual(doc.formatDirective, "binary as 'img'");
  });

  it('excludes instruction mnemonics, registers, and directives from collected references', () => {
    const src = ['format binary', 'start:', '\tmov eax, sharedConst', '\tadd eax, ebx', '\tjnz start'].join('\n');
    const doc = parseDocument('file:///refs.asm', 1, src, 'fasm2');

    const refNames = doc.references.map((r) => r.name);
    for (const noise of ['mov', 'eax', 'ebx', 'add', 'jnz']) {
      assert.ok(!refNames.includes(noise), `expected "${noise}" to be filtered out of references, got: ${refNames.join(', ')}`);
    }
    // A genuine user symbol on the same lines must still come through.
    assert.ok(refNames.includes('sharedConst'));
    assert.ok(refNames.includes('start'));
  });

  it('tracks nested blocks correctly (struct inside a namespace, sibling macros)', () => {
    const src = [
      'namespace geometry',
      '  struct point',
      '    x dd ?',
      '    y dd ?',
      '  ends',
      '  macro make_point? x*, y*',
      '    dd x, y',
      '  end macro',
      'end namespace',
      'macro unrelated?',
      'end macro',
    ].join('\n');

    const doc = parseDocument('file:///nested.asm', 1, src, 'fasm2');
    const byName = (name: string) => doc.symbols.filter((s) => s.name === name);

    assert.strictEqual(byName('point').length, 1);
    assert.strictEqual(byName('make_point').length, 1);
    assert.strictEqual(byName('unrelated').length, 1);
  });

  it('does not pop the block stack on a mismatched end keyword', () => {
    // "end struct" doesn't correspond to how struct blocks close (that's bare "ends"), so it
    // must not be treated as closing the still-open struct.
    const src = ['struct point', '  x dd ?', 'end struct', 'ends'].join('\n');
    assert.doesNotThrow(() => parseDocument('file:///mismatched.asm', 1, src, 'fasm2'));
    const doc = parseDocument('file:///mismatched.asm', 1, src, 'fasm2');
    assert.strictEqual(doc.symbols.filter((s) => s.name === 'point').length, 1);
  });

  it('only records the first top-level format directive, and ignores one nested inside a block', () => {
    const src = ['format binary', 'format ELF64 executable 3', 'macro foo?', '  format PE console', 'end macro'].join('\n');
    const doc = parseDocument('file:///format.asm', 1, src, 'fasm2');
    assert.strictEqual(doc.formatDirective, 'binary');
  });

  it('leaves parentLabel undefined for a local label with no preceding global label', () => {
    const src = ['.orphan:', '\tnop'].join('\n');
    const doc = parseDocument('file:///orphan.asm', 1, src, 'fasm2');
    const orphan = doc.symbols.find((s) => s.name === '.orphan');
    assert.strictEqual(orphan?.kind, SymbolKind.LocalLabel);
    assert.strictEqual(orphan?.parentLabel, undefined);
  });

  it('handles a macro/struct declared with no parameters', () => {
    const src = ['macro noop?', '  nop', 'end macro', 'struct empty', 'ends'].join('\n');
    const doc = parseDocument('file:///noparams.asm', 1, src, 'fasm2');
    const macro = doc.symbols.find((s) => s.name === 'noop');
    const struct = doc.symbols.find((s) => s.name === 'empty');
    assert.strictEqual(macro?.params, undefined);
    assert.strictEqual(struct?.params, undefined);
  });

  it('keeps every definition when a constant is redefined rather than silently dropping earlier ones', () => {
    const src = ['SIZE = 1', 'SIZE = 2'].join('\n');
    const doc = parseDocument('file:///redefined.asm', 1, src, 'fasm2');
    const sizeDefs = doc.symbols.filter((s) => s.name === 'SIZE');
    assert.strictEqual(sizeDefs.length, 2);
    assert.strictEqual(sizeDefs[0].value, '1');
    assert.strictEqual(sizeDefs[1].value, '2');
  });

  it('never throws on malformed or pathological input', () => {
    const pathological = [
      'macro',
      'end',
      'struct',
      'ends ends ends',
      ':::: = = =',
      "'unterminated string",
      'include',
      '.orphan-local:',
    ].join('\n');

    assert.doesNotThrow(() => parseDocument('file:///bad.asm', 1, pathological, 'fasm2'));
  });
});
