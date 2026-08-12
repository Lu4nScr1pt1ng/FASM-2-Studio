import * as assert from 'assert';
import { completionContext } from '../src/features/completion';

describe('completionContext', () => {
  it('treats the start of a line as statement position', () => {
    assert.strictEqual(completionContext(''), 'statement');
    assert.strictEqual(completionContext('\t'), 'statement');
    assert.strictEqual(completionContext('    '), 'statement');
  });

  it('treats a word still being typed at the start of a line as statement position', () => {
    // The half-typed word is not itself evidence of position — dropping it is what keeps "mo|"
    // ranked as a mnemonic rather than as an operand.
    assert.strictEqual(completionContext('\tmo'), 'statement');
  });

  it('treats the position right after a label as statement position', () => {
    assert.strictEqual(completionContext('start: '), 'statement');
    assert.strictEqual(completionContext('start:\t'), 'statement');
    assert.strictEqual(completionContext('area:: '), 'statement');
    assert.strictEqual(completionContext('start: mo'), 'statement');
  });

  it('treats the position after a mnemonic as operand position', () => {
    assert.strictEqual(completionContext('\tmov '), 'operand');
    assert.strictEqual(completionContext('\tmov ea'), 'operand');
    assert.strictEqual(completionContext('\tmov eax, '), 'operand');
    assert.strictEqual(completionContext('start: mov '), 'operand');
  });

  it('is not fooled by a ";" inside a string literal', () => {
    assert.strictEqual(completionContext("\tdb 'a ; b', "), 'operand');
  });

  it('ignores a trailing comment when deciding position', () => {
    assert.strictEqual(completionContext('\tmov eax, 1 ; note'), 'operand');
  });
});
