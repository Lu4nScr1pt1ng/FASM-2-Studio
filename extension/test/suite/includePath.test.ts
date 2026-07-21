import * as assert from 'assert';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

function fasm2Available(): boolean {
  const result = spawnSync('fasm2', [], { shell: true, timeout: 3000, encoding: 'utf8' });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.toLowerCase();
  return output.includes('flat assembler');
}

describe('FASM: Build honors fasm2Studio.includePath', () => {
  it('resolves a bare `include` outside the source directory once includePath is configured, instead of failing to find it', async function () {
    // Mirrors a real, confirmed scenario in fasmg's own example tree: packages/x86/examples/windows
    // uses `include 'win32w.inc'` (a sibling packages/x86/include/ directory, not next to the
    // .asm), relying on its bundled make.bat's `set include=..\..\include` to resolve it — without
    // an equivalent setting here, real fasmg projects structured this way fail to build at all.
    if (!fasm2Available()) {
      this.skip();
      return;
    }
    this.timeout(20000);

    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fasm2-studio-includepath-project-'));
    const packageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fasm2-studio-includepath-package-'));
    const asmPath = path.join(projectDir, 'main.asm');
    fs.writeFileSync(asmPath, "format binary\ninclude 'shared.inc'\nstart:\n\tmov eax, 1\n", 'utf8');
    fs.writeFileSync(path.join(packageDir, 'shared.inc'), 'SHARED_CONST = 1\n', 'utf8');

    const config = vscode.workspace.getConfiguration('fasm2Studio');
    const originalIncludePath = config.get<string>('includePath');
    const originalOutputPath = config.get<string>('buildOutputPath');

    try {
      const doc = await vscode.workspace.openTextDocument(asmPath);
      await vscode.window.showTextDocument(doc);
      await config.update('buildOutputPath', 'main', vscode.ConfigurationTarget.Global);

      await config.update('includePath', '', vscode.ConfigurationTarget.Global);
      await vscode.commands.executeCommand('fasm2Studio.build');
      assert.ok(!fs.existsSync(path.join(projectDir, 'main')), 'expected the build to fail without includePath set (bare include cannot resolve outside the source directory)');

      await config.update('includePath', packageDir, vscode.ConfigurationTarget.Global);
      await vscode.commands.executeCommand('fasm2Studio.build');
      assert.ok(fs.existsSync(path.join(projectDir, 'main')), 'expected the build to succeed once includePath points at the directory containing shared.inc');
    } finally {
      await config.update('includePath', originalIncludePath, vscode.ConfigurationTarget.Global);
      await config.update('buildOutputPath', originalOutputPath, vscode.ConfigurationTarget.Global);
      fs.rmSync(projectDir, { recursive: true, force: true });
      fs.rmSync(packageDir, { recursive: true, force: true });
    }
  });
});
