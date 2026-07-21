// Real TextMate tokenization tests for syntaxes/fasm.tmLanguage.json, using the same engine
// (vscode-textmate/vscode-oniguruma) VS Code itself uses — not just visual inspection of the
// grammar JSON, which looks plausible without actually proving how patterns interact once loaded.
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as oniguruma from 'vscode-oniguruma';
import * as vsctm from 'vscode-textmate';

const GRAMMAR_PATH = path.join(__dirname, '..', '..', 'syntaxes', 'fasm.tmLanguage.json');

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

  it('does not mistake fasmg\'s "$1A"-style dollar-prefixed hex literal for the "$" current-address symbol', async function () {
    this.timeout(10000);
    const lines = await tokenizeLines('n = $1A\n');
    const scopes = scopesOf(lines[0], '$1A');
    assert.strictEqual(scopes[scopes.length - 1], 'constant.numeric.hex.fasm', `expected "$1A" to be a hex number, got: ${scopes}`);
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
});
