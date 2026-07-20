import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';

const FIXTURES = path.resolve(__dirname, '..', '..', '..', 'test', 'fixtures', 'workspace-symbols');
const DEFS_URI = vscode.Uri.file(path.join(FIXTURES, 'defs.asm'));
const USES_URI = vscode.Uri.file(path.join(FIXTURES, 'uses.asm'));

async function retry<T>(fn: () => Promise<T>, isReady: (v: T) => boolean, attempts = 30, delayMs = 250): Promise<T> {
  let value = await fn();
  for (let i = 0; i < attempts && !isReady(value); i++) {
    await new Promise((r) => setTimeout(r, delayMs));
    value = await fn();
  }
  return value;
}

describe('FASM2 Studio workspace-wide features (real VS Code host)', () => {
  before(async () => {
    const ext = vscode.extensions.getExtension('Lu4nScr1pt1ng.fasm2-studio');
    await ext!.activate();
    // Give the one-shot workspace index (triggered on activation) time to finish before any
    // test relies on it having indexed defs.asm/uses.asm, neither of which we open here.
    await new Promise((r) => setTimeout(r, 2000));
  });

  it('finds a symbol defined in a file that was never opened, via workspace symbol search', async () => {
    const results = await retry(
      () => Promise.resolve(vscode.commands.executeCommand<vscode.SymbolInformation[]>('vscode.executeWorkspaceSymbolProvider', 'MAX_SIZE')),
      (r) => !!r && r.length > 0,
    );
    assert.ok(results && results.length > 0, 'expected MAX_SIZE to be found via workspace symbol search');
    assert.ok(results.some((s) => s.location.uri.fsPath === DEFS_URI.fsPath));
  });

  it('finds references across files, including the un-opened declaration site', async () => {
    const doc = await vscode.workspace.openTextDocument(USES_URI);
    await vscode.window.showTextDocument(doc);
    const text = doc.getText();
    const pos = doc.positionAt(text.indexOf('MAX_SIZE'));

    const locations = await retry(
      () => Promise.resolve(vscode.commands.executeCommand<vscode.Location[]>('vscode.executeReferenceProvider', doc.uri, pos)),
      (r) => !!r && r.length >= 3,
    );

    assert.ok(locations, 'expected reference locations');
    // 1 declaration (defs.asm) + 2 uses (uses.asm)
    assert.strictEqual(locations!.length, 3);
    assert.ok(locations!.some((l) => l.uri.fsPath === DEFS_URI.fsPath), 'expected a reference in the un-opened defs.asm');
  });

  it('renames a symbol across files without requiring the declaration file to be open', async () => {
    const doc = await vscode.workspace.openTextDocument(USES_URI);
    await vscode.window.showTextDocument(doc);
    const text = doc.getText();
    const pos = doc.positionAt(text.indexOf('MAX_SIZE'));

    const edit = await retry(
      () => Promise.resolve(vscode.commands.executeCommand<vscode.WorkspaceEdit>('vscode.executeDocumentRenameProvider', doc.uri, pos, 'MAX_LIMIT')),
      (r) => !!r && r.entries().length > 0,
    );

    assert.ok(edit, 'expected a workspace edit for the rename');
    const entries = edit!.entries();
    const touchedFiles = entries.map(([uri]) => uri.fsPath);
    assert.ok(touchedFiles.includes(DEFS_URI.fsPath), 'rename should touch the un-opened declaration file');
    assert.ok(touchedFiles.includes(USES_URI.fsPath), 'rename should touch the file containing the uses');
    const totalEdits = entries.reduce((sum, [, edits]) => sum + edits.length, 0);
    assert.strictEqual(totalEdits, 3);
    // Deliberately not applying the edit: these are static fixture files reused by every test run.
  });

  it('shows macro signature help with the correct active parameter', async () => {
    const doc = await vscode.workspace.openTextDocument(USES_URI);
    await vscode.window.showTextDocument(doc);
    const text = doc.getText();
    const callLine = text.indexOf('scale 2, eax');
    const pos = doc.positionAt(callLine + 'scale 2, '.length);

    const help = await retry(
      () => Promise.resolve(vscode.commands.executeCommand<vscode.SignatureHelp>('vscode.executeSignatureHelpProvider', doc.uri, pos)),
      (r) => !!r && r.signatures.length > 0,
    );

    assert.ok(help, 'expected signature help for the "scale" macro');
    assert.strictEqual(help!.signatures[0].parameters?.length, 2);
    assert.strictEqual(help!.activeParameter, 1);
  });
});
