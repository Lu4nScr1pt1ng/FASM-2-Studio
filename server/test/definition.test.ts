import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as path from 'path';
import { URI } from 'vscode-uri';
import { getDefinitions } from '../src/features/definition';
import { Workspace } from '../src/workspace';
import { makeTempDir, removeTempDir } from './tempDir';

describe('getDefinitions', () => {
  it('jumps to the include target when the position is over its path string', async () => {
    // resolveIncludeUri checks the real filesystem, so this needs real files, not synthetic URIs.
    const tmpDir = makeTempDir('fasm2-studio-definition-test-');
    try {
      const mainFsPath = path.join(tmpDir, 'main.asm');
      const targetFsPath = path.join(tmpDir, 'lib.inc');
      await fs.writeFile(mainFsPath, "format binary\ninclude 'lib.inc'\n", 'utf8');
      await fs.writeFile(targetFsPath, 'X = 1\n', 'utf8');
      const uri = URI.file(mainFsPath).toString();
      const targetUri = URI.file(targetFsPath).toString();

      const ws = new Workspace();
      ws.updateDocument(uri, 1, "format binary\ninclude 'lib.inc'\n", 'fasm2');
      ws.updateDocument(targetUri, 1, 'X = 1\n', 'fasm2');

      const defs = getDefinitions(ws, uri, 'fasm2', 'lib.inc', { line: 1, character: 12 });
      assert.strictEqual(defs.length, 1);
      assert.strictEqual(defs[0].uri, targetUri);
    } finally {
      await removeTempDir(tmpDir);
    }
  });

  it('resolves a `local` variable to the one enclosing macro actually in scope, not an unrelated macro that happens to declare the same name', () => {
    // Mirrors a real bug found in fasmg's own core/examples/8051/8051.inc: dozens of unrelated
    // macros each declare their own private "value" via `local` — before scoping this,
    // go-to-definition on "value" always jumped to whichever macro happened to come first in the
    // file, regardless of which macro's body you were actually in.
    const uri = 'file:///8051.inc';
    const src = [
      'format binary',
      'macro AJMP addr',
      '\tlocal value',
      '\tvalue = 1111h',
      'end macro',
      'macro LJMP addr',
      '\tlocal value',
      '\tvalue = 2222h',
      'end macro',
    ].join('\n');
    const ws = new Workspace();
    ws.updateDocument(uri, 1, src, 'fasm2');

    // Line 3 (0-based) is AJMP's own "value = 1111h"; line 7 is LJMP's own "value = 2222h".
    const defsInAJMP = getDefinitions(ws, uri, 'fasm2', 'value', { line: 3, character: 3 });
    assert.deepStrictEqual(defsInAJMP.map((d) => d.range.start.line), [3]);

    const defsInLJMP = getDefinitions(ws, uri, 'fasm2', 'value', { line: 7, character: 3 });
    assert.deepStrictEqual(defsInLJMP.map((d) => d.range.start.line), [7]);
  });

  it('returns nothing for a `local` variable queried from outside every macro that declares it, rather than an arbitrary wrong one', () => {
    const uri = 'file:///8051.inc';
    const src = [
      'format binary',
      'macro AJMP addr',
      '\tlocal value',
      '\tvalue = 1111h',
      'end macro',
      'nop',
    ].join('\n');
    const ws = new Workspace();
    ws.updateDocument(uri, 1, src, 'fasm2');

    // Line 5 (0-based, the trailing "nop") is outside AJMP's body entirely.
    const defs = getDefinitions(ws, uri, 'fasm2', 'value', { line: 5, character: 0 });
    assert.deepStrictEqual(defs, []);
  });

  it('jumps to a struct field\'s own definition line from its fully-qualified "StructName.field" name', () => {
    // Real user-reported scenario: real code always references a struct field fully qualified
    // (fasmg's struct package wraps the whole body in "namespace <name>"), e.g.
    // "[ebx+MatchedExcerpt.matcher]" -- go-to-definition on that exact token found nothing before
    // this, since only the bare field name was ever indexed.
    const uri = 'file:///matched.asm';
    const src = ['format binary', 'struct MatchedExcerpt', '\tmatcher dd ?', 'ends'].join('\n');
    const ws = new Workspace();
    ws.updateDocument(uri, 1, src, 'fasm2');

    const defs = getDefinitions(ws, uri, 'fasm2', 'MatchedExcerpt.matcher', { line: 0, character: 0 });
    assert.strictEqual(defs.length, 1);
    assert.strictEqual(defs[0].range.start.line, 2); // "matcher dd ?"
  });

  it('jumps to the struct\'s own definition line from its auto-generated "sizeof.<StructName>" companion constant', () => {
    const uri = 'file:///recognition.asm';
    const src = ['format binary', 'struct RecognitionContext', '\tbase_namespace dd ?', 'ends'].join('\n');
    const ws = new Workspace();
    ws.updateDocument(uri, 1, src, 'fasm2');

    const defs = getDefinitions(ws, uri, 'fasm2', 'sizeof.RecognitionContext', { line: 0, character: 0 });
    assert.strictEqual(defs.length, 1);
    assert.strictEqual(defs[0].range.start.line, 1); // "struct RecognitionContext"
  });

  it('jumps to a struct field\'s definition through a struct *instance* ("instanceName.field"), and to the instance\'s own declaration line', () => {
    // Real user-reported follow-up: "assembly_workspace Workspace" declares an instance, and real
    // code references its fields through that instance name, not the struct type name.
    const uri = 'file:///workspace.asm';
    const src = ['format binary', 'struct Workspace', '\tmemory_start dd ?', '\tmemory_end dd ?', 'ends', '', 'assembly_workspace Workspace'].join('\n');
    const ws = new Workspace();
    ws.updateDocument(uri, 1, src, 'fasm2');

    const fieldDefs = getDefinitions(ws, uri, 'fasm2', 'assembly_workspace.memory_start', { line: 0, character: 0 });
    assert.strictEqual(fieldDefs.length, 1);
    assert.strictEqual(fieldDefs[0].range.start.line, 2); // "memory_start dd ?"

    const instanceDefs = getDefinitions(ws, uri, 'fasm2', 'assembly_workspace', { line: 0, character: 0 });
    assert.strictEqual(instanceDefs.length, 1);
    assert.strictEqual(instanceDefs[0].range.start.line, 6); // "assembly_workspace Workspace"
  });

  it('does not jump anywhere for an ordinary macro invocation with one bare argument, despite the identical "IDENT1 IDENT2" shape as a real struct instantiation', () => {
    const uri = 'file:///macro-call.asm';
    const src = ['format binary', 'macro write_msg target', '\tcall target', 'end macro', '', 'write_msg usage_text'].join('\n');
    const ws = new Workspace();
    ws.updateDocument(uri, 1, src, 'fasm2');

    assert.deepStrictEqual(getDefinitions(ws, uri, 'fasm2', 'write_msg.anything', { line: 0, character: 0 }), []);
  });
});
