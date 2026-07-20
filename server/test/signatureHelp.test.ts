import * as assert from 'assert';
import { getSignatureHelp } from '../src/features/signatureHelp';
import { Workspace } from '../src/workspace';

describe('signatureHelp', () => {
  it('shows a macro signature and tracks the active parameter across commas', () => {
    const ws = new Workspace();
    const uri = 'file:///macros.asm';
    ws.updateDocument(uri, 1, 'macro point? x*,y*,z*\n\tdd x,y,z\nend macro\n', 'fasm2');

    const help0 = getSignatureHelp(ws, uri, 'fasm2', 'point ');
    assert.ok(help0);
    assert.strictEqual(help0!.signatures[0].parameters!.length, 3);
    assert.strictEqual(help0!.activeParameter, 0);

    const help1 = getSignatureHelp(ws, uri, 'fasm2', 'point 1, ');
    assert.strictEqual(help1!.activeParameter, 1);

    const help2 = getSignatureHelp(ws, uri, 'fasm2', 'point 1, 2, ');
    assert.strictEqual(help2!.activeParameter, 2);
  });

  it('does not miscount commas nested inside brackets or strings', () => {
    const ws = new Workspace();
    const uri = 'file:///macros2.asm';
    ws.updateDocument(uri, 1, 'macro call? fn*,args*\nend macro\n', 'fasm2');

    // Two real top-level commas (after "[ebx, 4]" and after "'a,b'") should count; the ones
    // nested inside the brackets and the string must not.
    const help = getSignatureHelp(ws, uri, 'fasm2', "call [ebx, 4], 'a,b', ");
    assert.strictEqual(help!.activeParameter, 2);
  });

  it('falls back to static instruction operand data for known mnemonics', () => {
    const ws = new Workspace();
    const help = getSignatureHelp(ws, 'file:///none.asm', 'fasm2', 'mov ');
    assert.ok(help, 'expected a signature for "mov"');
    assert.match(help!.signatures[0].label, /^mov /);
  });

  it('returns undefined for an unknown callee', () => {
    const ws = new Workspace();
    const help = getSignatureHelp(ws, 'file:///none.asm', 'fasm2', 'totallyUnknownThing ');
    assert.strictEqual(help, undefined);
  });
});
