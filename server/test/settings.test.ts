import * as assert from 'assert';
import { Connection } from 'vscode-languageserver/node';
import { DEFAULT_SETTINGS, FasmSettings, flattenIncoming, normalizeCompilerArgs, SettingsStore } from '../src/settings';

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

describe('SettingsStore.configuredCompilerPaths', () => {
  /** A connection just real enough for SettingsStore.pull to resolve — per-folder configuration
   * comes from whatever this map holds for the folder's own scopeUri (undefined for window-wide),
   * mirroring how a real client answers workspace/configuration per requested scope. */
  function fakeConnection(byScope: Map<string | undefined, Partial<FasmSettings>>): Connection {
    return {
      workspace: {
        getConfiguration: async (params: { scopeUri?: string }) => byScope.get(params.scopeUri) ?? {},
      },
    } as unknown as Connection;
  }

  it('returns just the window-wide path when no folder overrides it', () => {
    const store = new SettingsStore(fakeConnection(new Map()));
    store.applyPushedSettings({ fasm2CompilerPath: '/opt/fasm2/fasm2' });
    assert.deepStrictEqual(store.configuredCompilerPaths('fasm2'), ['/opt/fasm2/fasm2']);
  });

  it('reads the other dialect\'s own setting, not fasm2\'s', () => {
    const store = new SettingsStore(fakeConnection(new Map()));
    store.applyPushedSettings({ fasm2CompilerPath: '/opt/fasm2/fasm2', fasm1CompilerPath: '/opt/fasm1/fasm1' });
    assert.deepStrictEqual(store.configuredCompilerPaths('fasm1'), ['/opt/fasm1/fasm1']);
  });

  it('drops blanks, so "unset" never becomes a literal empty-string entry', () => {
    const store = new SettingsStore(fakeConnection(new Map()));
    store.applyPushedSettings({ fasm2CompilerPath: '   ' });
    assert.deepStrictEqual(store.configuredCompilerPaths('fasm2'), []);
  });

  it('unions every folder\'s own configured path with the window-wide one, deduplicated', async () => {
    const folderA = 'file:///workspace/a';
    const folderB = 'file:///workspace/b';
    const store = new SettingsStore(
      fakeConnection(
        new Map([
          [folderA, { fasm2CompilerPath: '/opt/fasm2-x/fasm2' }],
          // Same path as the window-wide default — must not appear twice.
          [folderB, { fasm2CompilerPath: '/opt/fasm2/fasm2' }],
        ]),
      ),
    );
    store.applyPushedSettings({ fasm2CompilerPath: '/opt/fasm2/fasm2' });
    store.setPullSupported(true);
    store.setWorkspaceFolders([folderA, folderB]);
    await store.warmAll();

    assert.deepStrictEqual(new Set(store.configuredCompilerPaths('fasm2')), new Set(['/opt/fasm2/fasm2', '/opt/fasm2-x/fasm2']));
  });
});
