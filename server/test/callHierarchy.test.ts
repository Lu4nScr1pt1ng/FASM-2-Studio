import * as assert from 'assert';
import { CallHierarchyItem } from 'vscode-languageserver/node';
import { incomingCalls, outgoingCalls, prepareCallHierarchy } from '../src/features/callHierarchy';
import { Workspace } from '../src/workspace';

const mainUri = 'file:///project/main.asm';
const libUri = 'file:///project/lib.inc';

const MAIN = [
  'format ELF64 executable 3', // 0
  "include 'lib.inc'", //         1
  'entry start', //               2
  '', //                          3
  'segment readable executable', //4
  'start:', //                    5
  '\tcall setup', //              6
  '\tcall work', //               7
  '\tjmp exit_now', //            8
  '', //                          9
  'setup:', //                    10
  '\tmov eax, 1', //              11
  '\tret', //                     12
  '', //                          13
  'work:', //                     14
  '\tcall setup', //              15
  '\tret', //                     16
  '', //                          17
  'exit_now:', //                 18
  '\tsyscall', //                 19
].join('\n');

const LIB = ['macro shutdown', '\tmov eax, 60', 'end macro'].join('\n');

function workspace(main = MAIN): Workspace {
  const ws = new Workspace();
  ws.updateDocument(mainUri, 1, main, 'fasm2');
  ws.updateDocument(libUri, 1, LIB, 'fasm2');
  return ws;
}

function root(ws: Workspace, word: string): CallHierarchyItem {
  const items = prepareCallHierarchy(ws, mainUri, 'fasm2', word);
  assert.strictEqual(items.length, 1, `expected to root the tree at '${word}'`);
  return items[0];
}

describe('prepareCallHierarchy', () => {
  it('roots the tree at a label', () => {
    const item = root(workspace(), 'setup');
    assert.strictEqual(item.name, 'setup');
    assert.strictEqual(item.uri, mainUri);
    assert.deepStrictEqual(item.selectionRange.start, { line: 10, character: 0 });
  });

  it('covers the routine body, so selecting the node reveals it', () => {
    const item = root(workspace(), 'setup');
    assert.strictEqual(item.range.start.line, 10);
    // Up to the line before "work:".
    assert.strictEqual(item.range.end.line, 13);
  });

  it('roots at a macro reached through an include', () => {
    const item = root(workspace(), 'shutdown');
    assert.strictEqual(item.uri, libUri);
    assert.strictEqual(item.detail, 'macro');
  });

  it('offers nothing for a constant, which nothing calls', () => {
    const ws = workspace([MAIN, 'BUFFER_SIZE = 64'].join('\n'));
    assert.deepStrictEqual(prepareCallHierarchy(ws, mainUri, 'fasm2', 'BUFFER_SIZE'), []);
  });

  it('offers nothing for a name that resolves to no symbol at all', () => {
    assert.deepStrictEqual(prepareCallHierarchy(workspace(), mainUri, 'fasm2', 'not_a_symbol'), []);
  });
});

describe('incomingCalls', () => {
  it('finds every routine that reaches this one', () => {
    const ws = workspace();
    const callers = incomingCalls(ws, root(ws, 'setup'));
    assert.deepStrictEqual(callers.map((c) => c.from.name).sort(), ['start', 'work']);
  });

  it('groups several references from one caller under a single node', () => {
    const main = MAIN.replace('\tcall work', '\tcall setup\n\tcall work');
    const ws = workspace(main);
    const callers = incomingCalls(ws, root(ws, 'setup'));
    const start = callers.find((c) => c.from.name === 'start');
    assert.strictEqual(start?.fromRanges.length, 2, 'both call sites belong to the same caller node');
  });

  it('reports the call site, not the whole calling routine', () => {
    const ws = workspace();
    const callers = incomingCalls(ws, root(ws, 'setup'));
    const work = callers.find((c) => c.from.name === 'work');
    assert.strictEqual(work?.fromRanges[0].start.line, 15);
  });

  it('counts a jmp as an edge, since a tail call is how assembly leaves a routine', () => {
    const ws = workspace();
    const callers = incomingCalls(ws, root(ws, 'exit_now'));
    assert.deepStrictEqual(callers.map((c) => c.from.name), ['start']);
  });

  it('finds nothing for a routine nobody reaches', () => {
    const ws = workspace();
    assert.deepStrictEqual(incomingCalls(ws, root(ws, 'start')), []);
  });

  it('ignores an item it did not produce', () => {
    const ws = workspace();
    const bogus = { name: 'x', kind: 12, uri: mainUri, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, selectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } };
    assert.deepStrictEqual(incomingCalls(ws, bogus as CallHierarchyItem), []);
  });
});

describe('outgoingCalls', () => {
  it('finds every routine reached from this one', () => {
    const ws = workspace();
    const callees = outgoingCalls(ws, 'fasm2', root(ws, 'start'));
    assert.deepStrictEqual(callees.map((c) => c.to.name).sort(), ['exit_now', 'setup', 'work']);
  });

  it('stops at the end of the routine body rather than running on into the next one', () => {
    const ws = workspace();
    // "work" calls only "setup"; it must not also report what "exit_now" below it reaches.
    const callees = outgoingCalls(ws, 'fasm2', root(ws, 'work'));
    assert.deepStrictEqual(callees.map((c) => c.to.name), ['setup']);
  });

  it('reaches a macro defined in an included file', () => {
    const main = MAIN.replace('\tsyscall', '\tshutdown');
    const ws = workspace(main);
    const callees = outgoingCalls(ws, 'fasm2', root(ws, 'exit_now'));
    assert.deepStrictEqual(callees.map((c) => c.to.name), ['shutdown']);
    assert.strictEqual(callees[0].to.uri, libUri);
  });

  it('finds nothing for a leaf routine', () => {
    const ws = workspace();
    assert.deepStrictEqual(outgoingCalls(ws, 'fasm2', root(ws, 'setup')), []);
  });
});
