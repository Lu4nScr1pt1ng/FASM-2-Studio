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

const ENTRY_SRC = (fragmentName: string) =>
  ['format ELF64 executable 3', 'entry start', '', `include '${fragmentName}'`, '', 'segment readable executable', 'start:', '\tmov edi, 0', '\tmov eax, 60', '\tsyscall', ''].join('\n');

/** Every document opened during these tests must be explicitly closed afterward — the language
 * server only forgets an open document when its editor tab actually closes (`onDidClose`), not
 * when the underlying file is deleted from disk. Leaving tabs open would leak these throwaway
 * entry points into every other test in the same run (they all share one server/extension host). */
async function closeAllEditors(): Promise<void> {
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
}

describe('Build/Run/Debug resolve the real entry point for a fragment file', () => {
  let originalShowQuickPick: typeof vscode.window.showQuickPick;

  beforeEach(() => {
    originalShowQuickPick = vscode.window.showQuickPick;
  });

  afterEach(async () => {
    vscode.window.showQuickPick = originalShowQuickPick;
    await closeAllEditors();
  });

  it('auto-resolves and builds the unique entry point that includes this fragment, not the fragment itself', async function () {
    if (!fasm2Available()) {
      this.skip();
      return;
    }
    this.timeout(20000);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fasm2-studio-entrypoint-test-'));
    const entryPath = path.join(dir, 'cc.asm');
    const fragmentPath = path.join(dir, 'lexer.asm');
    fs.writeFileSync(entryPath, ENTRY_SRC('lexer.asm'), 'utf8');
    fs.writeFileSync(fragmentPath, 'lex_source:\n\tnop\n', 'utf8');

    try {
      // Both need to be known to the language server; since this temp dir isn't part of the open
      // workspace folder, that only happens by actually opening them (not by on-disk indexing).
      await vscode.workspace.openTextDocument(entryPath);
      const fragmentDoc = await vscode.workspace.openTextDocument(fragmentPath);
      await vscode.window.showTextDocument(fragmentDoc);

      await vscode.commands.executeCommand('fasm2Studio.build');

      assert.ok(fs.existsSync(path.join(dir, 'cc')), 'expected the entry point\'s own output ("cc"), built via the fragment\'s resolved entry point');
      assert.ok(!fs.existsSync(path.join(dir, 'lexer')), 'must not have tried to compile the fragment standalone');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('shows a clear error instead of attempting to compile an orphaned fragment with no known entry point', async function () {
    if (!fasm2Available()) {
      this.skip();
      return;
    }
    this.timeout(20000);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fasm2-studio-entrypoint-orphan-test-'));
    const orphanPath = path.join(dir, 'orphan.inc');
    fs.writeFileSync(orphanPath, 'HELPER = 1\n', 'utf8');

    // Defensive: if some other test in this run left an entry point's tab open (it shouldn't,
    // but this test must not hang on a real interactive picker either way), simulate cancelling.
    vscode.window.showQuickPick = (async () => undefined) as typeof vscode.window.showQuickPick;

    try {
      const doc = await vscode.workspace.openTextDocument(orphanPath);
      await vscode.window.showTextDocument(doc);

      await vscode.commands.executeCommand('fasm2Studio.build');

      assert.ok(!fs.existsSync(path.join(dir, 'orphan')), 'must not have tried to compile the orphaned fragment standalone');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('prompts to pick a project when the fragment is reachable from more than one unrelated entry point', async function () {
    if (!fasm2Available()) {
      this.skip();
      return;
    }
    this.timeout(20000);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fasm2-studio-entrypoint-ambiguous-test-'));
    const sharedPath = path.join(dir, 'shared.inc');
    const entryAPath = path.join(dir, 'projectA.asm');
    const entryBPath = path.join(dir, 'projectB.asm');
    fs.writeFileSync(sharedPath, 'SHARED_CONST = 1\n', 'utf8');
    fs.writeFileSync(entryAPath, ENTRY_SRC('shared.inc'), 'utf8');
    fs.writeFileSync(entryBPath, ENTRY_SRC('shared.inc'), 'utf8');

    try {
      await vscode.workspace.openTextDocument(entryAPath);
      await vscode.workspace.openTextDocument(entryBPath);
      const sharedDoc = await vscode.workspace.openTextDocument(sharedPath);
      await vscode.window.showTextDocument(sharedDoc);

      let offeredLabels: string[] = [];
      vscode.window.showQuickPick = (async (items: Array<{ label: string }> | Thenable<Array<{ label: string }>>) => {
        const resolvedItems = await items;
        offeredLabels = resolvedItems.map((i) => i.label);
        return resolvedItems.find((i) => i.label === 'projectB.asm');
      }) as unknown as typeof vscode.window.showQuickPick;

      await vscode.commands.executeCommand('fasm2Studio.build');

      assert.deepStrictEqual(offeredLabels.sort(), ['projectA.asm', 'projectB.asm'], 'expected to be offered both unrelated projects that include this fragment');
      assert.ok(fs.existsSync(path.join(dir, 'projectB')), 'expected the picked project (projectB) to have been built');
      assert.ok(!fs.existsSync(path.join(dir, 'projectA')), 'the unpicked project must not have been built');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
