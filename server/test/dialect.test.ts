import * as assert from 'assert';
import { detectDialect } from '../src/dialect';

describe('detectDialect', () => {
  it('detects fasm2 from "end macro"', () => {
    assert.strictEqual(detectDialect('macro foo\nend macro\n', 'fasm1'), 'fasm2');
  });

  it('detects fasm2 from calminstruction/iterate/namespace/irp', () => {
    assert.strictEqual(detectDialect('calminstruction foo\nend calminstruction\n', 'fasm1'), 'fasm2');
    assert.strictEqual(detectDialect('iterate x, 1, 2\nend iterate\n', 'fasm1'), 'fasm2');
    assert.strictEqual(detectDialect('namespace foo\nend namespace\n', 'fasm1'), 'fasm2');
    assert.strictEqual(detectDialect('irp x, 1, 2\nend irp\n', 'fasm1'), 'fasm2');
    assert.strictEqual(detectDialect('irps x, a b c\nend irps\n', 'fasm1'), 'fasm2');
  });

  it('detects fasm1 from use16/use32/use64, rept, and endp', () => {
    assert.strictEqual(detectDialect('use16\nmov ax, 1\n', 'fasm2'), 'fasm1');
    assert.strictEqual(detectDialect('use32\nmov eax, 1\n', 'fasm2'), 'fasm1');
    assert.strictEqual(detectDialect('use64\nmov rax, 1\n', 'fasm2'), 'fasm1');
    assert.strictEqual(detectDialect('rept 4 { nop }\n', 'fasm2'), 'fasm1');
    assert.strictEqual(detectDialect('proc foo\nendp\n', 'fasm2'), 'fasm1');
  });

  it('is case-insensitive', () => {
    assert.strictEqual(detectDialect('END MACRO', 'fasm1'), 'fasm2');
    assert.strictEqual(detectDialect('USE16', 'fasm2'), 'fasm1');
  });

  it('falls back to the given default when no markers are present', () => {
    assert.strictEqual(detectDialect('mov eax, 1\nadd eax, ebx\n', 'fasm2'), 'fasm2');
    assert.strictEqual(detectDialect('mov eax, 1\nadd eax, ebx\n', 'fasm1'), 'fasm1');
    assert.strictEqual(detectDialect('', 'fasm2'), 'fasm2');
  });

  it('falls back to the default when both dialects\' markers are present (ambiguous)', () => {
    assert.strictEqual(detectDialect('use16\nend macro\n', 'fasm2'), 'fasm2');
    assert.strictEqual(detectDialect('use16\nend macro\n', 'fasm1'), 'fasm1');
  });

  it('does not false-positive on markers appearing as a substring of a longer identifier', () => {
    // A label named "endpoint" contains "endp" but must not be mistaken for the fasm1 "endp"
    // procedure-end marker; "reptile" contains "rept" but isn't the "rept" directive, etc.
    assert.strictEqual(detectDialect('mov eax, endpoint\n', 'fasm2'), 'fasm2');
    assert.strictEqual(detectDialect('mov eax, endpoint\n', 'fasm1'), 'fasm1');
    assert.strictEqual(detectDialect('reptile_count = 5\n', 'fasm2'), 'fasm2');
    assert.strictEqual(detectDialect('call iterated_function\n', 'fasm2'), 'fasm2');
    assert.strictEqual(detectDialect('mov eax, irpx_value\n', 'fasm2'), 'fasm2');
  });

  it('does not treat fasm2\'s bare "use" directive as a fasm1 marker', () => {
    // fasm2 activates a CPU/mode module with "use i386"/"use x64" (no digits glued to "use");
    // fasm1's markers specifically require use16/use32/use64. Neither heuristic fires here, so
    // this correctly falls back to the caller's default rather than guessing fasm1.
    assert.strictEqual(detectDialect('use i386\nmov eax, 1\n', 'fasm2'), 'fasm2');
    assert.strictEqual(detectDialect('use i386\nmov eax, 1\n', 'fasm1'), 'fasm1');
  });
});
