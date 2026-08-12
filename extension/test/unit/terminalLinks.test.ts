// Every "does this line link" case below is a verbatim line from real fasm2/fasm1 output, not an
// invented shape — the macro-trace and "Processed:" lines in particular are exactly what made a
// mid-line pattern unusable here (see terminalLinks.ts).
import * as assert from 'assert';
import { parseLocationHeader } from '../../src/fasmOutput';

describe('parseLocationHeader', () => {
  it('parses a fasm2 error header', () => {
    assert.deepStrictEqual(parseLocationHeader('bad.asm [5]:'), { rawPath: 'bad.asm', line: 5 });
  });

  it('parses a header with no trailing colon, which fasmg emits when it has no source line to quote', () => {
    assert.deepStrictEqual(parseLocationHeader('prog.asm [117]'), { rawPath: 'prog.asm', line: 117 });
  });

  it('parses a path with directories and spaces in it', () => {
    assert.deepStrictEqual(parseLocationHeader('src/my project/main.asm [42]:'), {
      rawPath: 'src/my project/main.asm',
      line: 42,
    });
  });

  it('parses an absolute Windows path', () => {
    assert.deepStrictEqual(parseLocationHeader('C:\\src\\prog.asm [9]:'), { rawPath: 'C:\\src\\prog.asm', line: 9 });
  });

  it('ignores a macro call-stack trace line, which also ends in "[number]"', () => {
    assert.strictEqual(parseLocationHeader('mov? [3] x86.parse_operand@src [32] (CALM)'), undefined);
  });

  it('ignores a deeper macro trace with several bracketed frames', () => {
    assert.strictEqual(parseLocationHeader('movzx? [30] x86.store_instruction@src [77] x86.require.bits64? [6]'), undefined);
  });

  it('ignores the single-frame trace fasmg prints for a non-macro error', () => {
    // "? [4]" has the header *shape*, and is exactly why links are only offered once the path has
    // been found on disk — nothing is ever named "?".
    assert.deepStrictEqual(parseLocationHeader('? [4]'), { rawPath: '?', line: 4 });
  });

  it('ignores the quoted source line and the message line', () => {
    assert.strictEqual(parseLocationHeader('\tmov eax, undefined_thing'), undefined);
    assert.strictEqual(parseLocationHeader('Processed: notarealthing 1,2'), undefined);
    assert.strictEqual(parseLocationHeader("Error: symbol 'nope1' is undefined or out of scope."), undefined);
    assert.strictEqual(parseLocationHeader('flat assembler  version g.kp60'), undefined);
  });

  it('ignores a line-number that is zero or not a number', () => {
    assert.strictEqual(parseLocationHeader('prog.asm [0]:'), undefined);
    assert.strictEqual(parseLocationHeader('prog.asm [abc]:'), undefined);
  });

  it('tolerates a trailing carriage return, as on Windows terminal output', () => {
    assert.deepStrictEqual(parseLocationHeader('prog.asm [5]:\r'), { rawPath: 'prog.asm', line: 5 });
  });
});
