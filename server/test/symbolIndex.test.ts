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

  it('recognizes ":=" and "=:" as constant-defining operators, distinct from plain "="', () => {
    // Mirrors real usage in fasmg's own packages/x86/include/macro/proc64.inc: "size :=
    // fastcall?.frame" (constant, exactly-once) and "fastcall?.frame =: 0" (preserves the
    // previous value, restorable with `restore`) sit right next to plain "=" assignments.
    const src = ['CONST := 1', 'VAR =: 2'].join('\n');
    const doc = parseDocument('file:///colonequals.asm', 1, src, 'fasm2');
    const byName = (name: string) => doc.symbols.filter((s) => s.name === name);

    assert.strictEqual(byName('CONST')[0].definedVia, ':=');
    assert.strictEqual(byName('CONST')[0].value, '1');
    assert.strictEqual(byName('VAR')[0].definedVia, '=:');
    assert.strictEqual(byName('VAR')[0].value, '2');
  });

  it('requires ":=" to have no space between the two characters, matching real fasmg (confirmed against the real compiler: "X : = 5" actually fails to assemble, parsed as label X then an invalid "= 5")', () => {
    const src = ['start:', 'X : = 1'].join('\n');
    const doc = parseDocument('file:///notcolonequals.asm', 1, src, 'fasm2');
    assert.strictEqual(doc.symbols.find((s) => s.name === 'start')?.kind, SymbolKind.Label);
    assert.strictEqual(doc.symbols.find((s) => s.name === 'X')?.kind, SymbolKind.Label);
  });

  it('recognizes "reequ" (discards the previous value, unlike "equ") as a constant definition', () => {
    const src = 'NAME reequ value';
    const doc = parseDocument('file:///reequ.asm', 1, src, 'fasm2');
    const sym = doc.symbols.find((s) => s.name === 'NAME');
    assert.strictEqual(sym?.definedVia, 'reequ');
    assert.strictEqual(sym?.value, 'value');
  });

  it('recognizes "define"/"redefine NAME EXPR" as constant definitions, extracting NAME (not the keyword) as the symbol', () => {
    // Mirrors fasmg's own proc64.inc: "define fastcall? fastcall" at the very top of the file.
    const src = ['define fastcall? fastcall', 'redefine var data'].join('\n');
    const doc = parseDocument('file:///define.asm', 1, src, 'fasm2');
    const byName = (name: string) => doc.symbols.filter((s) => s.name === name);

    assert.strictEqual(byName('fastcall').length, 1, 'expected the "?" suffix to be stripped, same as macro names');
    assert.strictEqual(byName('fastcall')[0].definedVia, 'define');
    assert.strictEqual(byName('fastcall')[0].value, 'fastcall');
    assert.strictEqual(byName('var')[0].definedVia, 'redefine');
  });

  it('strips a trailing "?" from a constant name defined via any operator, not just macro/struct names', () => {
    // The manual's own example: "xor?.mask? := 10101010b" — the same weak/overridable "?" suffix
    // convention macro names use also applies to symbolic constants.
    const src = 'xor?.mask? := 10101010b';
    const doc = parseDocument('file:///weakconst.asm', 1, src, 'fasm2');
    assert.strictEqual(doc.symbols.find((s) => s.name === 'xor?.mask')?.definedVia, ':=');
  });

  it('does not mistake a macro\'s "!" (unconditional-instruction marker) for a parameter', () => {
    // Mirrors fasmg's own proc64.inc: "macro endp?!" — endp is both weak ("?") and unconditional
    // ("!", evaluated even inside a suspended conditional block or another macro's definition,
    // per the manual's own "macro endp!" example). Neither suffix is a parameter.
    const src = 'macro endp?!\nend macro\n';
    const doc = parseDocument('file:///unconditional.asm', 1, src, 'fasm2');
    const macro = doc.symbols.find((s) => s.name === 'endp');
    assert.ok(macro, 'expected "endp" (not "endp?" or "endp?!") to be the indexed macro name');
    assert.strictEqual(macro?.params, undefined);
  });

  it('recovers from a macro that deliberately leaves a block open across invocations, instead of desyncing scope tracking for the rest of the file', () => {
    // Mirrors a real, confirmed pattern in fasmg's own proc64.inc: "initlocal" opens a `virtual
    // at` block it *deliberately* leaves unclosed (a later, separate macro closes it) — a
    // deferred-execution trick this parser can't understand, but it must not corrupt local-macro
    // scope tracking for everything that follows in the file.
    const src = [
      'macro initlocal',
      '\tvirtual at 0', // deliberately left open, closed by a *different* macro at invocation time
      'end macro',
      'macro locals',
      '\tlocal pointer',
      '\tpointer = 1',
      'end macro',
    ].join('\n');
    const doc = parseDocument('file:///deferredclose.asm', 1, src, 'fasm2');
    const pointerSym = doc.symbols.find((s) => s.name === 'pointer');
    assert.ok(pointerSym?.localScope, 'expected "pointer" to still get a localScope despite the stray unclosed virtual block before it');
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
