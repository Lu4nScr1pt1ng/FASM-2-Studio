// Renaming through the editor's own file-operation API, which is the only way to exercise this:
// onWillRenameFiles fires for user gestures and for workspace.applyEdit's renameFile, and
// deliberately *not* for workspace.fs.rename — so a test that moved the file itself would prove
// nothing about the feature.
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

/** The server only knows a file outside the open workspace folder once it has been opened as a
 * document — the same reason the entry-point tests open theirs. */
async function open(fsPath: string): Promise<vscode.TextDocument> {
  return vscode.workspace.openTextDocument(fsPath);
}

async function renameThroughEditor(from: string, to: string): Promise<void> {
  const edit = new vscode.WorkspaceEdit();
  edit.renameFile(vscode.Uri.file(from), vscode.Uri.file(to));
  assert.ok(await vscode.workspace.applyEdit(edit), `renaming ${path.basename(from)} failed`);
}

describe('renaming a file keeps `include` paths pointing at it', () => {
  let dir: string;
  let originalMode: string | undefined;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fasm2-studio-include-rename-'));
    const config = vscode.workspace.getConfiguration('fasm2Studio');
    originalMode = config.get<string>('updateIncludesOnFileMove');
    // The prompt is the shipped default, and its wording is asserted separately below; driving it
    // from here would mean stubbing a modal, which tests the stub rather than the feature.
    await config.update('updateIncludesOnFileMove', 'always', vscode.ConfigurationTarget.Global);
  });

  afterEach(async () => {
    await vscode.workspace
      .getConfiguration('fasm2Studio')
      .update('updateIncludesOnFileMove', originalMode, vscode.ConfigurationTarget.Global);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('rewrites the include in every file that named the renamed one', async function () {
    this.timeout(20000);

    const mainPath = path.join(dir, 'main.asm');
    const fragmentPath = path.join(dir, 'util.inc');
    fs.writeFileSync(mainPath, "format ELF64\ninclude 'util.inc'\n", 'utf8');
    fs.writeFileSync(fragmentPath, 'PAGE = 4096\n', 'utf8');

    const main = await open(mainPath);
    await vscode.window.showTextDocument(main);
    await open(fragmentPath);

    await renameThroughEditor(fragmentPath, path.join(dir, 'helpers.inc'));

    assert.strictEqual(main.getText(), "format ELF64\ninclude 'helpers.inc'\n");
  });

  it('rewrites the moved file’s own includes, which now resolve from a different directory', async function () {
    this.timeout(20000);

    const mainPath = path.join(dir, 'main.asm');
    fs.writeFileSync(mainPath, "format ELF64\ninclude 'macros.inc'\n", 'utf8');
    fs.writeFileSync(path.join(dir, 'macros.inc'), 'PAGE = 4096\n', 'utf8');
    fs.mkdirSync(path.join(dir, 'src'));

    const main = await open(mainPath);
    await vscode.window.showTextDocument(main);
    await open(path.join(dir, 'macros.inc'));

    await renameThroughEditor(mainPath, path.join(dir, 'src', 'main.asm'));

    // The edit is applied before the rename, so the corrected text is what got moved: the document
    // that carried it is now the one at the new path.
    const moved = await open(path.join(dir, 'src', 'main.asm'));
    assert.strictEqual(moved.getText(), "format ELF64\ninclude '../macros.inc'\n");
  });

  it('leaves everything alone when the setting is "never"', async function () {
    this.timeout(20000);

    await vscode.workspace
      .getConfiguration('fasm2Studio')
      .update('updateIncludesOnFileMove', 'never', vscode.ConfigurationTarget.Global);

    const mainPath = path.join(dir, 'main.asm');
    const fragmentPath = path.join(dir, 'util.inc');
    fs.writeFileSync(mainPath, "format ELF64\ninclude 'util.inc'\n", 'utf8');
    fs.writeFileSync(fragmentPath, 'PAGE = 4096\n', 'utf8');

    const main = await open(mainPath);
    await vscode.window.showTextDocument(main);
    await open(fragmentPath);

    await renameThroughEditor(fragmentPath, path.join(dir, 'helpers.inc'));

    assert.strictEqual(main.getText(), "format ELF64\ninclude 'util.inc'\n");
  });

  it('does not disturb a rename that no include is affected by', async function () {
    this.timeout(20000);

    const mainPath = path.join(dir, 'main.asm');
    const strayPath = path.join(dir, 'notes.txt');
    fs.writeFileSync(mainPath, "format ELF64\ninclude 'util.inc'\n", 'utf8');
    fs.writeFileSync(path.join(dir, 'util.inc'), 'PAGE = 4096\n', 'utf8');
    fs.writeFileSync(strayPath, 'nothing to do with any of this\n', 'utf8');

    const main = await open(mainPath);
    await vscode.window.showTextDocument(main);
    await open(path.join(dir, 'util.inc'));

    await renameThroughEditor(strayPath, path.join(dir, 'README.txt'));

    assert.strictEqual(main.getText(), "format ELF64\ninclude 'util.inc'\n");
    assert.ok(fs.existsSync(path.join(dir, 'README.txt')));
  });
});
