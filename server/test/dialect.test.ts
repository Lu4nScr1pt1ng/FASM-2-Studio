import * as assert from 'assert';
import { detectDialect } from '../src/dialect';

describe('detectDialect', () => {
  it('detects fasm2 from "end macro"', () => {
    assert.strictEqual(detectDialect('macro foo\nend macro\n', 'fasm1'), 'fasm2');
  });

  it('detects fasm2 from calminstruction/iterate/namespace', () => {
    assert.strictEqual(detectDialect('calminstruction foo\nend calminstruction\n', 'fasm1'), 'fasm2');
    assert.strictEqual(detectDialect('iterate x, 1, 2\nend iterate\n', 'fasm1'), 'fasm2');
    assert.strictEqual(detectDialect('namespace foo\nend namespace\n', 'fasm1'), 'fasm2');
  });

  it('does not treat "end repeat", "irp", or "irpv" as fasm2 markers (they are native fasm1 directives too)', () => {
    // flat assembler 1.73 manual, 2.3.5 "Repeating blocks of instructions" and 2.3.7 "Symbolic
    // variables": fasm1 has its own native "repeat ... end repeat" and "irp"/"irpv" directives, so
    // treating them as fasm2-exclusive misclassified real fasm1 source using them as fasm2, which
    // then hid fasm1-specific hover content and directive completions for those files.
    assert.strictEqual(detectDialect('repeat 4\n\tnop\nend repeat\n', 'fasm1'), 'fasm1');
    assert.strictEqual(detectDialect('irp x, 1, 2\n\tdb x\nend irp\n', 'fasm1'), 'fasm1');
    assert.strictEqual(detectDialect('irpv param, var\n\tdb param\nend irpv\n', 'fasm1'), 'fasm1');
  });

  it('does not treat use16/use32/use64, rept, or endp as fasm1 markers (they are legitimate macro names in fasmg\'s own official packages)', () => {
    // Confirmed against fasmg's own real example tree: 80386.inc/x64.inc define use16/use32/use64
    // as macros, and packages/x86/examples/windows/*.asm define proc/endp the same way fasm1's
    // win32 package does — so these previously caused real fasmg files to be misdetected as
    // fasm1. With no marker present, this correctly falls back to the caller's default instead of
    // guessing fasm1.
    assert.strictEqual(detectDialect('use16\nmov ax, 1\n', 'fasm2'), 'fasm2');
    assert.strictEqual(detectDialect('use32\nmov eax, 1\n', 'fasm2'), 'fasm2');
    assert.strictEqual(detectDialect('use64\nmov rax, 1\n', 'fasm2'), 'fasm2');
    assert.strictEqual(detectDialect('rept 4 { nop }\n', 'fasm2'), 'fasm2');
    assert.strictEqual(detectDialect('proc foo\nendp\n', 'fasm2'), 'fasm2');
  });

  it('is case-insensitive', () => {
    assert.strictEqual(detectDialect('END MACRO', 'fasm1'), 'fasm2');
    assert.strictEqual(detectDialect('CALMINSTRUCTION', 'fasm1'), 'fasm2');
  });

  it('falls back to the given default when no markers are present', () => {
    assert.strictEqual(detectDialect('mov eax, 1\nadd eax, ebx\n', 'fasm2'), 'fasm2');
    assert.strictEqual(detectDialect('mov eax, 1\nadd eax, ebx\n', 'fasm1'), 'fasm1');
    assert.strictEqual(detectDialect('', 'fasm2'), 'fasm2');
  });

  it('detects fasm2 even alongside old-style tokens like use16/endp that used to be treated as fasm1-only', () => {
    assert.strictEqual(detectDialect('use16\nend macro\n', 'fasm1'), 'fasm2');
  });

  it('does not false-positive on a marker appearing as a substring of a longer identifier', () => {
    // "iterated_function"/"irpx_value" contain "iterate"/"irp" as substrings but aren't the
    // directives themselves — proven by falling back to 'fasm1' here instead of firing fasm2.
    assert.strictEqual(detectDialect('call iterated_function\n', 'fasm1'), 'fasm1');
    assert.strictEqual(detectDialect('mov eax, irpx_value\n', 'fasm1'), 'fasm1');
  });
});
