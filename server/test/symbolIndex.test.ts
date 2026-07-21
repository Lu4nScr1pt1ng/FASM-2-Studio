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

  it('indexes names declared via the "import" macro pattern (fasmg\'s api/kernel32.inc-style Windows imports), across a multi-line backslash-continued list', () => {
    // Mirrors the real, standard shape of fasmg's own packages/x86/include/api/kernel32.inc and
    // api/user32.inc: every imported OS function is declared this way rather than as a label, so
    // without recognizing this pattern a program that calls e.g. ExitProcess would have no known
    // definition at all — no hover, no go-to-definition — despite compiling perfectly.
    const src = [
      'import kernel32,\\',
      "       AddAtomA,'AddAtomA',\\",
      "       ExitProcess,'ExitProcess',\\",
      "       CreateWindowExA,'CreateWindowExA'",
      '',
      'invoke ExitProcess, 0',
    ].join('\n');

    const doc = parseDocument('file:///kernel32.inc', 1, src, 'fasm2');
    const byName = (name: string) => doc.symbols.filter((s) => s.name === name);

    assert.strictEqual(byName('AddAtomA').length, 1);
    assert.strictEqual(byName('AddAtomA')[0].kind, SymbolKind.Constant);
    assert.strictEqual(byName('ExitProcess').length, 1);
    assert.strictEqual(byName('CreateWindowExA').length, 1);
    // The library nickname operand right after "import" is not itself an imported function.
    assert.strictEqual(byName('kernel32').length, 0);
  });

  it('does not require a trailing backslash on the "import" line itself when the whole list fits on one line', () => {
    const src = "import user32,MessageBoxA,'MessageBoxA',MessageBoxW,'MessageBoxW'";
    const doc = parseDocument('file:///user32.inc', 1, src, 'fasm2');
    const byName = (name: string) => doc.symbols.filter((s) => s.name === name);

    assert.strictEqual(byName('MessageBoxA').length, 1);
    assert.strictEqual(byName('MessageBoxW').length, 1);
  });

  it('indexes the Mach-O/ELF "import NAME,\'string\'" shape too, which has no library-nickname operand', () => {
    // Mirrors fasmg's own packages/x86/examples/mach-o/demo_dynamic64.asm: `import printf,'_printf'`
    // — unlike the PE/Windows shape (a nickname first, then NAME,'string' pairs), the name to
    // import comes right after "import" itself.
    const src = ["import printf,'_printf'", "import exit,'_exit'"].join('\n');
    const doc = parseDocument('file:///demo_dynamic64.asm', 1, src, 'fasm2');
    const byName = (name: string) => doc.symbols.filter((s) => s.name === name);

    assert.strictEqual(byName('printf').length, 1);
    assert.strictEqual(byName('exit').length, 1);
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

  it('keeps a bare "?" macro name intact instead of stripping it down to an empty string', () => {
    // fasmg's own idiom for an anonymous macro is literally "macro ? args" (real examples:
    // packages/utility/struct.inc, packages/x86-2/x86-2.inc). baseName() strips a *trailing* "?"
    // used to mark an ordinary name overridable/weak (e.g. "foo?" -> "foo") — applying that same
    // rule to a name that IS just "?" turned it into "", which every consumer downstream treats
    // as "no symbol", and which VS Code's own DocumentSymbol validation rejects outright with
    // "name must not be falsy", crashing the whole textDocument/documentSymbol request.
    const src = ['macro ? line&', '\tline', 'end macro'].join('\n');
    const doc = parseDocument('file:///anonymous-macro.asm', 1, src, 'fasm2');
    const macro = doc.symbols.find((s) => s.kind === SymbolKind.Macro);
    assert.strictEqual(macro?.name, '?');
  });

  it('drops the inline "{" from params when a macro/struct body opens on the same line', () => {
    const src = ['macro push_all reg1, reg2 {', '\tpush reg1', '\tpush reg2', '}'].join('\n');
    const doc = parseDocument('file:///inlinebrace.asm', 1, src, 'fasm2');
    const macro = doc.symbols.find((s) => s.name === 'push_all');
    assert.strictEqual(macro?.params, 'reg1,reg2');
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
