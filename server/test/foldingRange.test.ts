import * as assert from 'assert';
import { FoldingRangeKind } from 'vscode-languageserver/node';
import { getFoldingRanges } from '../src/features/foldingRange';

/** Folds as "startLine-endLine" strings, for readable assertions. */
function folds(lines: string[]): string[] {
  return getFoldingRanges(lines.join('\n'))
    .map((r) => `${r.startLine}-${r.endLine}${r.kind ? `:${r.kind}` : ''}`)
    .sort();
}

describe('getFoldingRanges', () => {
  it('folds a macro body, ending on the line before its terminator', () => {
    // 0 "macro save reg", 1 "push reg", 2 "pop reg", 3 "end macro"
    assert.deepStrictEqual(folds(['macro save reg', 'push reg', 'pop reg', 'end macro']), ['0-2']);
  });

  it('matches nested blocks to their own terminators rather than the nearest one', () => {
    // This is the case a marker-based folder gets wrong: it cannot tell which "end" closes which
    // opener, so the inner and outer blocks come out crossed.
    const lines = ['macro m', 'if defined X', 'while 1', 'nop', 'end while', 'end if', 'end macro'];
    assert.deepStrictEqual(folds(lines), ['0-5', '1-4', '2-3']);
  });

  it('closes a struct with "ends" and a fasm1 proc with "endp"', () => {
    assert.deepStrictEqual(folds(['struct Point', 'x dd ?', 'y dd ?', 'ends']), ['0-2']);
    assert.deepStrictEqual(folds(['proc main', 'nop', 'nop', 'endp']), ['0-2']);
  });

  it('folds each branch of an if/else chain independently', () => {
    // 0 "if X", 1 "nop", 2 "nop", 3 "else", 4 "ret", 5 "ret", 6 "end if"
    assert.deepStrictEqual(folds(['if X', 'nop', 'nop', 'else', 'ret', 'ret', 'end if']), ['0-2', '3-5']);
  });

  it('does not fold an unclosed block all the way to end-of-file', () => {
    // A fragment that opens a block it never closes must not collapse into one giant region.
    assert.deepStrictEqual(folds(['macro m', 'nop', 'nop']), []);
  });

  it('ignores a block keyword that appears inside a string literal', () => {
    // The concrete thing a regex-based folder gets wrong.
    assert.deepStrictEqual(folds(["msg db 'end macro', 0", 'nop']), []);
  });

  it('ignores a block keyword inside a comment', () => {
    // One comment line is not a run, so it yields no comment fold either — the point is that the
    // commented-out "macro" opens nothing.
    assert.deepStrictEqual(folds(['; macro m', 'nop', 'nop', 'nop']), []);
  });

  it('folds an explicit ;region / ;endregion pair', () => {
    const result = getFoldingRanges(['; region setup', 'nop', 'nop', '; endregion'].join('\n'));
    const region = result.find((r) => r.kind === FoldingRangeKind.Region);
    assert.ok(region, `expected a region fold, got ${JSON.stringify(result)}`);
    assert.strictEqual(region.startLine, 0);
    // The closing marker folds away with the body — VS Code's own convention for regions, unlike a
    // block, whose terminator stays visible so you can still see what was closed.
    assert.strictEqual(region.endLine, 3);
  });

  it('folds a run of consecutive comment lines as a comment region', () => {
    const result = getFoldingRanges(['; one', '; two', '; three', 'nop'].join('\n'));
    const comment = result.find((r) => r.kind === FoldingRangeKind.Comment);
    assert.ok(comment, `expected a comment fold, got ${JSON.stringify(result)}`);
    assert.strictEqual(comment.startLine, 0);
    assert.strictEqual(comment.endLine, 2);
  });

  it('does not emit a fold for a single-line block', () => {
    assert.deepStrictEqual(folds(['if X', 'end if']), []);
  });

  it('tolerates a closer with no opener, as in a fragment that starts mid-construct', () => {
    assert.deepStrictEqual(folds(['end if', 'nop', 'nop']), []);
  });

  it('folds a label-prefixed block opener', () => {
    assert.deepStrictEqual(folds(['start: macro m', 'nop', 'nop', 'end macro']), ['0-2']);
  });
});
