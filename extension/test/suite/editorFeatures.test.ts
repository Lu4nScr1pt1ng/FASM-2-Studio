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
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    if (dir) await fs.rm(dir, { recursive: true, force: true });
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
    assert.strictEqual(links![0].target?.fsPath, targetPath);
  });
});
