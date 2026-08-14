// Dropping a file into a fasm buffer, driven through the real provider with a real
// vscode.DataTransfer. The path arithmetic is covered by the unit tests; what is checked here is
// everything only a running VS Code supplies — the shape the Explorer actually puts on a drag
// (`text/uri-list`), the document and its scheme, and fasm2Studio.includePath read as a setting
// rather than as a passed-in array.
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { IncludeDropProvider } from '../../src/includeDrop';
import { makeTempDir, removeTempDir } from '../tempDir';

/** The Explorer puts one URI per line on a drag, CRLF-separated. */
function uriList(...fsPaths: string[]): vscode.DataTransfer {
  const transfer = new vscode.DataTransfer();
  transfer.set('text/uri-list', new vscode.DataTransferItem(fsPaths.map((p) => vscode.Uri.file(p).toString()).join('\r\n')));
  return transfer;
}

async function dropInto(document: vscode.TextDocument, transfer: vscode.DataTransfer): Promise<string | undefined> {
  const edit = await new IncludeDropProvider().provideDocumentDropEdits(
    document,
    new vscode.Position(0, 0),
    transfer,
    new vscode.CancellationTokenSource().token,
  );
  if (!edit) return undefined;
  return typeof edit.insertText === 'string' ? edit.insertText : edit.insertText.value;
}

describe('dropping a file into a fasm source file', () => {
  let dir: string;
  let mainPath: string;

  before(() => {
    dir = makeTempDir('fasm2-studio-include-drop-test-');
    mainPath = path.join(dir, 'main.asm');
    fs.writeFileSync(mainPath, 'format ELF64 executable 3\n', 'utf8');
    fs.mkdirSync(path.join(dir, 'lib'));
    fs.writeFileSync(path.join(dir, 'lib', 'macros.inc'), '; macros\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'logo.png'), '', 'utf8');
  });

  after(async () => {
    await removeTempDir(dir);
  });

  it('writes the include line for a file dragged in from the Explorer', async () => {
    const document = await vscode.workspace.openTextDocument(mainPath);
    const text = await dropInto(document, uriList(path.join(dir, 'lib', 'macros.inc')));
    assert.strictEqual(text, "include 'lib/macros.inc'");
  });

  it('writes one line per file when several are dragged together', async () => {
    const document = await vscode.workspace.openTextDocument(mainPath);
    const text = await dropInto(document, uriList(path.join(dir, 'lib', 'macros.inc'), mainPath));
    // main.asm is the file being edited, so it drops out rather than producing a self-include.
    assert.strictEqual(text, "include 'lib/macros.inc'");
  });

  // Left to VS Code, which inserts the path as plain text — the right answer for something no
  // `include` would name.
  it('declines a file that is not fasm source', async () => {
    const document = await vscode.workspace.openTextDocument(mainPath);
    assert.strictEqual(await dropInto(document, uriList(path.join(dir, 'logo.png'))), undefined);
  });

  it('declines a drop carrying no files at all', async () => {
    const document = await vscode.workspace.openTextDocument(mainPath);
    const transfer = new vscode.DataTransfer();
    transfer.set('text/plain', new vscode.DataTransferItem('just some text'));
    assert.strictEqual(await dropInto(document, transfer), undefined);
  });

  // An untitled buffer has no directory for a relative path to be spelled against — and is also
  // the one document Build/Run/Debug cannot act on.
  it('declines a drop into an unsaved buffer, which has no directory to be relative to', async () => {
    const document = await vscode.workspace.openTextDocument({ language: 'fasm', content: '' });
    assert.strictEqual(await dropInto(document, uriList(path.join(dir, 'lib', 'macros.inc'))), undefined);
  });

  it('spells a file outside the project through a configured include directory', async () => {
    const vendor = makeTempDir('fasm2-studio-include-drop-vendor-');
    const vendored = path.join(vendor, 'win64a.inc');
    fs.writeFileSync(vendored, '; vendored\n', 'utf8');

    const config = vscode.workspace.getConfiguration('fasm2Studio');
    const original = config.get<string>('includePath');
    try {
      await config.update('includePath', vendor, vscode.ConfigurationTarget.Global);
      const document = await vscode.workspace.openTextDocument(mainPath);
      assert.strictEqual(await dropInto(document, uriList(vendored)), "include 'win64a.inc'");
    } finally {
      await config.update('includePath', original, vscode.ConfigurationTarget.Global);
      await removeTempDir(vendor);
    }
  });
});
