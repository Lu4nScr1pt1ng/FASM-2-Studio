import * as assert from 'assert';
import { getDocumentSymbols } from '../src/features/documentSymbols';
import { Workspace } from '../src/workspace';

describe('getDocumentSymbols', () => {
  it('nests a local label under its parent global label', () => {
    const ws = new Workspace();
    const uri = 'file:///synthetic.asm';
    const doc = ws.updateDocument(uri, 1, 'start:\n\tnop\n.loop:\n\tjmp .loop\n', 'fasm2');

    const symbols = getDocumentSymbols(doc);
    const start = symbols.find((s) => s.name === 'start');
    assert.ok(start);
    assert.strictEqual(start!.children!.length, 1);
    assert.strictEqual(start!.children![0].name, '.loop');
  });

  it('never sends a falsy-named symbol to the client (VS Code rejects it and fails the whole request)', () => {
    const ws = new Workspace();
    const uri = 'file:///anonymous-macro.asm';
    // Regression test: fasmg's anonymous-macro idiom ("macro ? args") used to be parsed with an
    // empty name (baseName() over-stripped the bare "?"), which crashed textDocument/documentSymbol
    // client-side with "name must not be falsy". Fixed at the parser, but this also verifies the
    // defensive filter here holds even if some other future parse path produced an empty name.
    const doc = ws.updateDocument(uri, 1, 'macro ? line&\n\tline\nend macro\n', 'fasm2');

    const symbols = getDocumentSymbols(doc);
    assert.ok(symbols.every((s) => s.name), 'no DocumentSymbol may have a falsy name');
    assert.ok(symbols.some((s) => s.name === '?'), 'the anonymous macro should still appear, named "?"');
  });

  it('maps every symbol kind to a distinct LSP symbol kind', () => {
    const ws = new Workspace();
    const uri = 'file:///kinds.asm';
    const src = ['CAP = 1', 'macro foo? a*\nend macro', 'struct point\nends', 'start:\n\tnop'].join('\n');
    const doc = ws.updateDocument(uri, 1, src, 'fasm2');

    const symbols = getDocumentSymbols(doc);
    const byName = (name: string) => symbols.find((s) => s.name === name);
    assert.notStrictEqual(byName('CAP')?.kind, byName('foo')?.kind);
    assert.notStrictEqual(byName('foo')?.kind, byName('point')?.kind);
    assert.notStrictEqual(byName('point')?.kind, byName('start')?.kind);
  });

  it('leaves an orphaned local label (no preceding global label) at the top level rather than dropping it', () => {
    const ws = new Workspace();
    const uri = 'file:///orphan-local.asm';
    const doc = ws.updateDocument(uri, 1, '.orphan:\n\tnop\n', 'fasm2');

    const symbols = getDocumentSymbols(doc);
    assert.strictEqual(symbols.length, 1);
    assert.strictEqual(symbols[0].name, '.orphan');
  });
});
