// The Run/Debug/Build lenses, resolved through VS Code's own provider registry so this covers the
// registration as well as what the provider returns.
//
// The distinction being tested is the one the feature exists for: a lens appears on a file that is
// a program, and not on a fragment. A fragment still builds — the commands resolve it to whichever
// entry point includes it — but it has no single program to name, so a lens offering to "Run" it
// would describe something that cannot happen.
import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';

const FIXTURES = path.resolve(__dirname, '..', '..', '..', 'test', 'fixtures');

/** `format binary` on its first line, so it is an entry point in its own right. */
const ENTRY_POINT = path.join(FIXTURES, 'workspace-symbols', 'defs.asm');
/** No `format` and no top-level `org`, and nothing in the fixtures includes it. */
const FRAGMENT = path.join(FIXTURES, 'anonymous.alm');

async function lensesFor(fsPath: string): Promise<vscode.CodeLens[]> {
  const uri = vscode.Uri.file(fsPath);
  await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
  return (await vscode.commands.executeCommand<vscode.CodeLens[]>('vscode.executeCodeLensProvider', uri)) ?? [];
}

describe('code lenses', () => {
  before(async function () {
    this.timeout(30000);
    const extension = vscode.extensions.getExtension('Lu4nScr1pt1ng.fasm2-studio');
    assert.ok(extension, 'the extension is not installed in this test host');
    await extension.activate();
  });

  afterEach(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  it('offers Run, Debug and Build on a file that is a program', async function () {
    this.timeout(30000);
    const commands = (await lensesFor(ENTRY_POINT)).map((lens) => lens.command?.command);
    assert.deepStrictEqual(
      [...commands].sort(),
      ['fasm2Studio.build', 'fasm2Studio.buildAndRun', 'fasm2Studio.debug'],
    );
  });

  // The lens has to act on the file it is drawn in, not on whatever tab is focused when it is
  // clicked -- the two differ the moment a lens is clicked in a split editor.
  it('passes its own file to the command, rather than relying on the active editor', async function () {
    this.timeout(30000);
    for (const lens of await lensesFor(ENTRY_POINT)) {
      const [argument] = lens.command?.arguments ?? [];
      assert.ok(argument instanceof vscode.Uri, `${lens.command?.command} was given no uri`);
      assert.strictEqual(argument.fsPath, ENTRY_POINT);
    }
  });

  it('anchors them to the format directive, which is the line that makes it a program', async function () {
    this.timeout(30000);
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(ENTRY_POINT));
    for (const lens of await lensesFor(ENTRY_POINT)) {
      assert.match(document.lineAt(lens.range.start.line).text, /^\s*format\b/i);
    }
  });

  it('leaves a fragment alone, since it has no one program to offer', async function () {
    this.timeout(30000);
    assert.deepStrictEqual(await lensesFor(FRAGMENT), []);
  });

  it('is switched off by fasm2Studio.codeLens, since lenses are a matter of taste', async function () {
    this.timeout(30000);
    const config = vscode.workspace.getConfiguration('fasm2Studio');
    const original = config.get<boolean>('codeLens');
    try {
      await config.update('codeLens', false, vscode.ConfigurationTarget.Global);
      assert.deepStrictEqual(await lensesFor(ENTRY_POINT), []);
    } finally {
      await config.update('codeLens', original, vscode.ConfigurationTarget.Global);
    }
  });
});
