// Mirrors server/test/dialect.test.ts. The extension keeps its own copy of this heuristic (see
// extension/src/dialect.ts's doc comment for why), so it needs its own test rather than trusting
// the two stay identical by inspection.
import * as assert from 'assert';
import { detectDialect } from '../../src/dialect';

describe('detectDialect (extension copy)', () => {
  it('detects fasm2 from "end macro"', () => {
    assert.strictEqual(detectDialect('macro foo\nend macro\n', 'fasm1'), 'fasm2');
  });

  it('detects fasm1 from use16/use32/use64, rept, and endp', () => {
    assert.strictEqual(detectDialect('use16\nmov ax, 1\n', 'fasm2'), 'fasm1');
    assert.strictEqual(detectDialect('rept 4 { nop }\n', 'fasm2'), 'fasm1');
    assert.strictEqual(detectDialect('proc foo\nendp\n', 'fasm2'), 'fasm1');
  });

  it('falls back to the given default when no markers are present, or when both are', () => {
    assert.strictEqual(detectDialect('mov eax, 1\n', 'fasm2'), 'fasm2');
    assert.strictEqual(detectDialect('use16\nend macro\n', 'fasm1'), 'fasm1');
  });

  it('does not false-positive on markers appearing as a substring of a longer identifier', () => {
    assert.strictEqual(detectDialect('mov eax, endpoint\n', 'fasm2'), 'fasm2');
    assert.strictEqual(detectDialect('reptile_count = 5\n', 'fasm2'), 'fasm2');
  });
});
