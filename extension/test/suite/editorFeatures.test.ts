// Integration coverage for the editor features added to the language server, driven through VS
// Code's own provider commands.
//
// The unit tests already prove each feature computes the right answer; what these prove is that it
// is actually *reachable* — a capability declared in the server's initialize result but whose
// handler was never registered (or vice versa) produces exactly nothing in the editor while every
// unit test still passes.
import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

/**
 * Compares two filesystem paths the way the platform itself would.
 *
 * On Windows a path can differ from an equal path only by the case of its drive letter, and the
 * two sides of these assertions reliably disagree about it: `os.tmpdir()` yields `C:\Users\…`,
 * while anything that has been through a `file:` URI — which is every path the language server
 * hands back, since LSP speaks URIs — comes back from `Uri.fsPath` as `c:\Users\…`. A
 * `strictEqual` on the raw strings therefore fails on Windows for two paths that name the same
 * file. Only the drive letter is folded, not the whole path: NTFS is case-insensitive but its
 * *stored* casing is meaningful to read, so upper-casing everything would turn an assertion
 * failure message into an unreadable one.
 */
function samePath(a: string, b: string): boolean {
  const normalize = (p: string): string => {
    const normalized = path.normalize(p);
    return process.platform === 'win32' ? normalized.replace(/^[a-zA-Z]:/, (drive) => drive.toUpperCase()) : normalized;
  };
  return normalize(a) === normalize(b);
}

/** Retries `read` until it returns something non-empty, since the language server answers these
 * only once it has parsed and indexed the document. */
async function eventually<T>(read: () => Thenable<T | undefined>, isReady: (value: T) => boolean, attempts = 24): Promise<T | undefined> {
  let value: T | undefined;
  for (let attempt = 0; attempt < attempts; attempt++) {
    value = await read();
    if (value !== undefined && isReady(value)) return value;
    await new Promise((r) => setTimeout(r, 250));
  }
  return value;
}

const SOURCE = [
  'format ELF64 executable 3',
  'entry start',
  '',
  'EXIT_CODE = 0',
  '',
  'segment readable executable',
  '',
  'macro save reg',
  'push reg',
  'pop reg',
  'end macro',
  '',
  'start:',
  'mov eax, EXIT_CODE',
  'mov ebx, EXIT_CODE',
  '\tmov edi, EXIT_CODE',
  '\tmov eax, 60',
  '\tsyscall',
  '',
].join('\n');

describe('editor features (real VS Code host)', () => {
  let dir: string;
  let doc: vscode.TextDocument;

  before(async function () {
    this.timeout(30000);
    const ext = vscode.extensions.getExtension('Lu4nScr1pt1ng.fasm2-studio');
    assert.ok(ext, 'extension should be discoverable by id');
    await ext!.activate();

    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fasm2-studio-editor-'));
    const file = path.join(dir, 'features.asm');
    await fs.writeFile(file, SOURCE, 'utf8');
    doc = await vscode.workspace.openTextDocument(file);
    await vscode.window.showTextDocument(doc);
  });

  after(async () => {
    // The formatting test applies a WorkspaceEdit and never saves it, so its editor is dirty by
    // the time this runs. `closeAllEditors` on a dirty editor puts up a modal "save your changes?"
    // that nothing in a test host ever answers — the suite then hangs until the runner's timeout,
    // and the `fs.rm` below never runs at all. Saving first is what makes the close unattended;
    // the files are about to be deleted anyway, so what is written is irrelevant.
    await vscode.workspace.saveAll(false);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    // Never allowed to throw: a cleanup failure here is reported by mocha as the *suite's* error
    // and buries whichever assertion actually failed, which is the far more useful message. A
    // leaked directory under os.tmpdir() is not worth that trade.
    try {
      if (dir) await fs.rm(dir, { recursive: true, force: true });
    } catch (err) {
      console.warn(`could not remove the temp dir ${dir}: ${(err as Error).message}`);
    }
  });

  it('highlights every occurrence of the symbol under the cursor', async function () {
    this.timeout(20000);
    // The "EXIT_CODE" constant, on its own definition line (3), used again on lines 13, 14 and 15.
    const position = new vscode.Position(3, 2);
    const highlights = await eventually(
      () => vscode.commands.executeCommand<vscode.DocumentHighlight[]>('vscode.executeDocumentHighlights', doc.uri, position),
      (h) => h.length > 0,
    );
    assert.ok(highlights && highlights.length >= 3, `expected the definition and its uses, got ${JSON.stringify(highlights)}`);
  });

  it('folds the macro block through the folding range provider', async function () {
    this.timeout(20000);
    const ranges = await eventually(
      () => vscode.commands.executeCommand<vscode.FoldingRange[]>('vscode.executeFoldingRangeProvider', doc.uri),
      (r) => r.length > 0,
    );
    assert.ok(ranges && ranges.length > 0, 'expected at least one folding range');
    // "macro save reg" is line 7; its body ends on line 9, the line before "end macro".
    assert.ok(
      ranges!.some((r) => r.start === 7 && r.end === 9),
      `expected a fold covering the macro body, got ${JSON.stringify(ranges)}`,
    );
  });

  it('formats the document into aligned columns without changing what it assembles', async function () {
    this.timeout(20000);
    const edits = await eventually(
      () =>
        vscode.commands.executeCommand<vscode.TextEdit[]>('vscode.executeFormatDocumentProvider', doc.uri, {
          tabSize: 4,
          insertSpaces: true,
        }),
      (e) => e.length > 0,
    );
    assert.ok(edits && edits.length > 0, 'expected the formatter to produce an edit');

    // Applied rather than inspected directly: VS Code reduces a provider's edits to a minimal
    // diff before returning them, so any individual edit is a fragment (often just the inserted
    // indentation) rather than the formatted document.
    const workspaceEdit = new vscode.WorkspaceEdit();
    workspaceEdit.set(doc.uri, edits!);
    assert.ok(await vscode.workspace.applyEdit(workspaceEdit), 'expected the format edits to apply');

    const formatted = doc.getText();
    assert.match(formatted, /^ {8}mov {5}eax, EXIT_CODE$/m, `expected an aligned mov, got:\n${formatted}`);
    // Structural keywords stay at the margin; labels do too.
    assert.match(formatted, /^macro save reg$/m);
    assert.match(formatted, /^start:$/m);
    assert.match(formatted, /^ {12}push {4}reg$/m, 'expected the macro body to be indented');
  });

  it('offers a quick fix that adds the missing include for a symbol defined in another file', async function () {
    this.timeout(30000);
    // A second file in the same folder defines a macro this one calls but never includes.
    const libPath = path.join(dir, 'lib.inc');
    await fs.writeFile(libPath, ['macro emit_nop', 'nop', 'end macro'].join('\n'), 'utf8');
    const libDoc = await vscode.workspace.openTextDocument(libPath);
    await vscode.window.showTextDocument(libDoc);

    const callerPath = path.join(dir, 'caller.asm');
    await fs.writeFile(callerPath, ['format ELF64 executable 3', 'entry start', '', 'start:', 'emit_nop', ''].join('\n'), 'utf8');
    const callerDoc = await vscode.workspace.openTextDocument(callerPath);
    await vscode.window.showTextDocument(callerDoc);

    // Cursor on the "emit_nop" invocation, line 4.
    const range = new vscode.Range(new vscode.Position(4, 0), new vscode.Position(4, 8));
    const actions = await eventually(
      () => vscode.commands.executeCommand<vscode.CodeAction[]>('vscode.executeCodeActionProvider', callerDoc.uri, range),
      (a) => a.length > 0,
    );
    assert.ok(actions && actions.length > 0, 'expected a quick fix offering the missing include');
    assert.ok(
      actions!.some((a) => /include 'lib\.inc'/.test(a.title)),
      `expected an "add include" action, got ${JSON.stringify(actions?.map((a) => a.title))}`,
    );
  });

  it('offers a quick fix correcting a misspelled mnemonic', async function () {
    this.timeout(30000);
    const typoPath = path.join(dir, 'typo.asm');
    await fs.writeFile(typoPath, ['format ELF64 executable 3', 'entry start', '', 'start:', '\tsyscal', ''].join('\n'), 'utf8');
    const typoDoc = await vscode.workspace.openTextDocument(typoPath);
    await vscode.window.showTextDocument(typoDoc);

    const range = new vscode.Range(new vscode.Position(4, 1), new vscode.Position(4, 7));
    const actions = await eventually(
      () => vscode.commands.executeCommand<vscode.CodeAction[]>('vscode.executeCodeActionProvider', typoDoc.uri, range),
      (a) => a.length > 0,
    );
    assert.ok(
      actions?.some((a) => /Change 'syscal' to 'syscall'/.test(a.title)),
      `expected a spelling fix, got ${JSON.stringify(actions?.map((a) => a.title))}`,
    );
  });

  it('completes a filename inside an include directive', async function () {
    this.timeout(30000);
    await fs.writeFile(path.join(dir, 'completable.inc'), 'nop\n', 'utf8');
    const typingPath = path.join(dir, 'typing.asm');
    await fs.writeFile(typingPath, ['format binary', "include '", ''].join('\n'), 'utf8');
    const typingDoc = await vscode.workspace.openTextDocument(typingPath);
    await vscode.window.showTextDocument(typingDoc);

    // Just after the opening quote on line 1.
    const position = new vscode.Position(1, 9);
    const list = await eventually(
      () => vscode.commands.executeCommand<vscode.CompletionList>('vscode.executeCompletionItemProvider', typingDoc.uri, position),
      (l) => l.items.length > 0,
    );
    const labels = (list?.items ?? []).map((i) => (typeof i.label === 'string' ? i.label : i.label.label));
    assert.ok(labels.includes('completable.inc'), `expected the sibling include among ${JSON.stringify(labels.slice(0, 20))}`);
    // The identifier list has no business inside a quoted path.
    assert.ok(!labels.includes('mov'), 'mnemonics must not be offered inside a string literal');
  });

  it('grows the selection one construct at a time', async function () {
    this.timeout(20000);
    // Its own file rather than the shared one: the formatting test above applies its edits to that
    // document, which moves every column this test asserts on.
    const selectPath = path.join(dir, 'select.asm');
    await fs.writeFile(selectPath, ['format binary', '', 'macro save reg', '\tpush reg', '\tpop reg', 'end macro', ''].join('\n'), 'utf8');
    const selectDoc = await vscode.workspace.openTextDocument(selectPath);
    await vscode.window.showTextDocument(selectDoc);

    // On "reg" in "\tpush reg" (line 3), inside "macro save reg" (2) .. "end macro" (5).
    const ranges = await eventually(
      () =>
        vscode.commands.executeCommand<vscode.SelectionRange[]>('vscode.executeSelectionRangeProvider', selectDoc.uri, [
          new vscode.Position(3, 7),
        ]),
      (r) => r.length > 0 && !!r[0].parent,
    );
    assert.ok(ranges && ranges.length === 1, 'expected one chain for the one position given');

    const steps: vscode.Range[] = [];
    for (let node: vscode.SelectionRange | undefined = ranges![0]; node; node = node.parent) steps.push(node.range);
    assert.ok(steps.length >= 3, `expected several growth steps, got ${steps.length}`);
    // Each step must strictly contain the one before it, or Shift+Alt+Right shrinks the selection.
    for (let i = 1; i < steps.length; i++) {
      assert.ok(steps[i].contains(steps[i - 1]), `step ${i} does not contain step ${i - 1}`);
    }
    // One of them is the enclosing "macro ... end macro".
    assert.ok(
      steps.some((r) => r.start.line === 2 && r.end.line === 5),
      `no macro-block step in ${JSON.stringify(steps.map((r) => `${r.start.line}-${r.end.line}`))}`,
    );
  });

  it('builds a call hierarchy from a label to the routine that reaches it', async function () {
    this.timeout(30000);
    const callsPath = path.join(dir, 'calls.asm');
    await fs.writeFile(
      callsPath,
      ['format ELF64 executable 3', 'entry start', '', 'start:', '\tcall helper', '\tret', '', 'helper:', '\tret', ''].join('\n'),
      'utf8',
    );
    const callsDoc = await vscode.workspace.openTextDocument(callsPath);
    await vscode.window.showTextDocument(callsDoc);

    // On the "helper:" definition, line 7.
    const items = await eventually(
      () =>
        vscode.commands.executeCommand<vscode.CallHierarchyItem[]>('vscode.prepareCallHierarchy', callsDoc.uri, new vscode.Position(7, 2)),
      (i) => i.length > 0,
    );
    assert.ok(items && items.length > 0, 'expected the hierarchy to root at "helper"');
    assert.strictEqual(items![0].name, 'helper');

    const incoming = await vscode.commands.executeCommand<vscode.CallHierarchyIncomingCall[]>(
      'vscode.provideIncomingCalls',
      items![0],
    );
    assert.deepStrictEqual((incoming ?? []).map((c) => c.from.name), ['start']);
  });

  it('links the path in an include directive to the file it resolves to', async function () {
    this.timeout(30000);
    const targetPath = path.join(dir, 'linked.inc');
    await fs.writeFile(targetPath, 'nop\n', 'utf8');
    const withIncludePath = path.join(dir, 'withinclude.asm');
    await fs.writeFile(withIncludePath, ['format binary', "include 'linked.inc'", ''].join('\n'), 'utf8');
    const includeDoc = await vscode.workspace.openTextDocument(withIncludePath);
    await vscode.window.showTextDocument(includeDoc);

    const links = await eventually(
      () => vscode.commands.executeCommand<vscode.DocumentLink[]>('vscode.executeLinkProvider', includeDoc.uri),
      (l) => l.length > 0,
    );
    assert.ok(links && links.length > 0, 'expected a document link for the include path');
    const linked = links![0].target?.fsPath;
    assert.ok(linked && samePath(linked, targetPath), `expected the link to resolve to ${targetPath}, got ${linked}`);
  });
});
