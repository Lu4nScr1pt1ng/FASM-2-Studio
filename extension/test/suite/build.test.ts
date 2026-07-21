import * as assert from 'assert';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

function fasm2Available(): boolean {
  // "Not found" is reported differently per shell (bash: exit 127, cmd.exe: exit 1 with its own
  // "not recognized" text) — rather than guess at exit codes, look for fasm2's own stable banner
  // text, which only appears when the real binary actually ran.
  const result = spawnSync('fasm2', [], { shell: true, timeout: 3000, encoding: 'utf8' });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.toLowerCase();
  return output.includes('flat assembler');
}

const PROGRAM_SRC = ['format ELF64 executable 3', 'entry start', '', 'segment readable executable', 'start:', '\tmov edi, 0', '\tmov eax, 60', '\tsyscall', ''].join('\n');

describe('FASM: Build honors fasm2Studio.buildOutputPath', () => {
  it('redirects the compiled binary away from the source once configured, instead of the dead-by-default setting', async function () {
    if (!fasm2Available()) {
      this.skip();
      return;
    }
    this.timeout(20000);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fasm2-studio-build-output-test-'));
    const srcDir = path.join(dir, 'src');
    fs.mkdirSync(srcDir);
    const asmPath = path.join(srcDir, 'prog.asm');
    fs.writeFileSync(asmPath, PROGRAM_SRC, 'utf8');

    const config = vscode.workspace.getConfiguration('fasm2Studio');
    const original = config.get<string>('buildOutputPath');

    try {
      const doc = await vscode.workspace.openTextDocument(asmPath);
      await vscode.window.showTextDocument(doc);

      // Relative to the source file's own directory, as documented — not the workspace root.
      await config.update('buildOutputPath', '../out/prog', vscode.ConfigurationTarget.Global);
      await vscode.commands.executeCommand('fasm2Studio.build');

      const redirectedOutput = path.join(dir, 'out', 'prog');
      assert.ok(fs.existsSync(redirectedOutput), `expected the build output at ${redirectedOutput}, got top-level entries: ${fs.readdirSync(dir).join(', ')}`);
      assert.ok(!fs.existsSync(path.join(srcDir, 'prog')), 'expected no output left next to the source once buildOutputPath redirects it elsewhere');
    } finally {
      await config.update('buildOutputPath', original, vscode.ConfigurationTarget.Global);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
