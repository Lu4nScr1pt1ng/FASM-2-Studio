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

  it('renders an empty string as an explicit empty argument', () => {
    // An empty fasm2Studio.runArgs entry has to reach the program as an empty argv slot; left
    // unquoted it would vanish from the command line and shift every argument after it.
    assert.strictEqual(quoteForShell(''), '""');
  });

  it('handles tabs and other whitespace, not just plain spaces', () => {
    assert.strictEqual(quoteForShell('/tmp/a\tb'), '"/tmp/a\tb"');
  });

  it('quotes shell metacharacters that contain no whitespace at all', () => {
    // The reason this is not just a whitespace test: unquoted, the shell would expand the glob and
    // act on the separator rather than passing either through as the argument it was written as.
    assert.strictEqual(quoteForShell('*.txt'), '"*.txt"');
    assert.strictEqual(quoteForShell('a;b'), '"a;b"');
    assert.strictEqual(quoteForShell('a|b'), '"a|b"');
  });

  it('escapes the expansions a POSIX shell still performs inside double quotes', () => {
    assert.strictEqual(quoteForShell('$HOME'), '"\\$HOME"');
    assert.strictEqual(quoteForShell('`id`'), '"\\`id\\`"');
    assert.strictEqual(quoteForShell('a\\b c'), '"a\\\\b c"');
  });
});
