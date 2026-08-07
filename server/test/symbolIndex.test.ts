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

  it('does not mistake a data directive for the name argument of "label NAME at EXPR", e.g. a macro\'s own parameter named "label" written back literally as "label dd ..."', () => {
    // Real, confirmed bug found validating fasmg's own packages/x86/include/macro/resource.inc's
    // "dialog" macro ("macro dialog label,title,... / label dd RVA data,size,0,0 / ...") and
    // macro/import64.inc's "import?" macro ("iterate <label,string>, definitions / ... / label dq
    // ..."): both shadow the "label" directive with a same-named macro parameter/loop variable, so
    // the body's own literal, unexpanded "label dd ..."/"label dq ..." reads exactly like this
    // parser's "label NAME at EXPR" directive handling naming "dd"/"dq" as the declared label —
    // stealing the data directive's own token and creating a bogus "dd"/"dq" label symbol, the same
    // bug class already fixed in the syntax-highlight grammar for this exact pair of real files.
    const src = 'format binary\nlabel dd RVA data,size,0,0\ndata dd 1\n';
    const doc = parseDocument('file:///synthetic.asm', 1, src, 'fasm2');
    assert.ok(!doc.symbols.some((s) => s.name === 'dd'), `"dd" must never be indexed as a label, got: ${JSON.stringify(doc.symbols.map((s) => s.name))}`);
    assert.strictEqual(doc.symbols.find((s) => s.name === 'data')?.kind, SymbolKind.Label);
  });

  it('still indexes a genuine "label NAME at EXPR" directive when the name is not a data directive', () => {
    const src = 'format binary\nstart:\nlabel alias at start\n';
    const doc = parseDocument('file:///synthetic.asm', 1, src, 'fasm2');
    const sym = doc.symbols.find((s) => s.name === 'alias');
    assert.strictEqual(sym?.kind, SymbolKind.Label);
    assert.strictEqual(sym?.value, 'start');
  });

  it('indexes a name containing "%" as one identifier, not splitting it into a shorter name plus a stray "%" token', () => {
    // Mirrors a real, confirmed bug: fasmg's own packages/x86/include/pcount/kernel32.inc defines
    // "BackupRead% =  7" -- fasmg's tokenization rule (manual.txt's "Fundamental syntax rules")
    // lists the small set of characters that are always their own token
    // (+-/*=<>()[]{}:?!,.|&~#\), and "%" is not among them, so this is a symbol literally named
    // "BackupRead%", not "BackupRead" followed by punctuation. Before fixing the tokenizer, this
    // line was never recognized as a constant definition at all.
    const src = 'format binary\nBackupRead% =  7\n';
    const doc = parseDocument('file:///synthetic.asm', 1, src, 'fasm2');
    const sym = doc.symbols.find((s) => s.name === 'BackupRead%');
    assert.ok(sym, `expected a symbol named "BackupRead%", got: ${JSON.stringify(doc.symbols.map((s) => s.name))}`);
    assert.strictEqual(sym.kind, SymbolKind.Constant);
    assert.strictEqual(sym.value, '7');
  });

  it('does not index a redefinition of a built-in pseudo-variable ("$%?", "%", ...) as an ordinary workspace-wide constant', () => {
    // Mirrors a real, confirmed bug: fasm2's own source/macos/macho.inc temporarily overrides the
    // built-in "$%" inside a "virtual at" trick: "$%? = $%?-($-address)" -- a real, documented way
    // to redefine a built-in (manual.txt: built-ins "are always case-insensitive and may be
    // redefined"). Registering "$%" as a plain constant here polluted hover's workspace-wide
    // fallback for every other file's genuine, unrelated use of the real "$%" built-in.
    const src = 'format binary\n$%? = $%?-($-address)\n';
    const doc = parseDocument('file:///synthetic.asm', 1, src, 'fasm2');
    const names = doc.symbols.map((s) => s.name);
    assert.ok(!names.includes('$%'), `expected no "$%" symbol to be indexed, got: ${JSON.stringify(names)}`);
  });

  it('indexes "struc NAME params ... end struc" (the core labeled-macroinstruction directive "struct" is itself built on) as a real symbol', () => {
    // Found while validating against manual.txt section 9 ("Labeled macroinstructions"): "struct"
    // (already indexed as SymbolKind.Struct) is documented as a friendlier macro built on top of
    // the core "struc" directive, but raw "struc" itself -- used directly in real code, e.g.
    // fasmg's own packages/x86/include/format/pe.inc -- had no SymbolDefinition at all.
    const src = 'format binary\nstruc mystruc arg\n\tdb arg\nend struc\n';
    const doc = parseDocument('file:///synthetic.asm', 1, src, 'fasm2');
    const sym = doc.symbols.find((s) => s.name === 'mystruc');
    assert.ok(sym, `expected a symbol named "mystruc", got: ${JSON.stringify(doc.symbols.map((s) => s.name))}`);
    assert.strictEqual(sym.params, 'arg');
  });

  it('"end struc" closes the struc\'s macro frame, so a later top-level constant is not scoped to it', () => {
    // "struc" opens the same kind of frame as "macro" (it can contain `local` declarations), but
    // the end-of-block handler used to pop the frame only for "macro"/"calminstruction" — after
    // any "end struc", every later definition in the file was silently attributed to the dead
    // frame, so a `local`-declared name in the struc could wrongly scope-capture an unrelated
    // same-named constant defined after it.
    const src = ['struc holder val', '\tlocal size', '\tsize = val', 'end struc', 'size = 99'].join('\n');
    const doc = parseDocument('file:///synthetic.asm', 1, src, 'fasm2');
    const after = doc.symbols.filter((s) => s.name === 'size' && s.range.startLine === 4);
    assert.strictEqual(after.length, 1);
    assert.strictEqual(after[0].localScope, undefined, 'a top-level constant after "end struc" must not inherit the struc\'s local scope');
    const inside = doc.symbols.find((s) => s.name === 'size' && s.range.startLine === 2);
    assert.ok(inside?.localScope, 'the `local` constant inside the struc body should still be scoped to it');
  });

  it('indexes "proc NAME params" (the standard proc32.inc/proc64.inc package) as a real Label symbol', () => {
    // Mirrors real usage across virtually every fasmg Windows program, e.g. fasm2's own
    // source/ide/windows/fasmgw.asm: "proc MainWindow hwnd,wmsg,wparam,lparam". The "proc?" macro's
    // own body does "match name declaration, statement : if used name / name: / namespace name" --
    // so this genuinely defines NAME as a real, callable label, exactly like writing "NAME:" by
    // hand. Before this, hover/go-to-definition/workspace-symbol-search found nothing for it.
    const src = 'format binary\nproc MainWindow hwnd,wmsg,wparam,lparam\n\tret\nendp\n';
    const doc = parseDocument('file:///synthetic.asm', 1, src, 'fasm2');
    const sym = doc.symbols.find((s) => s.name === 'MainWindow');
    assert.ok(sym, `expected a symbol named "MainWindow", got: ${JSON.stringify(doc.symbols.map((s) => s.name))}`);
    assert.strictEqual(sym.kind, SymbolKind.Label);
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

  it('indexes a struct field under both its bare name and its fully-qualified "StructName.field" name', () => {
    // Real-world scenario: fasmg's struct package (macro/struct.inc) wraps a struct's entire body
    // in "namespace <name>", so a field's real, canonically-referenced name from outside the
    // struct is always fully qualified (e.g. real code's own "[ebx+MatchedExcerpt.matcher]") --
    // hovering/go-to-definition on that qualified form found nothing at all before this, since
    // only the bare field name ("matcher") was ever indexed.
    const src = ['struct MatchedExcerpt', '\tmatcher dd ?', 'ends'].join('\n');
    const doc = parseDocument('file:///qualified-field.asm', 1, src, 'fasm2');

    const bare = doc.symbols.find((s) => s.name === 'matcher');
    assert.ok(bare, 'expected the bare field name to still be indexed');
    assert.strictEqual(bare?.isStructField, true);

    const qualified = doc.symbols.find((s) => s.name === 'MatchedExcerpt.matcher');
    assert.ok(qualified, 'expected the fully-qualified "MatchedExcerpt.matcher" name to also be indexed');
    assert.strictEqual(qualified?.isStructField, true);
    assert.strictEqual(qualified?.kind, SymbolKind.Label);
    // Same source position either way -- these are two names for the one real field, not two
    // unrelated definitions.
    assert.deepStrictEqual(qualified?.nameRange, bare?.nameRange);
  });

  it('two different structs sharing a same-named field never cross-resolve through their qualified names', () => {
    const src = ['struct Alpha', '\tflags dd ?', 'ends', 'struct Beta', '\tflags dd ?', 'ends'].join('\n');
    const doc = parseDocument('file:///cross-struct.asm', 1, src, 'fasm2');

    const alphaFlags = doc.symbols.find((s) => s.name === 'Alpha.flags');
    const betaFlags = doc.symbols.find((s) => s.name === 'Beta.flags');
    assert.ok(alphaFlags && betaFlags);
    assert.notDeepStrictEqual(alphaFlags?.nameRange, betaFlags?.nameRange);
    // Exactly one qualified symbol per struct -- not, say, both structs' fields cross-registered
    // under both qualified names.
    assert.strictEqual(doc.symbols.filter((s) => s.name === 'Alpha.flags').length, 1);
    assert.strictEqual(doc.symbols.filter((s) => s.name === 'Beta.flags').length, 1);
  });

  it('synthesizes a "sizeof.<StructName>" constant when a struct closes, matching fasmg\'s own auto-generated companion symbol', () => {
    // Confirmed against the real struct.inc source: closing the outermost struct does
    // "arrange sym, =sizeof.pname" / "publish sym, tmp" -- a real, separate symbol distinct from
    // the struct's own name, equal to its total byte size, used directly in real code (e.g.
    // "add esi, sizeof.RecognitionContext"). Nothing indexed this before, so hovering it found
    // nothing at all despite being one of the most common ways struct sizes are actually used.
    const src = ['struct RecognitionContext', '\tbase_namespace dd ?', 'ends'].join('\n');
    const doc = parseDocument('file:///sizeof.asm', 1, src, 'fasm2');

    const sizeofSym = doc.symbols.find((s) => s.name === 'sizeof.RecognitionContext');
    assert.ok(sizeofSym, `expected a "sizeof.RecognitionContext" symbol, got: ${JSON.stringify(doc.symbols.map((s) => s.name))}`);
    assert.strictEqual(sizeofSym?.kind, SymbolKind.Constant);
    assert.strictEqual(sizeofSym?.definedVia, 'struct-size');
    assert.strictEqual(sizeofSym?.value, 'RecognitionContext');
    // Points back at the struct's own name token -- the only actionable "definition" location,
    // since "sizeof.RecognitionContext" itself never appears literally in this source.
    const structSym = doc.symbols.find((s) => s.name === 'RecognitionContext' && s.kind === SymbolKind.Struct);
    assert.deepStrictEqual(sizeofSym?.nameRange, structSym?.nameRange);
  });

  it('only synthesizes "sizeof" for the outermost struct, not a nested anonymous sub-struct, and qualifies nested fields under the outer name', () => {
    // Real fasmg supports an anonymous nested "struct ... ends" inside a struct body (e.g. for a
    // packed union-like sub-layout) -- struct.inc's own collect? only reaches its "sizeof.pname"
    // publish once its nesting accumulator fully unwinds back to the outermost struct, so the
    // inner "ends" must not synthesize a "sizeof" of its own, and the nested field still belongs
    // to the *outer* struct's namespace, not some inner one.
    const src = ['struct Outer', '\tstruct', '\t\tinner dd ?', '\tends', 'ends'].join('\n');
    const doc = parseDocument('file:///nested-struct.asm', 1, src, 'fasm2');

    assert.strictEqual(doc.symbols.filter((s) => s.name?.startsWith('sizeof.')).length, 1);
    assert.ok(doc.symbols.some((s) => s.name === 'sizeof.Outer'));
    assert.ok(doc.symbols.some((s) => s.name === 'Outer.inner'), 'expected the nested field to qualify under the *outer* struct name');
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

  it('recognizes "load NAME[:size] from ADDRESS" as a constant definition', () => {
    // Mirrors fasmg's own proc64.inc: "load value:byte from area:pointer" inside "initlocal".
    const src = 'load value:byte from area:pointer';
    const doc = parseDocument('file:///load.asm', 1, src, 'fasm2');
    const sym = doc.symbols.find((s) => s.name === 'value');
    assert.strictEqual(sym?.definedVia, 'load');
    assert.match(sym!.value!, /area/);
    assert.match(sym!.value!, /pointer/);
  });

  it('recognizes "NAME::" as a distinct area label, scoped like any other local when declared inside a macro', () => {
    // Mirrors fasmg's own proc64.inc: "area::" inside "initlocal", used only to address `load`'s
    // AREA:offset addressing mode.
    const src = ['macro initlocal', '\tlocal area', '\tarea::', '\tdb 1', 'end macro'].join('\n');
    const doc = parseDocument('file:///arealabel.asm', 1, src, 'fasm2');
    const sym = doc.symbols.find((s) => s.name === 'area');
    assert.strictEqual(sym?.kind, SymbolKind.Label);
    assert.strictEqual(sym?.isAreaLabel, true);
    assert.ok(sym?.localScope, 'expected "area" to be scoped to the enclosing macro like any other local');
  });

  it('strips "?" from every dot-separated component of a constant name defined via any operator, not just macro/struct names', () => {
    // The manual's own example: "xor?.mask? := 10101010b" — the same weak/overridable "?" suffix
    // convention macro names use also applies independently to each part of a dotted symbolic
    // constant name.
    const src = 'xor?.mask? := 10101010b';
    const doc = parseDocument('file:///weakconst.asm', 1, src, 'fasm2');
    assert.strictEqual(doc.symbols.find((s) => s.name === 'xor.mask')?.definedVia, ':=');
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

  it('recognizes "calminstruction NAME params" as a symbol definition, same as "macro"', () => {
    // Mirrors fasmg's own packages/x86/include/cpu/8087.inc: "calminstruction fld? src*" — before
    // this, NO calminstruction anywhere (i.e. how virtually every real x86 instruction is
    // actually implemented) had any SymbolDefinition at all.
    const src = 'calminstruction fld? src*\n\tasm db 0D9h\nend calminstruction\n';
    const doc = parseDocument('file:///calminstr.asm', 1, src, 'fasm2');
    const sym = doc.symbols.find((s) => s.name === 'fld');
    assert.strictEqual(sym?.kind, SymbolKind.Macro);
    assert.strictEqual(sym?.params, 'src*');
    assert.strictEqual(sym?.isWeak, true);
  });

  it('extracts the bare command name from a calminstruction namespaced under "calminstruction." (extends the CALM command set)', () => {
    // Mirrors fasmg's own packages/x86/include/cpu/8086.inc: "calminstruction calminstruction?.xcall?
    // instruction*, arguments&" — invoked elsewhere as a bare "xcall", not "calminstruction.xcall".
    const src = 'calminstruction calminstruction?.xcall? instruction*, arguments&\nend calminstruction\n';
    const doc = parseDocument('file:///xcall.asm', 1, src, 'fasm2');
    assert.ok(doc.symbols.find((s) => s.name === 'xcall'), 'expected the bare "xcall" name to be indexed');
    assert.strictEqual(doc.symbols.find((s) => s.name === 'calminstruction.xcall'), undefined);
  });

  it('strips "?" from every dot-separated component of a name, not just the last one', () => {
    // Mirrors fasmg's own proc64.inc: "macro end?.frame?" — both "end" and "frame" are
    // independently weak/overridable.
    const src = 'macro end?.frame?\nend macro\n';
    const doc = parseDocument('file:///dotweak.asm', 1, src, 'fasm2');
    assert.ok(doc.symbols.find((s) => s.name === 'end.frame'), 'expected "end.frame" (both components stripped), not "end?.frame"');
  });

  it('scopes a `local` variable declared inside a calminstruction body the same way as inside a macro', () => {
    // Mirrors fasmg's own 8087.inc: "calminstruction x87.parse_operand#context operand" declares
    // "local i" and uses it within its own body only.
    const src = ['calminstruction x87.parse_operand operand', '\tlocal i', '\ti = 1', 'end calminstruction'].join('\n');
    const doc = parseDocument('file:///calmlocal.asm', 1, src, 'fasm2');
    const sym = doc.symbols.find((s) => s.name === 'i');
    assert.ok(sym?.localScope, 'expected "i" to be scoped to the enclosing calminstruction');
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

  // --- element / repeat expansion -------------------------------------------------------------
  // fasmg instruction-set packages declare their register names with `element`, usually generated
  // in bulk inside a `repeat` -- so the names a programmer actually writes appear nowhere literally
  // in the source. Real shape, from fasmg's own packages/aarch64/iset/aarch64.inc.

  it('indexes a plain `element` declaration', () => {
    const doc = parseDocument('file:///e.inc', 1, 'element xzr : aarch64.reg + (31 shl 0)\n', 'fasm2');
    const sym = doc.symbols.find((s) => s.name === 'xzr');
    assert.ok(sym, 'expected "xzr" to be indexed');
    assert.strictEqual(sym.kind, SymbolKind.Constant);
  });

  it('expands `element NAME#i` inside `repeat N, i:0` into the concrete generated names', () => {
    const src = ['repeat 31, i:0', '    element x#i : aarch64.reg + (i shl 0)', 'end repeat'].join('\n');
    const names = new Set(parseDocument('file:///e.inc', 1, src, 'fasm2').symbols.map((s) => s.name));

    assert.ok(names.has('x0'), 'expected the first generated name');
    assert.ok(names.has('x30'), 'expected the last generated name');
    // "repeat 31, i:0" runs i = 0..30, so x31 must not exist -- aarch64 genuinely has no x31.
    assert.ok(!names.has('x31'), 'expected the count to be exclusive of start+count');
  });

  it('substitutes the loop counter into the value shown for a generated element', () => {
    const src = ['repeat 4, i:0', '    element x#i : base + (i shl 8)', 'end repeat'].join('\n');
    const doc = parseDocument('file:///e.inc', 1, src, 'fasm2');
    const x2 = doc.symbols.find((s) => s.name === 'x2');
    assert.ok(x2, 'expected "x2" to be generated');
    // Without substitution this read "base + ( i shl 8 )", showing a variable that is nowhere in
    // scope at the point the register is actually used.
    assert.match(x2.value ?? '', /2 shl 8/);
    assert.doesNotMatch(x2.value ?? '', /\bi\b/);
  });

  it('honours a non-zero start value', () => {
    const src = ['repeat 3, n:5', '    element r#n : n', 'end repeat'].join('\n');
    const names = new Set(parseDocument('file:///e.inc', 1, src, 'fasm2').symbols.map((s) => s.name));
    assert.deepStrictEqual([...names].filter((n) => n.startsWith('r')).sort(), ['r5', 'r6', 'r7']);
  });

  it('leaves a `repeat` whose count is not a literal alone, since its iterations are unknowable here', () => {
    const src = ['repeat COUNT, i:0', '    element x#i : i', 'end repeat'].join('\n');
    const names = new Set(parseDocument('file:///e.inc', 1, src, 'fasm2').symbols.map((s) => s.name));
    assert.ok(!names.has('x0'), 'expected no expansion without a literal count');
  });

  it('still records references on a `repeat` line, so a named count is findable', () => {
    const doc = parseDocument('file:///e.inc', 1, 'repeat COUNT, i:0\nend repeat\n', 'fasm2');
    assert.ok(doc.references.some((r) => r.name === 'COUNT'), 'expected "COUNT" to be collected as a reference');
  });

  it('refuses to expand an implausibly long `repeat`, which generates data rather than register names', () => {
    const src = ['repeat 100000, i:0', '    element x#i : i', 'end repeat'].join('\n');
    const doc = parseDocument('file:///e.inc', 1, src, 'fasm2');
    assert.ok(doc.symbols.length < 100, 'expected an over-long repeat to be skipped, not expanded');
  });

  // --- iterate expansion ---------------------------------------------------------------------
  // The other bulk-definition idiom: name the macro after the loop variable, so whole instruction
  // families exist without any of their names appearing literally. fasmg's own 8086.inc declares
  // all 30 conditional jumps this way.

  it('expands a macro named after a single-variable `iterate`', () => {
    const src = ['iterate instr, alpha, beta, gamma', '\tmacro instr dest*', '\tend macro', 'end iterate'].join('\n');
    const names = new Set(parseDocument('file:///i.inc', 1, src, 'fasm2').symbols.map((s) => s.name));
    assert.deepStrictEqual([...names].sort(), ['alpha', 'beta', 'gamma']);
  });

  it('expands the destructuring `iterate <instr,opcode>, name,value, ...` form', () => {
    const src = ['iterate <instr,opcode>, jo,70h, jno,71h, jc,72h', '\tcalminstruction instr? dest*', '\tend calminstruction', 'end iterate'].join('\n');
    const names = new Set(parseDocument('file:///i.inc', 1, src, 'fasm2').symbols.map((s) => s.name));

    assert.ok(names.has('jo'));
    assert.ok(names.has('jno'));
    assert.ok(names.has('jc'));
    // The opcodes are the *other* variable's values and must never become macro names.
    assert.ok(!names.has('70h'), 'expected opcodes not to be mistaken for instruction names');
  });

  it('strips the weak "?" marker when matching the loop variable', () => {
    // "calminstruction instr? dest*" is how 8086.inc really writes it; without stripping the "?"
    // the variable goes unrecognized and the whole family stays undefined.
    const src = ['iterate <instr,op>, aaa,1, bbb,2', '\tcalminstruction instr? dest*', '\tend calminstruction', 'end iterate'].join('\n');
    const names = new Set(parseDocument('file:///i.inc', 1, src, 'fasm2').symbols.map((s) => s.name));
    assert.ok(names.has('aaa') && names.has('bbb'));
  });

  it('concatenates a suffix onto the loop variable (`macro instr#ps?`)', () => {
    const src = ['iterate <instr,ext>, sqrt,51h, add,58h', '\tmacro instr#ps? dest*,src*', '\tend macro', 'end iterate'].join('\n');
    const names = new Set(parseDocument('file:///i.inc', 1, src, 'fasm2').symbols.map((s) => s.name));
    assert.ok(names.has('sqrtps'), 'expected the suffix to be appended');
    assert.ok(names.has('addps'));
    assert.ok(!names.has('sqrt'), 'the bare loop value is not itself a declared name here');
  });

  it('concatenates a prefix onto the loop variable (`macro uint#N`)', () => {
    const src = ['iterate N, 8,16,32', '\tmacro uint#N value', '\tend macro', 'end iterate'].join('\n');
    const names = new Set(parseDocument('file:///i.inc', 1, src, 'fasm2').symbols.map((s) => s.name));
    assert.deepStrictEqual([...names].sort(), ['uint16', 'uint32', 'uint8']);
  });

  it('joins an `iterate` header wrapped across lines with a trailing backslash', () => {
    // 8086.inc splits its 30-entry conditional-jump table over two physical lines.
    const src = ['iterate <instr,opcode>, jo,70h, jno,71h, \\', '\t\tjs,78h, jns,79h', '\tcalminstruction instr? dest*', '\tend calminstruction', 'end iterate'].join('\n');
    const names = new Set(parseDocument('file:///i.inc', 1, src, 'fasm2').symbols.map((s) => s.name));
    assert.ok(names.has('jo'), 'expected names from the first line');
    assert.ok(names.has('jns'), 'expected names from the continued line');
  });

  it('does not expand an `iterate` whose list is a variable rather than literal values', () => {
    // "iterate arg, args" gets its values only once macros are expanded, which this parser never
    // does -- inventing a macro literally named "args" would be pure noise.
    const src = ['macro outer args&', '\titerate arg, args', '\t\tmacro arg', '\t\tend macro', '\tend iterate', 'end macro'].join('\n');
    const names = new Set(parseDocument('file:///i.inc', 1, src, 'fasm2').symbols.map((s) => s.name));
    assert.ok(!names.has('args'), `expected no bogus name from a variable list, got: ${[...names].join(', ')}`);
  });

  it('closes the loop at `end iterate`, so a later macro is not expanded against it', () => {
    const src = ['iterate instr, alpha, beta', '\tmacro instr', '\tend macro', 'end iterate', 'macro instr', 'end macro'].join('\n');
    const syms = parseDocument('file:///i.inc', 1, src, 'fasm2').symbols.map((s) => s.name);
    assert.ok(syms.includes('instr'), 'the macro after "end iterate" keeps its own literal name');
  });

  it('refuses to expand an implausibly long value list', () => {
    const values = Array.from({ length: 400 }, (_, i) => `v${i}`).join(', ');
    const src = [`iterate instr, ${values}`, '\tmacro instr', '\tend macro', 'end iterate'].join('\n');
    const syms = parseDocument('file:///i.inc', 1, src, 'fasm2').symbols;
    assert.ok(syms.length < 100, 'expected an over-long list to be skipped, not expanded');
  });

  it('does not read English prose beginning with the word "element" as a declaration', () => {
    // Real, from KolibriOS's programs/develop/libraries/libGUI/SRC/malloc.inc, which carries a
    // ported dlmalloc doc comment. A declaration is always "element NAME", "element NAME : expr"
    // or "element NAME#i : expr" -- the name is the whole line or is followed by ":".
    const prose = 'element may have a different size, and also that it does not\n';
    const names = parseDocument('file:///prose.inc', 1, prose, 'fasm1').symbols.map((s) => s.name);
    assert.ok(!names.includes('may'), `expected no symbol from prose, got: ${names.join(', ')}`);
  });

  it('accepts every real `element` shape found in fasmg\'s own packages', () => {
    const src = [
      'element aarch64.reg', // bare
      'element @', // bare, punctuation-ish name
      'element ah? : x86.r8 + 4', // weak marker + value
    ].join('\n');
    const names = new Set(parseDocument('file:///e.inc', 1, src, 'fasm2').symbols.map((s) => s.name));
    assert.ok(names.has('aarch64.reg'));
    assert.ok(names.has('@'));
    assert.ok(names.has('ah'));
  });

  it('does not expand when the concatenated variable belongs to no enclosing repeat', () => {
    const names = new Set(parseDocument('file:///e.inc', 1, 'element x#j : 0\n', 'fasm2').symbols.map((s) => s.name));
    assert.ok(!names.has('x0'));
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
