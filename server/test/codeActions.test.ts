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

/** A word range for the quick fixes that rewrite the word in place. The exact position does not
 * matter to any assertion here — only that one is supplied, since without it the spelling fixes are
 * skipped entirely. */
const wordRange = { start: { line: 5, character: 1 }, end: { line: 5, character: 10 } };

describe('getCodeActions', () => {
  it('offers an include for a symbol that exists elsewhere but is not reachable from here', () => {
    const ws = workspaceWithBoth();
    const actions = getCodeActions(ws, mainUri, 'fasm2', 'print_msg', wordRange, MAIN);
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
    assert.deepStrictEqual(getCodeActions(ws, mainUri, 'fasm2', 'print_msg', wordRange, withInclude), []);
  });

  it('offers nothing for a symbol this very file defines', () => {
    const ws = workspaceWithBoth();
    assert.deepStrictEqual(getCodeActions(ws, mainUri, 'fasm2', 'start', wordRange, MAIN), []);
  });

  it('offers nothing for a name nothing in the workspace defines', () => {
    const ws = workspaceWithBoth();
    assert.deepStrictEqual(getCodeActions(ws, mainUri, 'fasm2', 'never_defined_anywhere', wordRange, MAIN), []);
  });

  it('offers one action per defining file, and does not mark any preferred when there is a choice', () => {
    const ws = workspaceWithBoth();
    ws.updateDocument('file:///project/other.inc', 1, LIB, 'fasm2');
    const actions = getCodeActions(ws, mainUri, 'fasm2', 'print_msg', wordRange, MAIN);
    assert.strictEqual(actions.length, 2);
    assert.ok(!actions.some((a) => a.isPreferred), 'must not prefer an arbitrary one of several equally plausible files');
  });
});

describe('getCodeActions — misspellings', () => {
  /** An x86 entry point, so the static instruction/register tables are in the candidate pool. */
  const X86 = ['format ELF64 executable 3', 'entry start', '', 'segment readable executable', 'start:', '\tmov eax, 1', '\tret'].join('\n');

  function x86Workspace(text = X86): Workspace {
    const ws = new Workspace();
    ws.updateDocument(mainUri, 1, text, 'fasm2');
    return ws;
  }

  function titles(word: string, text = X86): string[] {
    return getCodeActions(x86Workspace(text), mainUri, 'fasm2', word, wordRange, text).map((a) => a.title);
  }

  it('offers the right spelling for a misspelled mnemonic', () => {
    const actions = getCodeActions(x86Workspace(), mainUri, 'fasm2', 'movv', wordRange, X86);
    assert.ok(actions.some((a) => a.title === "Change 'movv' to 'mov'"), JSON.stringify(actions.map((a) => a.title)));
  });

  it('rewrites the word in place rather than editing anywhere else', () => {
    const actions = getCodeActions(x86Workspace(), mainUri, 'fasm2', 'movv', wordRange, X86);
    const edits = actions[0].edit?.changes?.[mainUri];
    assert.ok(edits && edits.length === 1);
    assert.deepStrictEqual(edits[0].range, wordRange);
    assert.strictEqual(edits[0].newText, 'mov');
  });

  it('calls out a pure case difference, which fasm2 rejects but fasm1 would accept', () => {
    assert.deepStrictEqual(titles('MOV'), ["Change 'MOV' to 'mov' (this dialect is case-sensitive)"]);
  });

  it('offers nothing for a correctly spelled mnemonic', () => {
    assert.deepStrictEqual(titles('mov'), []);
  });

  it('offers nothing for a correctly spelled register or directive', () => {
    assert.deepStrictEqual(titles('eax'), []);
    assert.deepStrictEqual(titles('format'), []);
  });

  it('suggests the project\'s own label for a misspelled reference to it', () => {
    const text = [X86, 'message_loop:', '\tjmp message_loop'].join('\n');
    assert.ok(titles('message_lop', text).includes("Change 'message_lop' to 'message_loop'"));
  });

  it('leaves a macro parameter alone, since it is used like a symbol but never defined as one', () => {
    const text = ['macro store dest, source', '\tmov dest, source', 'end macro'].join('\n');
    assert.deepStrictEqual(titles('dest', text), []);
    assert.deepStrictEqual(titles('source', text), []);
  });

  it('says nothing about a word too short for a one-character difference to mean anything', () => {
    // "ax" is one edit from "al", "ah", "bx" and a dozen more real registers — none of which is a
    // correction, and all of which would be noise on a name that is very likely deliberate.
    assert.deepStrictEqual(titles('az'), []);
  });

  it('offers nothing at all when the caller could not determine the word\'s range', () => {
    const actions = getCodeActions(x86Workspace(), mainUri, 'fasm2', 'movv', undefined, X86);
    assert.deepStrictEqual(actions, []);
  });

  it('caps how many alternatives it offers', () => {
    const actions = getCodeActions(x86Workspace(), mainUri, 'fasm2', 'mox', wordRange, X86);
    assert.ok(actions.length <= 3, `expected at most 3, got ${JSON.stringify(actions.map((a) => a.title))}`);
  });
});
