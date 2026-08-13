// The tasks this extension contributes, as VS Code itself resolves them — fetchTasks goes through
// the real TaskProvider registration, so this covers the provider being registered for the right
// type as well as what it produces.
import * as assert from 'assert';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { makeTempDir, removeTempDir } from '../tempDir';

function fasm2Available(): boolean {
  const result = spawnSync('fasm2', [], { shell: true, timeout: 3000, encoding: 'utf8' });
  return `${result.stdout ?? ''}${result.stderr ?? ''}`.toLowerCase().includes('flat assembler');
}

const PROGRAM_SRC = ['format ELF64 executable 3', 'entry start', '', 'segment readable executable', 'start:', '\tmov edi, 0', '\tmov eax, 60', '\tsyscall', ''].join('\n');

describe('contributed fasm tasks', () => {
  it('are in the Build group, so Ctrl+Shift+B reaches them without a tasks.json', async function () {
    if (!fasm2Available()) {
      this.skip();
      return;
    }
    this.timeout(20000);

    const dir = makeTempDir('fasm2-studio-task-group-test-');
    const asmPath = path.join(dir, 'prog.asm');
    fs.writeFileSync(asmPath, PROGRAM_SRC, 'utf8');

    try {
      // The provider describes the *active* file, so the editor has to be showing one first.
      const doc = await vscode.workspace.openTextDocument(asmPath);
      await vscode.window.showTextDocument(doc);

      const tasks = await vscode.tasks.fetchTasks({ type: 'fasm' });
      assert.ok(tasks.length > 0, 'no fasm tasks were provided for an open .asm file');
      for (const task of tasks) {
        assert.strictEqual(task.group, vscode.TaskGroup.Build, `task "${task.name}" is not in the Build group`);
      }
    } finally {
      await removeTempDir(dir);
    }
  });
});
