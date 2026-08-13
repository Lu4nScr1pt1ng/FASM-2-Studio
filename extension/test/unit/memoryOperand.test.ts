import * as assert from 'assert';
import { memoryOperandAt } from '../../src/memoryOperand';

/** The operand text the provider would send, for a cursor at the given column. */
function expressionAt(line: string, character: number): string | undefined {
  return memoryOperandAt(line, character)?.expression;
}

/** The source text the hover would highlight, for a cursor at the given column. */
function highlighted(line: string, character: number): string | undefined {
  const operand = memoryOperandAt(line, character);
  return operand && line.slice(operand.startChar, operand.endChar);
}

describe('memoryOperandAt', () => {
  const line = '\tmov eax, dword [rsp+8]';

  it('finds the whole operand from a cursor anywhere inside the brackets', () => {
    // The point of the whole feature: the word under "rsp" is "rsp", which is not what the
    // instruction reads.
    for (const character of [line.indexOf('rsp'), line.indexOf('+'), line.indexOf('8')]) {
      assert.strictEqual(expressionAt(line, character), 'dword [rsp+8]');
    }
  });

  it('counts the brackets themselves as being inside the operand', () => {
    assert.strictEqual(expressionAt(line, line.indexOf('[')), 'dword [rsp+8]');
    assert.strictEqual(expressionAt(line, line.indexOf(']')), 'dword [rsp+8]');
  });

  it('highlights the size specifier along with the brackets, so the hover covers what it read', () => {
    assert.strictEqual(highlighted(line, line.indexOf('rsp')), 'dword [rsp+8]');
  });

  it('takes the width from the other operand when the source leaves it implicit', () => {
    assert.strictEqual(expressionAt('\tmov eax, [buffer]', 12), 'dword [buffer]');
    assert.strictEqual(expressionAt('\tmov al, [buffer]', 11), 'byte [buffer]');
    assert.strictEqual(expressionAt('\tmov rax, [buffer]', 12), 'qword [buffer]');
    assert.strictEqual(expressionAt('\tmov bx, [buffer]', 11), 'word [buffer]');
  });

  it('ignores index registers inside the brackets when inferring the width', () => {
    // rcx is part of the address, not of the value's width — counting it would read 8 bytes where
    // the instruction reads 4.
    assert.strictEqual(expressionAt('\tmov eax, [buf+rcx*4]', 15), 'dword [buf+rcx*4]');
  });

  it('prefers an explicit size specifier over anything inferred', () => {
    assert.strictEqual(expressionAt('\tmov eax, byte [buffer]', 17), 'byte [buffer]');
  });

  it('keeps the operand exactly as written, so the adapter sees the source spelling', () => {
    assert.strictEqual(expressionAt('\tmov eax, [buffer+STRIDE]', 12), 'dword [buffer+STRIDE]');
    assert.strictEqual(expressionAt('\tmov eax, [rsp+0FFh]', 12), 'dword [rsp+0FFh]');
  });

  it('steps over the masm-style "ptr" fasm also accepts', () => {
    assert.strictEqual(expressionAt('\tmov eax, dword ptr [rsp]', 21), 'dword [rsp]');
    assert.strictEqual(highlighted('\tmov eax, dword ptr [rsp]', 21), 'dword ptr [rsp]');
  });

  it('gives nothing for a cursor outside any brackets, restoring the word fallback', () => {
    assert.strictEqual(expressionAt(line, line.indexOf('mov')), undefined);
    assert.strictEqual(expressionAt(line, line.indexOf('eax')), undefined);
    assert.strictEqual(expressionAt('\tmov eax, 1', 6), undefined);
  });

  it('gives nothing when no width can be established rather than guessing one', () => {
    // fasm rejects this as ambiguous itself, so it is not a shape real source arrives in.
    assert.strictEqual(expressionAt('\tcmp [counter], 5', 8), undefined);
  });

  it('gives nothing for a size it cannot read back as one scalar', () => {
    assert.strictEqual(expressionAt('\tmovdqu xmm0, dqword [buffer]', 23), undefined);
  });

  it('never overrules an explicit non-scalar size by inferring a narrower one', () => {
    // A register elsewhere on the line must not turn a dqword operand into a 4-byte read; the
    // source named a width, and the honest answer is that this cannot report it.
    assert.strictEqual(expressionAt('\tmov eax, dqword [buffer]', 20), undefined);
    assert.strictEqual(expressionAt('\tmov eax, tbyte [buffer]', 19), undefined);
  });

  it('ignores brackets that are only inside a comment', () => {
    assert.strictEqual(expressionAt('\tmov eax, 1 ; see dword [rsp+8]', 26), undefined);
  });

  it('does not run off the end of an unbalanced line mid-edit', () => {
    assert.strictEqual(expressionAt('\tmov eax, dword [rsp+8', 18), undefined);
    assert.strictEqual(expressionAt('\tmov eax, dword ]rsp[', 18), undefined);
  });

  it('finds the second operand on a line that has two', () => {
    const two = '\tmov dword [dest], eax';
    assert.strictEqual(expressionAt(two, two.indexOf('dest')), 'dword [dest]');
  });
});
