// The whole point of "Check All Entry Points" is the file nobody has open, so that is exactly what
// this asserts: a program in the workspace that no editor has ever shown must come back carrying
// the compiler's own errors. Live diagnostics cannot produce that result by construction — they are
// driven entirely by the open-editor set — so an assertion on an unopened file is the one that
// distinguishes this command working from it doing nothing.
import * as assert from 'assert';
import { spawnSync } from 'child_process';
import * as path from 'path';
import * as vscode from 'vscode';

function fasm2Available(): boolean {
  const result = spawnSync('fasm2', [], { shell: true, timeout: 3000, encoding: 'utf8' });
  return `${result.stdout ?? ''}${result.stderr ?? ''}`.toLowerCase().includes('flat assembler');
}

/** The fixture workspace's uses.asm, which reads MAX_SIZE and `scale` from its sibling defs.asm
 * without including it — so assembling it on its own genuinely fails, which is what makes it a
 * usable subject here. */
function usesAsmUri(): vscode.Uri {
  const folder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(folder, 'the tests must run with the fixture folder open');
  return vscode.Uri.file(path.join(folder.uri.fsPath, 'workspace-symbols', 'uses.asm'));
}

async function waitForDiagnostics(uri: vscode.Uri, timeoutMs: number): Promise<vscode.Diagnostic[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const diagnostics = vscode.languages.getDiagnostics(uri);
    if (diagnostics.length > 0 || Date.now() > deadline) return diagnostics;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe('FASM: Check All Entry Points', () => {
  it('reports errors in a program no editor has open, which live diagnostics never look at', async function () {
    if (!fasm2Available()) {
      this.skip();
      return;
    }
    this.timeout(60000);

    const uri = usesAsmUri();
    // Nothing in this suite opens it, and the assertion below is only meaningful if that holds:
    // an open document would be checked live and skipped by the command entirely.
    assert.ok(
      !vscode.workspace.textDocuments.some((doc) => doc.uri.fsPath === uri.fsPath),
      'uses.asm must not be open for this test to mean anything',
    );

    await vscode.commands.executeCommand('fasm2Studio.checkAll');

    const diagnostics = await waitForDiagnostics(uri, 20000);
    assert.ok(diagnostics.length > 0, 'expected the unopened entry point to carry the compiler\'s errors');
    // fasm2 rejects line 4 (`mov eax, MAX_SIZE`) because MAX_SIZE lives in a file uses.asm never
    // includes — a real error, located precisely, in a file that was never opened.
    assert.strictEqual(diagnostics[0].range.start.line, 3);
    assert.match(diagnostics[0].message, /MAX_SIZE/);
  });
});
