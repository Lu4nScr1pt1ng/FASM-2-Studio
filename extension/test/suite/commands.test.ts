// Every command the manifest advertises has to exist once the extension is running. The two halves
// live in different files — package.json declares them, extension.ts registers them — and nothing
// connects the two at build time, so a command contributed but never registered reaches the user as
// "command 'fasm2Studio.x' not found" from the palette entry the manifest put there.
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

interface Manifest {
  contributes: { commands: Array<{ command: string }> };
}

describe('contributed commands', () => {
  it('are all registered by the running extension', async () => {
    const manifestPath = path.resolve(__dirname, '..', '..', '..', 'package.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Manifest;

    const extension = vscode.extensions.getExtension('Lu4nScr1pt1ng.fasm2-studio');
    assert.ok(extension, 'the extension is not installed in this test host');
    await extension.activate();

    const registered = new Set(await vscode.commands.getCommands(true));
    for (const { command } of manifest.contributes.commands) {
      assert.ok(registered.has(command), `${command} is contributed in package.json but never registered`);
    }
  });
});
