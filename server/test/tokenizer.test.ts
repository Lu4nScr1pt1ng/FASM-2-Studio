import * as assert from 'assert';
import { TokenType, tokenizeLine, unquoteString } from '../src/parser/tokenizer';

describe('tokenizer', () => {
  it('splits identifiers, punctuation and numbers', () => {
    const tokens = tokenizeLine('mov eax, 7C00h', 0);
    assert.deepStrictEqual(
      tokens.map((t) => t.text),
      ['mov', 'eax', ',', '7C00h'],
    );
    assert.strictEqual(tokens[3].type, TokenType.Number);
  });

  it('treats everything after ; as a single comment token', () => {
    const tokens = tokenizeLine('mov eax, ebx ; copy value', 0);
    const comment = tokens[tokens.length - 1];
    assert.strictEqual(comment.type, TokenType.Comment);
    assert.strictEqual(comment.text, '; copy value');
  });

  it('handles single and double quoted strings, including doubled-quote escapes', () => {
    const tokens = tokenizeLine(`db 'it''s', "a ""b"" c"`, 0);
    const strings = tokens.filter((t) => t.type === TokenType.String);
    assert.strictEqual(strings.length, 2);
    assert.strictEqual(unquoteString(strings[0].text), "it's");
    assert.strictEqual(unquoteString(strings[1].text), 'a "b" c');
  });

  it('recognizes local labels and directive-style identifiers', () => {
    const tokens = tokenizeLine('.loop: dec ecx', 0);
    assert.strictEqual(tokens[0].type, TokenType.Ident);
    assert.strictEqual(tokens[0].text, '.loop');
  });

  it('produces no tokens for a blank line', () => {
    assert.deepStrictEqual(tokenizeLine('   ', 0), []);
  });
});
