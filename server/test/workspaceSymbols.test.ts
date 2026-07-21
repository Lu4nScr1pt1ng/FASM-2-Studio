import * as assert from 'assert';
import { getWorkspaceSymbols } from '../src/features/workspaceSymbols';
import { Workspace } from '../src/workspace';

describe('getWorkspaceSymbols', () => {
  it('finds a symbol by name across the indexed workspace', () => {
    const ws = new Workspace();
    ws.updateDocument('file:///a.asm', 1, 'SHARED_CONST = 1\n', 'fasm2');

    const results = getWorkspaceSymbols(ws, 'SHARED_CONST');
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].name, 'SHARED_CONST');
  });

  it('never sends a falsy-named symbol to the client (VS Code rejects it and fails the whole request)', () => {
    const ws = new Workspace();
    // Same anonymous-macro scenario as documentSymbols.test.ts's regression test — verifies the
    // defensive filter here holds too, independent of the one in documentSymbols.ts.
    ws.updateDocument('file:///anonymous-macro.asm', 1, 'macro ? line&\n\tline\nend macro\n', 'fasm2');

    const results = getWorkspaceSymbols(ws, '?');
    assert.ok(results.every((s) => s.name), 'no SymbolInformation may have a falsy name');
  });
});
