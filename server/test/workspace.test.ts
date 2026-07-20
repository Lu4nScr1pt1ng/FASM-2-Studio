import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { URI } from 'vscode-uri';
import { Workspace } from '../src/workspace';

const dialectAlwaysFasm2 = () => 'fasm2' as const;

describe('Workspace indexing', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fasm2-studio-ws-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function writeFile(name: string, content: string): Promise<string> {
    const fsPath = path.join(tmpDir, name);
    await fs.writeFile(fsPath, content, 'utf8');
    return URI.file(fsPath).toString();
  }

  it('indexes workspace files and finds symbols not currently open in an editor', async () => {
    const uriA = await writeFile('a.asm', 'format binary\nlabelA:\n\tmov eax, sharedConst\n');
    const uriB = await writeFile('b.asm', 'sharedConst = 42\n');

    const ws = new Workspace();
    const { indexed, skipped } = await ws.indexWorkspace([uriA, uriB], dialectAlwaysFasm2);

    assert.strictEqual(indexed, 2);
    assert.strictEqual(skipped, 0);

    const symbols = ws.findWorkspaceSymbols('sharedConst');
    assert.strictEqual(symbols.length, 1);
    assert.strictEqual(symbols[0].uri, uriB);
  });

  it('finds references across indexed files without either being open', async () => {
    const uriDef = await writeFile('def.asm', 'MAX = 10\n');
    const uriUse1 = await writeFile('use1.asm', 'mov eax, MAX\n');
    const uriUse2 = await writeFile('use2.asm', 'mov ebx, MAX\nadd ebx, MAX\n');

    const ws = new Workspace();
    await ws.indexWorkspace([uriDef, uriUse1, uriUse2], dialectAlwaysFasm2);

    const refs = ws.findReferences('MAX', true);
    // 1 declaration + 1 reference in use1.asm + 2 references in use2.asm
    assert.strictEqual(refs.length, 4);
    assert.ok(refs.some((r) => r.uri === uriDef));
    assert.ok(refs.some((r) => r.uri === uriUse1));
    assert.strictEqual(refs.filter((r) => r.uri === uriUse2).length, 2);
  });

  it('lets an open (possibly unsaved) buffer override the on-disk indexed version', async () => {
    const uri = await writeFile('live.asm', 'OLD_NAME = 1\n');
    const ws = new Workspace();
    await ws.indexWorkspace([uri], dialectAlwaysFasm2);

    assert.strictEqual(ws.findWorkspaceSymbols('OLD_NAME').length, 1);
    assert.strictEqual(ws.findWorkspaceSymbols('NEW_NAME').length, 0);

    // Simulate the user editing the (still unsaved) buffer without touching disk.
    ws.updateDocument(uri, 2, 'NEW_NAME = 1\n', 'fasm2');

    assert.strictEqual(ws.findWorkspaceSymbols('OLD_NAME').length, 0);
    assert.strictEqual(ws.findWorkspaceSymbols('NEW_NAME').length, 1);
  });

  it('reindexFile picks up on-disk changes for files that are not open', async () => {
    const uri = await writeFile('changing.asm', 'A = 1\n');
    const ws = new Workspace();
    await ws.indexWorkspace([uri], dialectAlwaysFasm2);
    assert.strictEqual(ws.findWorkspaceSymbols('A').length, 1);

    await fs.writeFile(URI.parse(uri).fsPath, 'B = 2\n', 'utf8');
    await ws.reindexFile(uri, dialectAlwaysFasm2);

    assert.strictEqual(ws.findWorkspaceSymbols('A').length, 0);
    assert.strictEqual(ws.findWorkspaceSymbols('B').length, 1);
  });

  it('removeIndexedFile drops a deleted file from search results', async () => {
    const uri = await writeFile('gone.asm', 'GONE_SYMBOL = 1\n');
    const ws = new Workspace();
    await ws.indexWorkspace([uri], dialectAlwaysFasm2);
    assert.strictEqual(ws.findWorkspaceSymbols('GONE_SYMBOL').length, 1);

    ws.removeIndexedFile(uri);
    assert.strictEqual(ws.findWorkspaceSymbols('GONE_SYMBOL').length, 0);
  });

  it('skips files above the size guard instead of throwing', async () => {
    const bigContent = 'db 1\n'.repeat(1_000_000); // well over the 2MB per-file cap
    const uri = await writeFile('huge.asm', bigContent);
    const ws = new Workspace();
    const { indexed, skipped } = await ws.indexWorkspace([uri], dialectAlwaysFasm2);
    assert.strictEqual(indexed, 0);
    assert.strictEqual(skipped, 1);
  });

  it('never throws when given a mix of missing, unreadable and valid files', async () => {
    const uriValid = await writeFile('ok.asm', 'OK = 1\n');
    const uriMissing = URI.file(path.join(tmpDir, 'does-not-exist.asm')).toString();

    const ws = new Workspace();
    const { indexed, skipped } = await ws.indexWorkspace([uriValid, uriMissing], dialectAlwaysFasm2);
    assert.strictEqual(indexed, 1);
    assert.strictEqual(skipped, 1);
  });
});
