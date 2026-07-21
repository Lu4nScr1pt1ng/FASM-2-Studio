// Real TextMate tokenization tests for syntaxes/fasm.tmLanguage.json, using the same engine
// (vscode-textmate/vscode-oniguruma) VS Code itself uses — not just visual inspection of the
// grammar JSON, which looks plausible without actually proving how patterns interact once loaded.
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as oniguruma from 'vscode-oniguruma';
import * as vsctm from 'vscode-textmate';

const GRAMMAR_PATH = path.join(__dirname, '..', '..', 'syntaxes', 'fasm.tmLanguage.json');
const INSTRUCTIONS_PATH = path.join(__dirname, '..', '..', '..', 'server', 'src', 'data', 'instructions.json');
const DIRECTIVES_PATH = path.join(__dirname, '..', '..', '..', 'server', 'src', 'data', 'directives.json');

let registryPromise: Promise<vsctm.Registry> | undefined;

function getRegistry(): Promise<vsctm.Registry> {
  if (!registryPromise) {
    registryPromise = (async () => {
      const wasmBin = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'node_modules', 'vscode-oniguruma', 'release', 'onig.wasm')).buffer;
      await oniguruma.loadWASM(wasmBin);
      const onigLib = Promise.resolve({
        createOnigScanner: (patterns: string[]) => new oniguruma.OnigScanner(patterns),
        createOnigString: (s: string) => new oniguruma.OnigString(s),
      });
      return new vsctm.Registry({
        onigLib,
        loadGrammar: async (scopeName: string) => {
          if (scopeName !== 'source.fasm') return null;
          return vsctm.parseRawGrammar(fs.readFileSync(GRAMMAR_PATH, 'utf8'), GRAMMAR_PATH);
        },
      });
    })();
  }
  return registryPromise;
}

/** Tokenizes every line of `source` in sequence (carrying rule state across lines, as VS Code
 * does), returning each line's tokens with their resolved scope lists. */
async function tokenizeLines(source: string): Promise<Array<Array<{ text: string; scopes: string[] }>>> {
  const registry = await getRegistry();
  const grammar = await registry.loadGrammar('source.fasm');
  assert.ok(grammar, 'expected the fasm grammar to load');

  let ruleStack = vsctm.INITIAL;
  const lines = source.split('\n');
  return lines.map((line) => {
    const result = grammar!.tokenizeLine(line, ruleStack);
    ruleStack = result.ruleStack;
    return result.tokens.map((t) => ({ text: line.slice(t.startIndex, t.endIndex), scopes: t.scopes }));
  });
}

function scopesOf(tokens: Array<{ text: string; scopes: string[] }>, text: string): string[] {
  const found = tokens.find((t) => t.text === text);
  assert.ok(found, `expected a token with text ${JSON.stringify(text)}, got: ${JSON.stringify(tokens.map((t) => t.text))}`);
  return found.scopes;
}

describe('fasm TextMate grammar', () => {
  it('tags a struct field name as a member, not as the unrelated directive/keyword it happens to spell', async function () {
    // Mirrors a real bug found in fasmg's own packages/x86/projects/challenger/challenger.asm:
    // `struct PLANE_POINTER` declares fields named "segment" and "offset" — both of which are
    // otherwise-reserved words (the "segment" format directive; "offset" a common assembly term)
    // that must not be highlighted as if they were keywords here.
    this.timeout(10000);
    const src = ['struct PLANE_POINTER', '  segment   dd ?', '  offset    dd ?', '  x         dd ?', 'ends'].join('\n');
    const lines = await tokenizeLines(src);

    const structScopes = scopesOf(lines[0], 'struct');
    assert.ok(structScopes.some((s) => s.startsWith('keyword.control')), `expected "struct" to be a keyword, got: ${structScopes}`);

    const segmentScopes = scopesOf(lines[1], 'segment');
    assert.ok(segmentScopes.some((s) => s.startsWith('variable.other.member')), `expected "segment" to be a struct member, got: ${segmentScopes}`);
    assert.ok(!segmentScopes.some((s) => s.includes('directive') || s.includes('format')), `"segment" must not also be tagged as a directive/format keyword, got: ${segmentScopes}`);

    const offsetScopes = scopesOf(lines[2], 'offset');
    assert.ok(offsetScopes.some((s) => s.startsWith('variable.other.member')), `expected "offset" to be a struct member, got: ${offsetScopes}`);

    // The data directive after a field name is still recognized as one.
    const ddScopes = scopesOf(lines[1], 'dd');
    assert.ok(ddScopes.some((s) => s.startsWith('storage.type')), `expected "dd" to still be tagged as a data directive inside the struct body, got: ${ddScopes}`);

    const endsScopes = scopesOf(lines[4], 'ends');
    assert.ok(endsScopes.some((s) => s.startsWith('keyword.control')), `expected "ends" to be a keyword, got: ${endsScopes}`);
  });

  it('still tags "segment" as a format directive/keyword outside any struct body', async function () {
    this.timeout(10000);
    const lines = await tokenizeLines("segment '.data' data readable writeable\n");
    const scopes = scopesOf(lines[0], 'segment');
    assert.ok(scopes.some((s) => s.includes('directive')), `expected "segment" outside a struct to still be a directive, got: ${scopes}`);
  });

  it('only tags format-keywords (PE, GUI, console, at, on, ...) inside an actual "format ..." directive line, not wherever the same word appears', async function () {
    // Mirrors a real bug found in fasmg's own packages/x86/include/win32wx.inc:
    // "if ~ definite PE & ~ definite x86.mode" tests whether the ordinary symbol "PE" has been
    // defined -- unrelated to the "format PE ..." directive's own "PE" keyword, which must not
    // light up here just because it spells the same word.
    this.timeout(10000);
    const lines = await tokenizeLines(['if ~ definite PE & ~ definite x86.mode', '\tformat PE GUI 4.0', 'PE = 5', 'mov eax,PE'].join('\n'));

    const bareToken = lines[0].find((t) => t.text.includes('PE'));
    assert.ok(bareToken, `expected a token containing "PE", got: ${JSON.stringify(lines[0].map((t) => t.text))}`);
    assert.ok(!bareToken.scopes.some((s) => s.includes('format')), `"PE" used as an ordinary symbol must not be tagged as a format keyword, got: ${bareToken.scopes}`);

    const formatScopes = scopesOf(lines[1], 'PE');
    assert.ok(formatScopes.some((s) => s.includes('format')), `"PE" inside "format PE GUI 4.0" must still be tagged as a format keyword, got: ${formatScopes}`);
    const guiScopes = scopesOf(lines[1], 'GUI');
    assert.ok(guiScopes.some((s) => s.includes('format')), `"GUI" inside "format PE GUI 4.0" must still be tagged as a format keyword, got: ${guiScopes}`);

    const constScopes = scopesOf(lines[2], 'PE');
    assert.ok(!constScopes.some((s) => s.includes('format')), `"PE" being defined as a constant must not be tagged as a format keyword, got: ${constScopes}`);

    const operandToken = lines[3].find((t) => t.text.includes('PE'));
    assert.ok(operandToken, `expected a token containing "PE", got: ${JSON.stringify(lines[3].map((t) => t.text))}`);
    assert.ok(!operandToken.scopes.some((s) => s.includes('format')), `"PE" used as an instruction operand must not be tagged as a format keyword, got: ${operandToken.scopes}`);
  });

  it('tags data-declaring directives (db/dw/dd/...) with the storage.type family, same as size specifiers', async function () {
    this.timeout(10000);
    const lines = await tokenizeLines('msg db "hi",0\n');
    const scopes = scopesOf(lines[0], 'db');
    assert.ok(scopes.some((s) => s === 'storage.type.data.fasm'), `expected "db" to be storage.type.data.fasm, got: ${scopes}`);
  });

  it('tags CALM sub-language commands distinctly from ordinary directives and instructions', async function () {
    // Mirrors fasmg's own real calminstruction bodies (e.g. packages/x86/include/cpu/x86.inc):
    // match/check/emit/jyes/exit are CALM commands, a genuinely different sublanguage from both
    // regular directives and x86 mnemonics — hover already tags them as "CALM command" distinctly;
    // the grammar should color them distinctly too instead of lumping them in as generic keywords.
    this.timeout(10000);
    const lines = await tokenizeLines('calminstruction foo?\n\tmatch a,b\n\tcheck a eq b\n\tjyes done\n\temit 1\n\texit\n    done:\nend calminstruction\n');
    for (const [lineIdx, word] of [[0, 'calminstruction'], [1, 'match'], [2, 'check'], [3, 'jyes'], [4, 'emit'], [5, 'exit']] as const) {
      const scopes = scopesOf(lines[lineIdx], word);
      assert.strictEqual(scopes[scopes.length - 1], 'keyword.other.calm.fasm', `expected "${word}" to be a CALM command, got: ${scopes}`);
    }
  });

  it('does not steal "call" or "jno" from the real x86 instructions of the same name, despite both also being CALM commands', async function () {
    this.timeout(10000);
    const lines = await tokenizeLines('\tcall my_function\n\tjno .skip\n');
    const callScopes = scopesOf(lines[0], 'call');
    assert.strictEqual(callScopes[callScopes.length - 1], 'keyword.other.mnemonic.fasm', `expected "call" to stay a mnemonic, got: ${callScopes}`);
    const jnoScopes = scopesOf(lines[1], 'jno');
    assert.strictEqual(jnoScopes[jnoScopes.length - 1], 'keyword.other.mnemonic.fasm', `expected "jno" to stay a mnemonic, got: ${jnoScopes}`);
  });

  it('tags ":=", "=:", and "reequ" as constant-defining operators/directives, distinct from plain "="', async function () {
    this.timeout(10000);
    const lines = await tokenizeLines('size := fastcall\nold =: 5\nc reequ 3\n');

    const colonEqualsScopes = scopesOf(lines[0], ':=');
    assert.strictEqual(colonEqualsScopes[colonEqualsScopes.length - 1], 'keyword.operator.assignment.fasm');
    assert.ok(scopesOf(lines[0], 'size').some((s) => s.startsWith('variable.other.constant')));

    const equalsColonScopes = scopesOf(lines[1], '=:');
    assert.strictEqual(equalsColonScopes[equalsColonScopes.length - 1], 'keyword.operator.assignment.fasm');

    const reequScopes = scopesOf(lines[2], 'reequ');
    assert.ok(reequScopes.some((s) => s.includes('directive')), `expected "reequ" to be a directive, got: ${reequScopes}`);
  });

  it('tags the built-in "$"/"$$"/"$@"/"%"/"%%" pseudo-variables distinctly, without misreading them as generic operators', async function () {
    // Mirrors a real snippet from fasmg's own proc64.inc (prologuedef): "if % = %% / fill :=
    // 8*(% and 1)" — easy to misread as operator soup without dedicated tagging.
    this.timeout(10000);
    const lines = await tokenizeLines(['if % = %%', 'fill := 8*(% and 1)', 'size = $ - $$', 'base = $@'].join('\n'));

    for (const [lineIdx, word] of [[0, '%'], [0, '%%'], [1, '%'], [2, '$'], [2, '$$'], [3, '$@']] as const) {
      const scopes = scopesOf(lines[lineIdx], word);
      assert.strictEqual(scopes[scopes.length - 1], 'variable.language.special.fasm', `expected "${word}" to be a built-in special symbol, got: ${scopes}`);
    }
  });

  it('tags "$%"/"$%%" (output-file offset) as their own built-in symbol, not as bare "$" plus a stray "%"', async function () {
    // Mirrors real usage in fasm2's own source/macos/macho.inc: "$%? = $%?-($-address)".
    this.timeout(10000);
    const lines = await tokenizeLines(['rb 10 - ($%)', 'x = $%%'].join('\n'));
    const dollarPercentScopes = scopesOf(lines[0], '$%');
    assert.strictEqual(dollarPercentScopes[dollarPercentScopes.length - 1], 'variable.language.special.fasm', `expected "$%" to be tagged as a single built-in symbol, got: ${dollarPercentScopes}`);
    const dollarPercentPercentScopes = scopesOf(lines[1], '$%%');
    assert.strictEqual(dollarPercentPercentScopes[dollarPercentPercentScopes.length - 1], 'variable.language.special.fasm', `expected "$%%" to be tagged as a single built-in symbol, got: ${dollarPercentPercentScopes}`);
  });

  it('does not mistake fasmg\'s "$1A"-style dollar-prefixed hex literal for the "$" current-address symbol', async function () {
    this.timeout(10000);
    const lines = await tokenizeLines('n = $1A\n');
    const scopes = scopesOf(lines[0], '$1A');
    assert.strictEqual(scopes[scopes.length - 1], 'constant.numeric.hex.fasm', `expected "$1A" to be a hex number, got: ${scopes}`);
  });

  it('tags a single quote used as a digit separator/padding as part of the number, not as an unrelated string start', async function () {
    // Mirrors manual.txt's "Fundamental syntax rules": "the numbers are also allowed to contain
    // underscores or single quotes to act as a separator or padding" (e.g. "1'000'000") -- a real,
    // confirmed conflict risk since "'" is otherwise the string-quote character. Before this fix,
    // "1'000'000" split into Number("1") + String("'000'") + Number("000"), and worse, a number
    // with an *odd* count of embedded quotes would open an unterminated string that corrupts
    // highlighting for the rest of the file (TextMate string begin/end state persists across lines).
    this.timeout(10000);
    const lines = await tokenizeLines(["big = 1'000'000", "s = 'hello' ; still a real string"].join('\n'));
    const scopes = scopesOf(lines[0], "1'000'000");
    assert.strictEqual(scopes[scopes.length - 1], 'constant.numeric.decimal.fasm', `expected "1'000'000" to be a single decimal number, got: ${scopes}`);
    const strScopes = scopesOf(lines[1], 'hello');
    assert.strictEqual(strScopes[strScopes.length - 1], 'string.quoted.single.fasm', `expected a real quoted string to still work, got: ${strScopes}`);
  });

  it('tags decimal "d" suffix and the two dot-less float forms ("5e10" and "5f") that manual.txt documents', async function () {
    // manual.txt's "Expression values"/"Fundamental syntax rules": a plain decimal number may end
    // with "d" (analogous to "h"/"b"/"o"/"q" on the other bases); a float may be marked by an
    // exponent alone with no "." ("5e10"), or, lacking both "." and "e", only a trailing "f" marks
    // it as floating-point at all ("5f") -- none of these three previously matched any pattern.
    this.timeout(10000);
    const lines = await tokenizeLines(['n = 123d', 'x = 5e10', 'y = 5f'].join('\n'));
    const dScopes = scopesOf(lines[0], '123d');
    assert.strictEqual(dScopes[dScopes.length - 1], 'constant.numeric.decimal.fasm', `expected "123d" to be one decimal token, got: ${dScopes}`);
    const eScopes = scopesOf(lines[1], '5e10');
    assert.strictEqual(eScopes[eScopes.length - 1], 'constant.numeric.float.fasm', `expected "5e10" to be a float, got: ${eScopes}`);
    const fScopes = scopesOf(lines[2], '5f');
    assert.strictEqual(fScopes[fScopes.length - 1], 'constant.numeric.float.fasm', `expected "5f" to be a float, got: ${fScopes}`);
  });

  it('tags "load NAME:size from ADDRESS" and "::" area labels, mirroring proc64.inc\'s "load value:byte from area:pointer"', async function () {
    this.timeout(10000);
    const lines = await tokenizeLines(['load value:byte from area:pointer', 'area::'].join('\n'));

    const loadScopes = scopesOf(lines[0], 'load');
    assert.ok(loadScopes.some((s) => s.includes('directive')), `expected "load" to be a directive, got: ${loadScopes}`);
    const valueScopes = scopesOf(lines[0], 'value');
    assert.ok(valueScopes.some((s) => s.startsWith('variable.other.constant')), `expected "value" to be a constant, got: ${valueScopes}`);
    const fromScopes = scopesOf(lines[0], 'from');
    assert.ok(fromScopes.some((s) => s.includes('directive')), `expected "from" to be a directive, got: ${fromScopes}`);

    const areaScopes = scopesOf(lines[1], 'area');
    assert.ok(areaScopes.some((s) => s.startsWith('entity.name.label')), `expected "area" to be a label, got: ${areaScopes}`);
    const colonsScopes = scopesOf(lines[1], '::');
    assert.ok(colonsScopes.some((s) => s.includes('punctuation')), `expected "::" to be styled, got: ${colonsScopes}`);
  });

  it('tags "define NAME"/"redefine NAME" as a constant, including a dotted weak name, mirroring win32wx.inc\'s "define _winx.code? _code"', async function () {
    this.timeout(10000);
    const lines = await tokenizeLines(['define _winx', 'define _winx.code? _code', 'redefine foo 5'].join('\n'));

    const defineScopes = scopesOf(lines[0], 'define');
    assert.ok(defineScopes.some((s) => s.includes('directive')), `expected "define" to be a directive, got: ${defineScopes}`);
    const bareNameScopes = scopesOf(lines[0], '_winx');
    assert.strictEqual(bareNameScopes[bareNameScopes.length - 1], 'variable.other.constant.fasm', `expected "_winx" to be a constant, got: ${bareNameScopes}`);

    // The whole dotted+weak name is one token/scope, not split across #member-access.
    const dottedScopes = scopesOf(lines[1], '_winx.code?');
    assert.strictEqual(dottedScopes[dottedScopes.length - 1], 'variable.other.constant.fasm', `expected "_winx.code?" to be a single constant token, got: ${dottedScopes}`);

    const redefineScopes = scopesOf(lines[2], 'redefine');
    assert.ok(redefineScopes.some((s) => s.includes('directive')), `expected "redefine" to be a directive, got: ${redefineScopes}`);
    const fooScopes = scopesOf(lines[2], 'foo');
    assert.strictEqual(fooScopes[fooScopes.length - 1], 'variable.other.constant.fasm', `expected "foo" to be a constant, got: ${fooScopes}`);
  });

  it('tags names after "purge" as plain names being un-defined, not as the keywords/size-specifiers they happen to spell', async function () {
    // Mirrors fasmg's own proc64.inc: "purge ?, dword?,qword?" purges macro names generated by
    // its own "locals?" macro — "dword?"/"qword?" are not the storage-size keywords here.
    this.timeout(10000);
    const lines = await tokenizeLines('purge ?, dword?,qword?\n');
    for (const word of ['?', 'dword?', 'qword?']) {
      const scopes = scopesOf(lines[0], word);
      assert.strictEqual(scopes[scopes.length - 1], 'entity.name.function.fasm', `expected "${word}" to be a plain purged name, got: ${scopes}`);
    }
  });

  it('tags a struct field reference (IDENT.field, no space) as a member even when the field name spells a real directive', async function () {
    // Mirrors real usage in fasmg's own packages/x86/projects/challenger/challenger.asm:
    // "PLANE_POINTER.offset" and "PLANE_POINTER.segment" are field accesses, not the "segment"
    // format directive — but the struct-body fix only covered the field's own declaration site,
    // not references to it elsewhere in the file (including inside a "[...]" memory operand).
    this.timeout(10000);
    const lines = await tokenizeLines(['mov esi,[ebx+PLANE_POINTER.segment]', 'mov eax,[ebx+PLANE_POINTER.offset]', 'sub ecx,SEGMENT_SIZE'].join('\n'));

    const segmentScopes = scopesOf(lines[0], 'segment');
    assert.strictEqual(segmentScopes[segmentScopes.length - 1], 'variable.other.member.fasm', `expected "PLANE_POINTER.segment" to tag "segment" as a member, got: ${segmentScopes}`);
    const dotScopes = scopesOf(lines[0], '.');
    assert.strictEqual(dotScopes[dotScopes.length - 1], 'punctuation.accessor.fasm', `expected the "." to be styled as an accessor, got: ${dotScopes}`);

    const offsetScopes = scopesOf(lines[1], 'offset');
    assert.strictEqual(offsetScopes[offsetScopes.length - 1], 'variable.other.member.fasm', `expected "PLANE_POINTER.offset" to tag "offset" as a member, got: ${offsetScopes}`);

    // A plain identifier that merely contains the word "segment" (glued with no word boundary)
    // must stay untouched by both this rule and the directive keyword rule — it never gets its
    // own token at all (no rule claims it), so it's folded into its neighboring punctuation.
    const constToken = lines[2].find((t) => t.text.includes('SEGMENT_SIZE'));
    assert.ok(constToken, `expected a token containing "SEGMENT_SIZE", got: ${JSON.stringify(lines[2].map((t) => t.text))}`);
    assert.ok(!constToken.scopes.some((s) => s.includes('directive') || s.includes('member')), `"SEGMENT_SIZE" must not be tagged as a directive or member, got: ${constToken.scopes}`);
  });

  it('tags the proc/invoke macro family from the standard proc32.inc/proc64.inc package as support.function, distinct from core directives', async function () {
    // These are ordinary macros (e.g. "macro invoke?: proc*,args&" in fasmg's own
    // packages/x86/include/macro/proc64.inc), not core-language keywords -- kept in their own
    // scope rather than folded into #directives, which is reserved for the real core language.
    this.timeout(10000);
    const lines = await tokenizeLines('proc PlaneWindowProc uses ebx esi edi, hwnd\ninvoke GetModuleHandle,0\nendp\n');
    for (const [lineIdx, word] of [[0, 'proc'], [0, 'uses'], [1, 'invoke'], [2, 'endp']] as const) {
      const scopes = scopesOf(lines[lineIdx], word);
      assert.strictEqual(scopes[scopes.length - 1], 'support.function.fasm', `expected "${word}" to be tagged support.function, got: ${scopes}`);
      assert.ok(!scopes.some((s) => s.includes('keyword.control.directive')), `"${word}" must not also be tagged as a core directive, got: ${scopes}`);
    }
  });

  it('tags library/import/export from the standard import32.inc/import64.inc/export.inc packages as support.function too, including across a "\\"-continued multi-line list', async function () {
    // Mirrors real usage in fasmg's own packages/x86/include/win32wx.inc: "library kernel32,
    // 'KERNEL32.DLL',\" continued across several lines.
    this.timeout(10000);
    const lines = await tokenizeLines(["library kernel32,'KERNEL32.DLL',\\", "\tuser32,'USER32.DLL'", 'import? name,definitions&', 'export dllname,exports&'].join('\n'));

    const libScopes = scopesOf(lines[0], 'library');
    assert.strictEqual(libScopes[libScopes.length - 1], 'support.function.fasm', `expected "library" to be tagged support.function, got: ${libScopes}`);
    const dllScopes = scopesOf(lines[0], 'KERNEL32.DLL');
    assert.ok(dllScopes.some((s) => s.startsWith('string')), `expected the DLL name string to still be styled as a string, got: ${dllScopes}`);
    const user32Token = lines[1].find((t) => t.text.includes('user32'));
    assert.ok(user32Token, `expected a token for the continued "user32" line, got: ${JSON.stringify(lines[1].map((t) => t.text))}`);

    const importScopes = scopesOf(lines[2], 'import');
    assert.strictEqual(importScopes[importScopes.length - 1], 'support.function.fasm', `expected "import" to be tagged support.function, got: ${importScopes}`);
    const exportScopes = scopesOf(lines[3], 'export');
    assert.strictEqual(exportScopes[exportScopes.length - 1], 'support.function.fasm', `expected "export" to be tagged support.function, got: ${exportScopes}`);
  });

  it('tags the resource/dialog macro family from resource.inc (directory/resource/dialog/enddialog/dialogitem/...) as support.function too', async function () {
    // Mirrors real usage building a PE .rsrc section with the standard resource.inc package.
    this.timeout(10000);
    const lines = await tokenizeLines([
      "directory RT_DIALOG,dialogs",
      "dialog calculator_dialog,'fasmg-powered calculator',100,120,380,64,WS_CAPTION",
      "dialogitem 'STATIC','&Expression:',-1,4,8,44,8,WS_VISIBLE+SS_RIGHT",
      'enddialog',
    ].join('\n'));
    for (const [lineIdx, word] of [[0, 'directory'], [1, 'dialog'], [2, 'dialogitem'], [3, 'enddialog']] as const) {
      const scopes = scopesOf(lines[lineIdx], word);
      assert.strictEqual(scopes[scopes.length - 1], 'support.function.fasm', `expected "${word}" to be tagged support.function, got: ${scopes}`);
    }
  });

  it('tags the "defined"/"definite"/"used"/"eq"/"eqtype" core logical/type operators, mirroring win32wx.inc\'s "if ~ definite PE & ~ definite x86.mode"', async function () {
    this.timeout(10000);
    const lines = await tokenizeLines(['if ~ definite PE & ~ definite x86.mode', 'if defined X & used Y', 'if a eq b & c eqtype d'].join('\n'));
    for (const [lineIdx, word] of [[0, 'definite'], [1, 'defined'], [1, 'used'], [2, 'eq'], [2, 'eqtype']] as const) {
      const scopes = scopesOf(lines[lineIdx], word);
      assert.strictEqual(scopes[scopes.length - 1], 'keyword.operator.fasm', `expected "${word}" to be tagged as a logical/type operator, got: ${scopes}`);
    }
  });

  it('does not tag the "%" inside an ordinary name (e.g. "BackupRead%") as the repeat-counter pseudo-variable, but still tags a genuinely bare "%"/"%%"', async function () {
    // Mirrors a real, confirmed bug: fasmg's own packages/x86/include/pcount/kernel32.inc defines
    // "BackupRead% =  7" -- fasmg does not treat "%" as a special standalone token at all (per
    // manual.txt's own special-character list), so this "%" is just part of an ordinary name, not
    // the repeat-counter pseudo-variable "if % = %%" uses.
    this.timeout(10000);
    const lines = await tokenizeLines(['BackupRead% =  7', 'if % = %%'].join('\n'));

    const nameToken = lines[0].find((t) => t.text.includes('BackupRead%'));
    assert.ok(nameToken, `expected a token containing "BackupRead%", got: ${JSON.stringify(lines[0].map((t) => t.text))}`);
    assert.ok(!nameToken.scopes.some((s) => s.includes('special')), `"BackupRead%" must not be tagged as the special pseudo-variable, got: ${nameToken.scopes}`);

    const percentScopes = scopesOf(lines[1], '%');
    assert.strictEqual(percentScopes[percentScopes.length - 1], 'variable.language.special.fasm', `expected a bare "%" to still be tagged special, got: ${percentScopes}`);
    const doublePercentScopes = scopesOf(lines[1], '%%');
    assert.strictEqual(doublePercentScopes[doublePercentScopes.length - 1], 'variable.language.special.fasm', `expected a bare "%%" to still be tagged special, got: ${doublePercentScopes}`);
  });

  it('tags "bappend"/"lengthof"/"elementof"/"scaleof"/"metadataof" as operators, mirroring listing2.inc\'s own "text bappend line bappend 13 bappend 10"', async function () {
    this.timeout(10000);
    const lines = await tokenizeLines(['text bappend line', 'n = lengthof s', 'x = 1 elementof p', 'y = 1 scaleof p', 'z = 0 metadataof v'].join('\n'));
    for (const [lineIdx, word] of [[0, 'bappend'], [1, 'lengthof'], [2, 'elementof'], [3, 'scaleof'], [4, 'metadataof']] as const) {
      const scopes = scopesOf(lines[lineIdx], word);
      assert.strictEqual(scopes[scopes.length - 1], 'keyword.operator.fasm', `expected "${word}" to be tagged as an operator, got: ${scopes}`);
    }
  });

  it('tags "relativeto" as an operator and "rawmatch"/"rmatch" alongside "match", found while validating against fasmg.txt/manual.txt', async function () {
    this.timeout(10000);
    const lines = await tokenizeLines(['if a relativeto b & a > b', 'rawmatch text, instruction', 'rmatch text, instruction'].join('\n'));
    const relScopes = scopesOf(lines[0], 'relativeto');
    assert.strictEqual(relScopes[relScopes.length - 1], 'keyword.operator.fasm', `expected "relativeto" to be tagged as an operator, got: ${relScopes}`);
    const rawmatchScopes = scopesOf(lines[1], 'rawmatch');
    assert.strictEqual(rawmatchScopes[rawmatchScopes.length - 1], 'keyword.other.calm.fasm', `expected "rawmatch" to be tagged like "match", got: ${rawmatchScopes}`);
    const rmatchScopes = scopesOf(lines[2], 'rmatch');
    assert.strictEqual(rmatchScopes[rmatchScopes.length - 1], 'keyword.other.calm.fasm', `expected "rmatch" to be tagged like "match", got: ${rmatchScopes}`);
  });

  it('tags "esc" as a directive and "elementsof"/"trunc" as operators, found on a final pass through manual.txt', async function () {
    this.timeout(10000);
    const lines = await tokenizeLines(['esc macro name x&', 'n = elementsof p', 'i = trunc f'].join('\n'));
    const escScopes = scopesOf(lines[0], 'esc');
    assert.ok(escScopes.some((s) => s.includes('directive')), `expected "esc" to be a directive, got: ${escScopes}`);
    const elementsofScopes = scopesOf(lines[1], 'elementsof');
    assert.strictEqual(elementsofScopes[elementsofScopes.length - 1], 'keyword.operator.fasm', `expected "elementsof" to be tagged as an operator, got: ${elementsofScopes}`);
    const truncScopes = scopesOf(lines[2], 'trunc');
    assert.strictEqual(truncScopes[truncScopes.length - 1], 'keyword.operator.fasm', `expected "trunc" to be tagged as an operator, got: ${truncScopes}`);
  });

  it('tags "#" (token-pasting) as an operator instead of leaving it unstyled, mirroring export.inc\'s own "names.name#%"', async function () {
    this.timeout(10000);
    const lines = await tokenizeLines('dd RVA names.name#%\n');
    const scopes = scopesOf(lines[0], '#');
    assert.strictEqual(scopes[scopes.length - 1], 'keyword.operator.fasm', `expected "#" to be tagged as an operator, got: ${scopes}`);
  });

  it('tags every real x86 mnemonic from instructions.json as keyword.other.mnemonic, so the grammar never silently drifts behind hover/completion\'s own instruction list', async function () {
    // Found by checking a real gap first: calculator.asm's own "lodsb" (packages/x86/projects/
    // calculator/calculator.asm) had no color at all, because the grammar's #mnemonics list was a
    // small hand-picked subset (159 entries) of the full 1271-mnemonic set hover/completion already
    // know about (server/src/data/instructions.json) -- missing not just lodsb/cmpsb/scasb but
    // entire SSE/AVX/legacy-FPU/BMI families. This test fails the moment the two lists disagree
    // again, in either direction.
    this.timeout(20000);
    const instructions = JSON.parse(fs.readFileSync(INSTRUCTIONS_PATH, 'utf8')) as Array<{ mnemonic: string }>;
    const mnemonics = [...new Set(instructions.map((i) => i.mnemonic.toLowerCase()))];
    assert.ok(mnemonics.length > 1000, `expected instructions.json to list over 1000 mnemonics, got ${mnemonics.length}`);

    const src = mnemonics.map((m) => `${m} eax`).join('\n');
    const lines = await tokenizeLines(src);
    const failures: string[] = [];
    lines.forEach((tokens, idx) => {
      const mnemonic = mnemonics[idx];
      if (!mnemonic) return;
      const token = tokens.find((t) => t.text.toLowerCase() === mnemonic);
      const scopes = token?.scopes ?? [];
      if (!scopes.some((s) => s === 'keyword.other.mnemonic.fasm')) {
        failures.push(mnemonic);
      }
    });
    assert.strictEqual(failures.length, 0, `these mnemonics from instructions.json are not tagged keyword.other.mnemonic.fasm by the grammar: ${failures.join(', ')}`);
  });

  it('tags every single-word directive from directives.json with some keyword-ish scope, not left as plain unstyled text', async function () {
    // Found by checking a real gap: directives.json had break/eval/indx/outscope/restartout/
    // sizeof/mvmacro/mvstruc/restruc (all real fasmg core directives per manual.txt) with zero
    // grammar coverage at all. "call" and "jno" are deliberately excluded here: both are real x86
    // mnemonics first and foremost, and #calm-commands itself already documents why they're left
    // out of that list specifically. Multi-word names (e.g. "end if") aren't single tokens, so
    // they're excluded too -- covered implicitly by their standalone words ("end", "if").
    this.timeout(20000);
    const directives = JSON.parse(fs.readFileSync(DIRECTIVES_PATH, 'utf8')) as Array<{ name: string }>;
    const words = directives.map((d) => d.name).filter((n) => !n.includes(' ') && !['call', 'jno'].includes(n.toLowerCase()));

    const src = words.map((w) => `${w} eax`).join('\n');
    const lines = await tokenizeLines(src);
    const failures: string[] = [];
    lines.forEach((tokens, idx) => {
      const word = words[idx];
      if (!word) return;
      const token = tokens.find((t) => t.text.toLowerCase() === word.toLowerCase());
      const scopes = token?.scopes ?? [];
      const isStyled = scopes.some((s) => s.startsWith('keyword.') || s.startsWith('storage.') || s.startsWith('support.'));
      if (!isStyled) failures.push(word);
    });
    assert.strictEqual(failures.length, 0, `these directives.json entries are not tagged with any keyword-ish scope by the grammar: ${failures.join(', ')}`);
  });
});
