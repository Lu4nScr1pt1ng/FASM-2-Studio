import * as assert from 'assert';
import { DEFAULT_SETTINGS, flattenIncoming, normalizeCompilerArgs } from '../src/settings';

// What arrives here is whatever is written in the user's settings.json, and it is about to become
// the argument list of a spawned assembler — so the shapes that are *not* an array of arguments
// matter more than the one that is.
describe('normalizeCompilerArgs', () => {
  it('keeps a well-formed list as written, including an argument containing spaces', () => {
    assert.deepStrictEqual(normalizeCompilerArgs(['-i', 'define BUILD_MODE 1', '-p', '300']), ['-i', 'define BUILD_MODE 1', '-p', '300']);
  });

  it('rejects a bare string, which would otherwise spread into one argument per character', () => {
    assert.deepStrictEqual(normalizeCompilerArgs('-p 300'), []);
  });

  it('rejects the other non-array shapes a hand-edited settings file can hold', () => {
    for (const value of [undefined, null, 42, true, { '-p': '300' }]) {
      assert.deepStrictEqual(normalizeCompilerArgs(value), [], `expected ${JSON.stringify(value)} to be treated as unset`);
    }
  });

  it('drops non-string and blank entries rather than passing them to the assembler', () => {
    // An empty argument reaches the assembler as a second positional parameter — an output file
    // named "" — failing the build for a reason invisible in the settings that caused it.
    assert.deepStrictEqual(normalizeCompilerArgs(['-p', 300, '', '   ', null, '-n']), ['-p', '-n']);
  });
});

describe('flattenIncoming', () => {
  it('normalizes compilerArgs even when no format section is present', () => {
    const flattened = flattenIncoming({ compilerArgs: 'not an array' } as never);
    assert.deepStrictEqual(flattened.compilerArgs, []);
  });

  it('still lifts the nested format.* keys onto the flat shape', () => {
    const flattened = flattenIncoming({ format: { mnemonicColumn: 12, operandColumn: 24 } });
    assert.strictEqual(flattened.formatMnemonicColumn, 12);
    assert.strictEqual(flattened.formatOperandColumn, 24);
    assert.strictEqual(flattened.formatCommentColumn, DEFAULT_SETTINGS.formatCommentColumn);
  });

  it('leaves an absent compilerArgs as the default empty list', () => {
    assert.deepStrictEqual(flattenIncoming({}).compilerArgs, []);
  });
});
