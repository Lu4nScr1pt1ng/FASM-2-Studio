import * as assert from 'assert';
import { getReferences } from '../src/features/references';
import { getRenameEdit, isRenameable } from '../src/features/rename';
import { Workspace } from '../src/workspace';

const uri = 'file:///scoped.asm';

// Mirrors a real, confirmed bug: fasmg's own packages/x86/include/8051.inc declares "value"
// `local` in 40 different, unrelated macros. Before findScopedReferences existed, find-references/
// rename on such a name ignored SymbolDefinition.localScope entirely (unlike hover/go-to-definition,
// which already filtered it) and returned/renamed every macro's private "value" workspace-wide.
const src = [
  'format binary',
  'macro macroA',
  '\tlocal value',
  '\tvalue = 1',
  '\tmov eax, value',
  'end macro',
  'macro macroB',
  '\tlocal value',
  '\tvalue = 2',
  '\tmov ebx, value',
  'end macro',
].join('\n');
// Line numbers (0-based): 1 "macro macroA", 2 "local value", 3 "value = 1", 4 "mov eax, value",
// 5 "end macro", 6 "macro macroB", 7 "local value", 8 "value = 2", 9 "mov ebx, value", 10 "end macro".
// The "local value" line only registers the name (SymbolIndex.enclosingLocalFrame); the actual
// SymbolDefinition is created at its first assignment ("value = 1"/"value = 2"), so declarations
// land on lines 3/8, not 2/7.

describe('findScopedReferences (via getReferences/getRenameEdit/isRenameable)', () => {
  it('getReferences scopes a local-scoped name to only its own enclosing macro, not every same-named local workspace-wide', () => {
    const ws = new Workspace();
    ws.updateDocument(uri, 1, src, 'fasm2');

    // Queried from inside macroA's own body (line 3, "value = 1").
    const refs = getReferences(ws, uri, 3, 'value', true);
    const lines = refs.map((r) => r.range.start.line).sort((a, b) => a - b);
    assert.deepStrictEqual(lines, [3, 4], `expected only macroA's own declaration+use, got lines: ${lines}`);
  });

  it('getReferences scopes to macroB when queried from inside macroB instead', () => {
    const ws = new Workspace();
    ws.updateDocument(uri, 1, src, 'fasm2');

    const refs = getReferences(ws, uri, 9, 'value', true);
    const lines = refs.map((r) => r.range.start.line).sort((a, b) => a - b);
    assert.deepStrictEqual(lines, [8, 9], `expected only macroB's own declaration+use, got lines: ${lines}`);
  });

  it('isRenameable/getRenameEdit only touch the one in-scope macro\'s local, leaving the other macro\'s same-named local untouched', () => {
    const ws = new Workspace();
    ws.updateDocument(uri, 1, src, 'fasm2');

    assert.strictEqual(isRenameable(ws, uri, 3, 'value'), true);

    const edit = getRenameEdit(ws, uri, 3, 'value', 'renamed');
    assert.ok(edit?.changes?.[uri], 'expected an edit for the document');
    const editedLines = edit!.changes![uri].map((e) => e.range.start.line).sort((a, b) => a - b);
    assert.deepStrictEqual(editedLines, [3, 4], `rename must not touch macroB's unrelated "value" (lines 8-9), got: ${editedLines}`);
  });
});
