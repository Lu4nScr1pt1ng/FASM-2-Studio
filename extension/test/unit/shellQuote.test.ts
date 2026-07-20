import * as assert from 'assert';
import { quoteForShell } from '../../src/shellQuote';

describe('quoteForShell', () => {
  it('leaves a plain path with no special characters unquoted', () => {
    assert.strictEqual(quoteForShell('/home/user/project/hello'), '/home/user/project/hello');
  });

  it('quotes a path containing a space', () => {
    assert.strictEqual(quoteForShell('/home/user/my project/hello'), '"/home/user/my project/hello"');
  });

  it('quotes and escapes a path containing a literal double quote', () => {
    assert.strictEqual(quoteForShell('/home/user/weird"name/hello'), '"/home/user/weird\\"name/hello"');
  });

  it('quotes a path with both a space and an embedded quote', () => {
    assert.strictEqual(quoteForShell('/tmp/a b"c/hello'), '"/tmp/a b\\"c/hello"');
  });

  it('handles an empty string without throwing', () => {
    assert.strictEqual(quoteForShell(''), '');
  });

  it('handles tabs and other whitespace, not just plain spaces', () => {
    assert.strictEqual(quoteForShell('/tmp/a\tb'), '"/tmp/a\tb"');
  });
});
