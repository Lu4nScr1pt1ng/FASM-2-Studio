// The setting proved through the command that uses it, rather than through the argument list it
// produces: what matters is that a project which cannot assemble without a flag assembles once the
// flag is configured, and that is only true if the setting reaches the real spawned assembler.
import * as assert from 'assert';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { getDefaultOutputPath } from '../../src/buildPaths';
import { makeTempDir, removeTempDir } from '../tempDir';

function fasm2Available(): boolean {
  const result = spawnSync('fasm2', [], { shell: true, timeout: 3000, encoding: 'utf8' });
  return `${result.stdout ?? ''}${result.stderr ?? ''}`.toLowerCase().includes('flat assembler');
}

/** A project that states a build-time requirement of its own, which is what `err` inside an `if`
 * is for. fasmg has no `-d`, so the only way to satisfy it is `-i` with a `define` line. */
const GATED_SRC = ['format binary', 'if ~ defined BUILD_MODE', "\terr 'BUILD_MODE is not defined'", 'end if', '\tmov eax, 1', ''].join('\n');

describe('FASM: Build honors fasm2Studio.compilerArgs', () => {
  it('assembles a project that requires a flag, which no setting could supply before', async function () {
    if (!fasm2Available()) {
      this.skip();
      return;
    }
    this.timeout(20000);

    const dir = makeTempDir('fasm2-studio-compilerargs-test-');
    const asmPath = path.join(dir, 'gated.asm');
    fs.writeFileSync(asmPath, GATED_SRC, 'utf8');
    const outputPath = getDefaultOutputPath(asmPath);

    const config = vscode.workspace.getConfiguration('fasm2Studio');
    const original = config.get<string[]>('compilerArgs');

    try {
      const doc = await vscode.workspace.openTextDocument(asmPath);
      await vscode.window.showTextDocument(doc);

      await config.update('compilerArgs', [], vscode.ConfigurationTarget.Global);
      await vscode.commands.executeCommand('fasm2Studio.build');
      assert.ok(!fs.existsSync(outputPath), 'expected the build to fail while the flag the project requires is unset');

      await config.update('compilerArgs', ['-i', 'define BUILD_MODE 1'], vscode.ConfigurationTarget.Global);
      await vscode.commands.executeCommand('fasm2Studio.build');
      assert.ok(fs.existsSync(outputPath), `expected the build to succeed once compilerArgs supplies it, got entries: ${fs.readdirSync(dir).join(', ')}`);
    } finally {
      await config.update('compilerArgs', original, vscode.ConfigurationTarget.Global);
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await removeTempDir(dir);
    }
  });
});
