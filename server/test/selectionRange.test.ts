import * as assert from 'assert';
import { Range, SelectionRange } from 'vscode-languageserver/node';
import { getBlockRanges, getSelectionRanges } from '../src/features/selectionRange';

/** The chain from innermost outward, as "line:startChar-line:endChar" strings. */
function chainOf(text: string, line: number, character: number): string[] {
  const [selection] = getSelectionRanges(text, [{ line, character }]);
  const steps: string[] = [];
  for (let node: SelectionRange | undefined = selection; node; node = node.parent) {
    steps.push(describe_(node.range));
  }
  return steps;
}

function describe_(range: Range): string {
  return `${range.start.line}:${range.start.character}-${range.end.line}:${range.end.character}`;
}

describe('getBlockRanges', () => {
  it('covers the opening and closing lines, unlike a fold', () => {
    const text = ['macro store dest', '\tmov dest, 1', 'end macro'].join('\n');
    assert.deepStrictEqual(getBlockRanges(text), [{ startLine: 0, endLine: 2 }]);
  });

  it('matches nested blocks to their own openers', () => {
    const text = ['macro outer', '\tif defined x', '\t\tnop', '\tend if', 'end macro'].join('\n');
    assert.deepStrictEqual(getBlockRanges(text), [
      { startLine: 1, endLine: 3 },
      { startLine: 0, endLine: 4 },
    ]);
  });

  it('handles a struct closed by its dedicated keyword', () => {
    const text = ['struct Point', '\tx dd ?', '\ty dd ?', 'ends'].join('\n');
    assert.deepStrictEqual(getBlockRanges(text), [{ startLine: 0, endLine: 3 }]);
  });

  it('ignores a closer with no opener rather than inventing a block', () => {
    assert.deepStrictEqual(getBlockRanges(['\tnop', 'end if'].join('\n')), []);
  });
});

describe('getSelectionRanges', () => {
  const PROGRAM = [
    'format ELF64 executable 3',
    'macro store dest, source',
    '\tmov dest, source',
    'end macro',
  ].join('\n');

  it('grows from the token to the statement, the line, the block, then the file', () => {
    // Cursor on "source" in "\tmov dest, source" (line 2). The tab is character 0, "mov" starts at
    // 1, "dest" at 5, "source" at 11. The operand step is the token itself here, so it collapses.
    assert.deepStrictEqual(chainOf(PROGRAM, 2, 12), [
      '2:11-2:17', // source
      '2:1-2:17', // mov dest, source
      '2:0-2:17', // the whole line, including its indentation
      '1:0-3:9', // macro ... end macro
      '0:0-3:9', // the file
    ]);
  });

  it('selects only the operand the cursor is in, not every operand', () => {
    const [selection] = getSelectionRanges(PROGRAM, [{ line: 2, character: 6 }]);
    // "dest" is both the token and the operand, so the first distinct growth is the statement.
    assert.strictEqual(describe_(selection.range), '2:5-2:9');
  });

  it('keeps a comma inside brackets out of the operand split', () => {
    const text = '\tmov eax, [ebx + 4]';
    const chain = chainOf(text, 0, 12);
    assert.ok(chain.includes('0:10-0:19'), `expected the whole bracketed operand, got ${JSON.stringify(chain)}`);
  });

  it('treats a label and the statement beside it as separate steps', () => {
    const text = 'start:\tmov eax, 1';
    const chain = chainOf(text, 0, 12); // on "eax"
    assert.ok(chain.includes('0:7-0:17'), `expected the statement without its label, got ${JSON.stringify(chain)}`);
    assert.ok(chain.includes('0:0-0:17'), 'expected the whole line as a later step');
  });

  it('does not repeat a step that is identical to the one before it', () => {
    const text = 'nop';
    const chain = chainOf(text, 0, 1);
    assert.strictEqual(new Set(chain).size, chain.length, `duplicate steps in ${JSON.stringify(chain)}`);
  });

  it('leaves a trailing comment out of the statement but inside the line', () => {
    const text = '\tmov eax, 1 ; set it';
    const chain = chainOf(text, 0, 6);
    assert.ok(chain.includes('0:1-0:11'), `statement should stop before the comment, got ${JSON.stringify(chain)}`);
    assert.ok(chain.includes('0:0-0:20'), 'the whole line should still include it');
  });

  it('answers every requested position', () => {
    const result = getSelectionRanges(PROGRAM, [
      { line: 0, character: 0 },
      { line: 2, character: 6 },
    ]);
    assert.strictEqual(result.length, 2);
  });

  it('still answers for an empty document', () => {
    const result = getSelectionRanges('', [{ line: 0, character: 0 }]);
    assert.strictEqual(result.length, 1);
  });
});
