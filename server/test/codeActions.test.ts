import * as assert from 'assert';
import { getCodeActions, includeInsertLine, includePathFor } from '../src/features/codeActions';
import { Workspace } from '../src/workspace';

const mainUri = 'file:///project/main.asm';
const libUri = 'file:///project/lib/helpers.inc';

const MAIN = ['format ELF64 executable 3', 'entry start', '', 'segment readable executable', 'start:', '\tprint_msg', '\tret'].join('\n');
const LIB = ['macro print_msg', '\tmov eax, 1', 'end macro'].join('\n');

function workspaceWithBoth(): Workspace {
  const ws = new Workspace();
  ws.updateDocument(mainUri, 1, MAIN, 'fasm2');
  ws.updateDocument(libUri, 1, LIB, 'fasm2');
  return ws;
}

describe('includePathFor', () => {
  it('builds a path relative to the including file, with forward slashes', () => {
    assert.strictEqual(includePathFor('file:///project/main.asm', 'file:///project/lib/helpers.inc'), 'lib/helpers.inc');
  });

  it('keeps a "../" prefix when the target is outside the including file\'s directory', () => {
    assert.strictEqual(includePathFor('file:///project/src/main.asm', 'file:///project/helpers.inc'), '../helpers.inc');
  });

  it('drops a redundant "./" for a sibling file', () => {
    assert.strictEqual(includePathFor('file:///project/main.asm', 'file:///project/helpers.inc'), 'helpers.inc');
  });
});

describe('includeInsertLine', () => {
  it('inserts after the last existing include, so includes stay grouped', () => {
    const ws = new Workspace();
    const text = ['format binary', "include 'a.inc'", "include 'b.inc'", '', 'start:'].join('\n');
    ws.updateDocument(mainUri, 1, text, 'fasm2');
    // "include 'b.inc'" is line 2, so the new one goes on line 3.
    assert.strictEqual(includeInsertLine(ws.getDocument(mainUri)!, text), 3);
  });

  it('inserts after the header directives when there is no include yet', () => {
    const ws = new Workspace();
    const text = ['format ELF64 executable 3', 'entry start', '', 'segment readable executable', 'start:'].join('\n');
    ws.updateDocument(mainUri, 1, text, 'fasm2');
    // After "entry start" — a format/entry pair must stay at the top of the file.
    assert.strictEqual(includeInsertLine(ws.getDocument(mainUri)!, text), 2);
  });

  it('skips a leading comment banner rather than stopping one line too early', () => {
    const ws = new Workspace();
    const text = ['; a banner', '; more banner', 'format binary', 'start:'].join('\n');
    ws.updateDocument(mainUri, 1, text, 'fasm2');
    assert.strictEqual(includeInsertLine(ws.getDocument(mainUri)!, text), 3);
  });

  it('inserts at the top of a file with no header at all', () => {
    const ws = new Workspace();
    const text = ['nop', 'ret'].join('\n');
    ws.updateDocument(mainUri, 1, text, 'fasm2');
    assert.strictEqual(includeInsertLine(ws.getDocument(mainUri)!, text), 0);
  });
});

describe('getCodeActions', () => {
  it('offers an include for a symbol that exists elsewhere but is not reachable from here', () => {
    const ws = workspaceWithBoth();
    const actions = getCodeActions(ws, mainUri, 'fasm2', 'print_msg', MAIN);
    assert.strictEqual(actions.length, 1, `expected one action, got ${JSON.stringify(actions.map((a) => a.title))}`);
    assert.match(actions[0].title, /include 'lib\/helpers\.inc'/);
    assert.strictEqual(actions[0].isPreferred, true);

    const edits = actions[0].edit?.changes?.[mainUri];
    assert.ok(edits && edits.length === 1);
    assert.strictEqual(edits[0].newText, "include 'lib/helpers.inc'\n");
    // After "entry start", the last header line.
    assert.strictEqual(edits[0].range.start.line, 2);
  });

  it('offers nothing once the symbol is already reachable through an include', () => {
    const ws = new Workspace();
    const withInclude = MAIN.replace('entry start', "entry start\ninclude 'lib/helpers.inc'");
    ws.updateDocument(mainUri, 1, withInclude, 'fasm2');
    ws.updateDocument(libUri, 1, LIB, 'fasm2');
    assert.deepStrictEqual(getCodeActions(ws, mainUri, 'fasm2', 'print_msg', withInclude), []);
  });

  it('offers nothing for a symbol this very file defines', () => {
    const ws = workspaceWithBoth();
    assert.deepStrictEqual(getCodeActions(ws, mainUri, 'fasm2', 'start', MAIN), []);
  });

  it('offers nothing for a name nothing in the workspace defines', () => {
    const ws = workspaceWithBoth();
    assert.deepStrictEqual(getCodeActions(ws, mainUri, 'fasm2', 'never_defined_anywhere', MAIN), []);
  });

  it('offers one action per defining file, and does not mark any preferred when there is a choice', () => {
    const ws = workspaceWithBoth();
    ws.updateDocument('file:///project/other.inc', 1, LIB, 'fasm2');
    const actions = getCodeActions(ws, mainUri, 'fasm2', 'print_msg', MAIN);
    assert.strictEqual(actions.length, 2);
    assert.ok(!actions.some((a) => a.isPreferred), 'must not prefer an arbitrary one of several equally plausible files');
  });
});
