import * as assert from 'assert';
import { OperandResolver, translateMemoryOperand } from '../src/operandExpression';

// A stand-in for what session.ts builds out of the .lst listing: one data label and one
// compile-time constant, which are the two kinds of name an operand can carry.
const resolver: OperandResolver = {
  symbolAddress: (name) => (name === 'buffer' ? 0x401000n : name === 'counter' ? 0x402000n : undefined),
  constantValue: (name) => (name === 'STRIDE' ? 4n : undefined),
};

const translate = (text: string) => translateMemoryOperand(text, resolver);

describe('translateMemoryOperand', () => {
  it('prefixes registers the way gdb spells them', () => {
    assert.deepStrictEqual(translate('dword [rsp+8]'), { address: '($rsp+8)', bits: 32, text: 'dword [rsp+8]' });
  });

  it('takes the width from the size specifier', () => {
    assert.strictEqual(translate('byte [rsp]')?.bits, 8);
    assert.strictEqual(translate('word [rsp]')?.bits, 16);
    assert.strictEqual(translate('dword [rsp]')?.bits, 32);
    assert.strictEqual(translate('qword [rsp]')?.bits, 64);
  });

  it('substitutes a label for its address, since a fasmg binary has no symbol table', () => {
    assert.strictEqual(translate('dword [buffer]')?.address, '(0x401000)');
  });

  it('substitutes a constant for its value, not for an address it does not have', () => {
    assert.strictEqual(translate('dword [buffer+STRIDE]')?.address, '(0x401000+4)');
  });

  it('translates a scaled index, which C multiplication reproduces exactly', () => {
    assert.strictEqual(translate('dword [buffer+rcx*4]')?.address, '(0x401000+$rcx*4)');
  });

  it('re-emits fasm numeric literals in decimal, since gdb reads neither form', () => {
    // "0FFh" is a symbol to gdb and "$FF" is one of its own convenience variables.
    assert.strictEqual(translate('dword [rsp+0FFh]')?.address, '($rsp+255)');
    assert.strictEqual(translate('dword [rsp+1010b]')?.address, '($rsp+10)');
    assert.strictEqual(translate('dword [rsp+$FF]')?.address, '($rsp+255)');
  });

  it('parenthesizes the address so the caller\'s cast binds to all of it', () => {
    // Without the parentheses "*(unsigned int*)$rsp+8" reads at $rsp and then adds 8 to the value.
    assert.ok(translate('dword [rsp+8]')!.address.startsWith('('));
    assert.ok(translate('dword [rsp+8]')!.address.endsWith(')'));
  });

  it('accepts the masm-style "ptr" fasm also allows', () => {
    assert.strictEqual(translate('dword ptr [rsp]')?.address, '($rsp)');
  });

  it('takes the width from the caller when the operand does not name one', () => {
    assert.strictEqual(translateMemoryOperand('[rsp]', resolver, 32)?.bits, 32);
  });

  it('declines an unsized operand with no width supplied, rather than guessing one', () => {
    assert.strictEqual(translate('[rsp]'), undefined);
  });

  it('declines a size that has no scalar value to report', () => {
    // Real fasm sizes, but there is no C scalar type to cast to — reading them at some other width
    // would report a number that is not the operand's value.
    for (const size of ['fword', 'tbyte', 'dqword', 'xword', 'yword', 'zword']) {
      assert.strictEqual(translate(`${size} [rsp]`), undefined, size);
    }
  });

  it('declines a name it cannot resolve, since gdb cannot resolve it either', () => {
    assert.strictEqual(translate('dword [unknown_label]'), undefined);
  });

  it('declines anything that is not a single bracketed operand', () => {
    assert.strictEqual(translate('eax'), undefined);
    assert.strictEqual(translate('buffer'), undefined);
    assert.strictEqual(translate('dword [rax], [rbx]'), undefined);
    assert.strictEqual(translate('mov eax, dword [rsp]'), undefined);
  });

  it('declines punctuation that does not mean the same thing to gdb', () => {
    assert.strictEqual(translate('dword [fs:rsp]'), undefined);
    assert.strictEqual(translate("dword ['a']"), undefined);
  });

  it('is case-insensitive about registers and size specifiers, as fasm is', () => {
    assert.deepStrictEqual(translate('DWORD [RSP+8]')?.address, '($rsp+8)');
  });
});
