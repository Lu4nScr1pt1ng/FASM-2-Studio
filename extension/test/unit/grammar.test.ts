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

    // The size specifier after a field name is still recognized as such.
    const ddScopes = scopesOf(lines[1], 'dd');
    assert.ok(ddScopes.some((s) => s.includes('directive')), `expected "dd" to still be tagged as a directive inside the struct body, got: ${ddScopes}`);

    const endsScopes = scopesOf(lines[4], 'ends');
    assert.ok(endsScopes.some((s) => s.startsWith('keyword.control')), `expected "ends" to be a keyword, got: ${endsScopes}`);
  });

  it('still tags "segment" as a format directive/keyword outside any struct body', async function () {
    this.timeout(10000);
    const lines = await tokenizeLines("segment '.data' data readable writeable\n");
    const scopes = scopesOf(lines[0], 'segment');
    assert.ok(scopes.some((s) => s.includes('directive')), `expected "segment" outside a struct to still be a directive, got: ${scopes}`);
  });
});
