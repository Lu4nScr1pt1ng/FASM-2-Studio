// "FASM: Select Dialect". Runs in the VS Code host because the command reaches the configuration
// API and the enum it writes with.
import * as assert from 'assert';
import * as vscode from 'vscode';
import { projectConfigurationTarget } from '../../src/config';
import { confirmationMessage, dialectChoices } from '../../src/selectDialect';

describe('select dialect', () => {
  before(async () => {
    // Commands only exist once the extension has activated, and its activation event is
    // onLanguage:fasm — nothing here opens a fasm file, so activate it directly.
    const ext = vscode.extensions.getExtension('Lu4nScr1pt1ng.fasm2-studio');
    assert.ok(ext, 'extension not found in the test host');
    await ext.activate();
  });

  it('is contributed as a command the palette can reach', async () => {
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes('fasm2Studio.selectDialect'));
  });

  it('offers both dialects', () => {
    assert.deepStrictEqual(dialectChoices('fasm2').map((c) => c.dialect), ['fasm2', 'fasm1']);
  });

  it('marks the one currently in effect, so the picker shows where you are before you change it', () => {
    const marked = (current: 'fasm1' | 'fasm2') =>
      dialectChoices(current).filter((c) => c.description === 'current').map((c) => c.dialect);

    assert.deepStrictEqual(marked('fasm2'), ['fasm2']);
    assert.deepStrictEqual(marked('fasm1'), ['fasm1']);
  });

  it('says why fasm1 needs choosing, since that is the case detection cannot cover', () => {
    const fasm1 = dialectChoices('fasm2').find((c) => c.dialect === 'fasm1');
    assert.match(fasm1!.detail, /not auto-detected/i);
  });

  it('writes into the project, which is what creates .vscode/settings.json', () => {
    assert.strictEqual(projectConfigurationTarget(true), vscode.ConfigurationTarget.Workspace);
  });

  it('confirms where the setting landed, since a global write means something different', () => {
    assert.match(confirmationMessage('fasm1', vscode.ConfigurationTarget.Workspace), /for this workspace/);
    assert.match(confirmationMessage('fasm1', vscode.ConfigurationTarget.Global), /globally/);
  });
});
