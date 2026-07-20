import * as assert from 'assert';
import { spawnSync } from 'child_process';
import * as path from 'path';
import * as vscode from 'vscode';

const FIXTURES = path.resolve(__dirname, '..', '..', '..', 'test', 'fixtures');

async function openFixture(name: string): Promise<vscode.TextDocument> {
  const doc = await vscode.workspace.openTextDocument(path.join(FIXTURES, name));
  await vscode.window.showTextDocument(doc);
  return doc;
}

function fasm2Available(): boolean {
  // "Not found" is reported differently per shell (bash: exit 127, cmd.exe: exit 1 with its own
  // "not recognized" text) — rather than guess at exit codes, look for fasm2's own stable banner
  // text, which only appears when the real binary actually ran.
  const result = spawnSync('fasm2', [], { shell: true, timeout: 3000, encoding: 'utf8' });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.toLowerCase();
  return output.includes('flat assembler');
}

describe('FASM2 Studio extension (real VS Code host)', () => {
  before(async () => {
    const ext = vscode.extensions.getExtension('fasm2-studio.fasm2-studio');
    assert.ok(ext, 'extension should be discoverable by id');
    await ext!.activate();
  });

  it('assigns the "fasm" language mode to .asm files', async () => {
    const doc = await openFixture('tetros.asm');
    assert.strictEqual(doc.languageId, 'fasm');
  });

  it('reports document symbols for known labels via the language server', async function () {
    this.timeout(15000);
    const doc = await openFixture('tetros.asm');

    let symbols: vscode.DocumentSymbol[] | undefined;
    for (let attempt = 0; attempt < 20 && (!symbols || symbols.length === 0); attempt++) {
      symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>('vscode.executeDocumentSymbolProvider', doc.uri);
      if (!symbols || symbols.length === 0) await new Promise((r) => setTimeout(r, 250));
    }

    assert.ok(symbols && symbols.length > 0, 'expected at least one document symbol');
    assert.ok(symbols!.some((s) => s.name === 'start'), 'expected a "start" label symbol');
  });

  it('offers hover documentation for a known mnemonic', async function () {
    this.timeout(15000);
    const doc = await openFixture('tetros.asm');
    const text = doc.getText();
    const idx = text.indexOf('xor\tax,ax');
    assert.ok(idx >= 0, 'fixture should contain a known "xor ax,ax" line');
    const pos = doc.positionAt(idx);

    let hovers: vscode.Hover[] | undefined;
    for (let attempt = 0; attempt < 20 && (!hovers || hovers.length === 0); attempt++) {
      hovers = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', doc.uri, pos);
      if (!hovers || hovers.length === 0) await new Promise((r) => setTimeout(r, 250));
    }

    assert.ok(hovers && hovers.length > 0, 'expected hover contents for "xor"');
  });

  it('suggests instruction mnemonics via completion', async function () {
    this.timeout(15000);
    const doc = await vscode.workspace.openTextDocument({ language: 'fasm', content: 'format binary\nmo' });
    await vscode.window.showTextDocument(doc);
    const pos = new vscode.Position(1, 2);

    const list = await vscode.commands.executeCommand<vscode.CompletionList>('vscode.executeCompletionItemProvider', doc.uri, pos);
    const labels = (list?.items ?? []).map((i) => (typeof i.label === 'string' ? i.label : i.label.label));
    assert.ok(labels.includes('mov'), `expected "mov" among completions, got: ${labels.slice(0, 20).join(', ')}`);
  });

  async function waitForDiagnostics(uri: vscode.Uri): Promise<vscode.Diagnostic[]> {
    let diagnostics: vscode.Diagnostic[] = [];
    for (let attempt = 0; attempt < 40 && diagnostics.length === 0; attempt++) {
      diagnostics = vscode.languages.getDiagnostics(uri);
      if (diagnostics.length === 0) await new Promise((r) => setTimeout(r, 250));
    }
    return diagnostics;
  }

  it('publishes real compiler diagnostics for an unsaved (untitled) buffer', async function () {
    if (!fasm2Available()) {
      this.skip();
      return;
    }
    this.timeout(20000);

    // Untitled buffers have no real filesystem path; this exercises the server's temp-file
    // snapshot fallback rather than a plain `include`-relative compile of a saved file.
    const doc = await vscode.workspace.openTextDocument({
      language: 'fasm',
      content: 'format binary\nmov eax, thisSymbolDoesNotExist\n',
    });
    await vscode.window.showTextDocument(doc);

    const diagnostics = await waitForDiagnostics(doc.uri);
    assert.ok(diagnostics.length > 0, 'expected a diagnostic for the undefined symbol');
    assert.match(diagnostics[0].message, /thisSymbolDoesNotExist/);
  });

  it('publishes real compiler diagnostics for a saved file on disk', async function () {
    if (!fasm2Available()) {
      this.skip();
      return;
    }
    this.timeout(20000);

    const fs = await import('fs/promises');
    const os = await import('os');
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fasm2-studio-lang-test-'));
    const file = path.join(tmpDir, 'bad.asm');
    await fs.writeFile(file, 'format binary\nmov eax, anotherUndefinedSymbol\n', 'utf8');

    try {
      const doc = await vscode.workspace.openTextDocument(file);
      await vscode.window.showTextDocument(doc);

      const diagnostics = await waitForDiagnostics(doc.uri);
      assert.ok(diagnostics.length > 0, 'expected a diagnostic for the undefined symbol');
      assert.match(diagnostics[0].message, /anotherUndefinedSymbol/);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
