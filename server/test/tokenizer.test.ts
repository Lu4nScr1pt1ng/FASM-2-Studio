import * as assert from 'assert';
import { TokenType, tokenizeDocument, tokenizeLine, unquoteString } from '../src/parser/tokenizer';

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

  it('treats a space-separated pair as two strings, not one with an escape', () => {
    const tokens = tokenizeLine(`'a' 'b'`, 0);
    const strings = tokens.filter((t) => t.type === TokenType.String);
    assert.strictEqual(strings.length, 2);
    assert.strictEqual(strings[0].text, `'a'`);
    assert.strictEqual(strings[1].text, `'b'`);
  });

  it('handles more than one doubled-quote escape within a single string', () => {
    const tokens = tokenizeLine(`'a''b''c'`, 0);
    const strings = tokens.filter((t) => t.type === TokenType.String);
    assert.strictEqual(strings.length, 1, 'expected one string token, not multiple split at each escape');
    assert.strictEqual(unquoteString(strings[0].text), "a'b'c");
  });

  it('absorbs a single-quote digit separator into the number instead of starting a stray string', () => {
    // manual.txt's "Fundamental syntax rules": "the numbers are also allowed to contain
    // underscores or single quotes to act as a separator or padding" (e.g. "1'000'000"). Before this
    // fix, the embedded "'" split the token into Number("1") + String("'000'") + Number("000").
    const tokens = tokenizeLine("big = 1'000'000", 0);
    assert.deepStrictEqual(tokens.map((t) => t.text), ['big', '=', "1'000'000"]);
    assert.strictEqual(tokens[2].type, TokenType.Number);
  });

  it('still starts a real string at a quote not preceded by an in-progress number', () => {
    const tokens = tokenizeLine(`s = 'hello'`, 0);
    const str = tokens.find((t) => t.type === TokenType.String);
    assert.strictEqual(str?.text, `'hello'`);
  });

  it('does not hang or throw on an unterminated string at end of line', () => {
    assert.doesNotThrow(() => tokenizeLine(`db 'unterminated`, 0));
    const tokens = tokenizeLine(`db 'unterminated`, 0);
    const str = tokens.find((t) => t.type === TokenType.String);
    assert.ok(str, 'expected the unterminated string to still produce a token');
    assert.strictEqual(str!.text, `'unterminated`);
  });

  it('never throws on non-ASCII text in strings or comments', () => {
    assert.doesNotThrow(() => tokenizeLine(`db 'héllo wörld 日本語' ; ünïcödé comment`, 0));
  });

  it('splits a document on LF, CRLF, and CR line endings alike', () => {
    const doc = tokenizeDocument('a\nb\r\nc\rd');
    assert.strictEqual(doc.length, 4);
    assert.deepStrictEqual(
      doc.map((line) => line.map((t) => t.text)),
      [['a'], ['b'], ['c'], ['d']],
    );
  });

  describe('unquoteString', () => {
    it('un-escapes a doubled quote back to a single literal quote', () => {
      assert.strictEqual(unquoteString(`'it''s'`), "it's");
    });

    it('handles multiple escapes in one string', () => {
      assert.strictEqual(unquoteString(`'a''b''c'`), "a'b'c");
    });

    it('returns an empty string for an empty quoted string', () => {
      assert.strictEqual(unquoteString(`''`), '');
    });

    it('does not strip content from an unterminated (no closing quote) token', () => {
      assert.strictEqual(unquoteString(`'unterminated`), 'unterminated');
    });

    it('returns short input unchanged instead of throwing', () => {
      assert.strictEqual(unquoteString(`'`), `'`);
      assert.strictEqual(unquoteString(''), '');
    });
  });
});
