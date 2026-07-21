import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { URI } from 'vscode-uri';
import { getSignatureHelp } from '../src/features/signatureHelp';
import { Workspace } from '../src/workspace';

const dialectAlwaysFasm2 = () => 'fasm2' as const;

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

  it('shows a signature for a "struc"-defined labeled instruction called as "LABEL struc-name args", not just a plain macro call', () => {
    // Found while validating against manual.txt section 9 ("Labeled macroinstructions"): a struc is
    // invoked as "LABEL struc-name args" (the struc name is the *second* token, e.g. "wc WNDCLASS"
    // for the "struct" convenience macro's own instances), so the plain-macro-call assumption
    // (callee name is the first token) never found it at all.
    const ws = new Workspace();
    const uri = 'file:///strucs.asm';
    ws.updateDocument(uri, 1, 'struc mystruc arg1,arg2\n\tdb arg1\nend struc\n', 'fasm2');

    const help = getSignatureHelp(ws, uri, 'fasm2', 'lbl mystruc ');
    assert.ok(help, 'expected a signature for the labeled "mystruc" call');
    assert.strictEqual(help!.signatures[0].parameters!.length, 2);
    assert.strictEqual(help!.activeParameter, 0);
  });

  it('returns undefined for an unknown callee', () => {
    const ws = new Workspace();
    const help = getSignatureHelp(ws, 'file:///none.asm', 'fasm2', 'totallyUnknownThing ');
    assert.strictEqual(help, undefined);
  });

  it('finds a macro defined in a sibling fragment neither includes directly, both reachable only via their shared entry point', async () => {
    // Regression test for the same underlying bug fixed in workspace.ts's walkIncludeGraph: cc.asm
    // includes both callsite.asm and macros.inc, but callsite.asm doesn't include macros.inc
    // itself — signature help while typing a call in callsite.asm must still find the macro.
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fasm2-studio-sighelp-test-'));
    try {
      const writeFile = async (name: string, content: string): Promise<string> => {
        const fsPath = path.join(tmpDir, name);
        await fs.writeFile(fsPath, content, 'utf8');
        return URI.file(fsPath).toString();
      };

      const macrosUri = await writeFile('macros.inc', 'macro point? x*,y*,z*\n\tdd x,y,z\nend macro\n');
      const callsiteUri = await writeFile('callsite.asm', 'start:\n\tnop\n');
      const mainUri = await writeFile('cc.asm', "format binary\ninclude 'callsite.asm'\ninclude 'macros.inc'\n");

      const ws = new Workspace();
      await ws.indexWorkspace([mainUri, callsiteUri, macrosUri], dialectAlwaysFasm2);

      const help = getSignatureHelp(ws, callsiteUri, 'fasm2', 'point 1, ');
      assert.ok(help, 'expected signature help for "point", reachable via the shared entry point cc.asm');
      assert.strictEqual(help!.activeParameter, 1);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
