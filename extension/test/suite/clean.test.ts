// "FASM: Clean" removes exactly what a build could have left behind: the output binary and,
// separately, the listing a debug build writes beside it. Neither file is actually built here —
// both are written directly at the paths buildArtifacts() itself would compute, which is enough to
// exercise the real question this test is about (does "Clean" find the *real* names those two
// helpers now produce) without needing fasm2 installed at all.
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { getDefaultOutputPath, getListingPath } from '../../src/buildPaths';
import { makeTempDir, removeTempDir } from '../tempDir';

describe('FASM: Clean', () => {
  it('removes both the build output and its listing, wherever getDefaultOutputPath/getListingPath actually put them', async function () {
    this.timeout(20000);

    const dir = makeTempDir('fasm2-studio-clean-test-');
    const asmPath = path.join(dir, 'prog.asm');
    fs.writeFileSync(asmPath, 'format binary\nmov eax, 1\n', 'utf8');

    // Regression coverage for the exact pair this session's Windows fixes changed: the output
    // path picked up a ".exe" it never had before, and the listing path has to track wherever that
    // output actually is (see getListingPath's own doc comment on why "append .lst" stopped being
    // right the moment the output stopped being extension-less).
    const outputPath = getDefaultOutputPath(asmPath);
    const listingPath = getListingPath(outputPath);
    fs.writeFileSync(outputPath, 'not a real binary, just needs to exist', 'utf8');
    fs.writeFileSync(listingPath, 'not a real listing, just needs to exist', 'utf8');

    try {
      const doc = await vscode.workspace.openTextDocument(asmPath);
      await vscode.window.showTextDocument(doc);

      await vscode.commands.executeCommand('fasm2Studio.clean');

      assert.ok(!fs.existsSync(outputPath), `expected the build output to be removed: ${outputPath}`);
      assert.ok(!fs.existsSync(listingPath), `expected the listing to be removed: ${listingPath}`);
    } finally {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await removeTempDir(dir);
    }
  });

  it('reports nothing to clean when neither file exists, rather than a silent no-op', async function () {
    this.timeout(20000);

    const dir = makeTempDir('fasm2-studio-clean-empty-test-');
    const asmPath = path.join(dir, 'prog.asm');
    fs.writeFileSync(asmPath, 'format binary\nmov eax, 1\n', 'utf8');

    const originalShowInformation = vscode.window.showInformationMessage;
    let message: string | undefined;
    (vscode.window as unknown as Record<string, unknown>).showInformationMessage = (msg: string) => {
      message = msg;
      return Promise.resolve(undefined);
    };

    try {
      const doc = await vscode.workspace.openTextDocument(asmPath);
      await vscode.window.showTextDocument(doc);

      await vscode.commands.executeCommand('fasm2Studio.clean');

      assert.ok(message?.includes('nothing to clean'), `expected a "nothing to clean" message, got: ${message}`);
    } finally {
      Object.assign(vscode.window, { showInformationMessage: originalShowInformation });
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await removeTempDir(dir);
    }
  });
});
