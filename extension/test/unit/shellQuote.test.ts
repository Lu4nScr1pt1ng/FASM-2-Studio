import * as assert from 'assert';
import { fasmIncludeDirective, quoteForShell } from '../../src/shellQuote';

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

describe('fasmIncludeDirective', () => {
  it('quotes with double quotes when the outer shell is not cmd (bash, PowerShell)', () => {
    assert.strictEqual(fasmIncludeDirective('/home/user/listing.inc', false), 'include "/home/user/listing.inc"');
  });

  it('quotes with single quotes when the outer shell is forced to cmd, avoiding the collision that ' +
    'strips both layers of quoting once cmd\'s own "..." wrap lands on an already-"..."-quoted value', () => {
    assert.strictEqual(
      fasmIncludeDirective('c:/Users/User/.vscode/extensions/lu4nscr1pt1ng.fasm2-studio/listing.inc', true),
      "include 'c:/Users/User/.vscode/extensions/lu4nscr1pt1ng.fasm2-studio/listing.inc'",
    );
  });

  it('escapes a literal occurrence of the chosen delimiter by doubling it', () => {
    assert.strictEqual(fasmIncludeDirective('/tmp/weird"name/listing.inc', false), 'include "/tmp/weird""name/listing.inc"');
    assert.strictEqual(fasmIncludeDirective("/tmp/weird'name/listing.inc", true), "include '/tmp/weird''name/listing.inc'");
  });
});
