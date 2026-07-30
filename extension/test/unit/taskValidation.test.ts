import * as assert from 'assert';
import { validateTaskDefinition } from '../../src/taskValidation';

describe('validateTaskDefinition', () => {
  it('accepts a minimal valid definition (just "file")', () => {
    assert.strictEqual(validateTaskDefinition({ file: 'main.asm' }), undefined);
  });

  it('accepts every field filled in with the right shape', () => {
    assert.strictEqual(
      validateTaskDefinition({ file: 'main.asm', output: 'bin/main', dialect: 'fasm1', extraArgs: ['-e', '5'], debugBuild: true }),
      undefined,
    );
  });

  it('rejects a missing or non-string "file"', () => {
    assert.match(validateTaskDefinition({})!, /"file"/);
    assert.match(validateTaskDefinition({ file: '' })!, /"file"/);
    assert.match(validateTaskDefinition({ file: 123 })!, /"file"/);
  });

  it('rejects a non-string "output"', () => {
    assert.match(validateTaskDefinition({ file: 'main.asm', output: 42 })!, /"output"/);
  });

  it('rejects a "dialect" that is not "fasm2"/"fasm1"', () => {
    assert.match(validateTaskDefinition({ file: 'main.asm', dialect: 'fasm3' })!, /"dialect"/);
  });

  it('rejects "extraArgs" that is not an array of strings', () => {
    assert.match(validateTaskDefinition({ file: 'main.asm', extraArgs: 'foo' })!, /"extraArgs"/);
    assert.match(validateTaskDefinition({ file: 'main.asm', extraArgs: ['ok', 5] })!, /"extraArgs"/);
  });

  it('rejects a non-boolean "debugBuild"', () => {
    assert.match(validateTaskDefinition({ file: 'main.asm', debugBuild: 'yes' })!, /"debugBuild"/);
  });
});
