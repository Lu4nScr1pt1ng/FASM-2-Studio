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

  it('walkIncludeGraph terminates on a circular include instead of recursing forever', async () => {
    const uriA = await writeFile('circ-a.inc', "SHARED = 1\ninclude 'circ-b.inc'\n");
    await writeFile('circ-b.inc', "include 'circ-a.inc'\nOTHER = 2\n");
    const uriMain = await writeFile('circ-main.asm', "include 'circ-a.inc'\nstart:\n\tmov eax, SHARED\n");

    const ws = new Workspace();
    ws.updateDocument(uriMain, 1, "include 'circ-a.inc'\nstart:\n\tmov eax, SHARED\n", 'fasm2');

    const defs = await Promise.race([
      Promise.resolve(ws.findDefinitions(uriMain, 'SHARED', 'fasm2')),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('findDefinitions did not return — likely an infinite loop on the circular include')), 2000)),
    ]);

    assert.strictEqual(defs.length, 1);
    assert.strictEqual(defs[0].uri, uriA);

    // OTHER is only reachable through the cycle (main -> a -> b), proving the graph is actually
    // walked into b.inc rather than the cycle just being detected and abandoned early.
    const other = ws.findDefinitions(uriMain, 'OTHER', 'fasm2');
    assert.strictEqual(other.length, 1);
  });

  it('reverts to the indexed-from-disk version in the global index when the live buffer closes', async () => {
    const uri = await writeFile('reverts.asm', 'DISK_NAME = 1\n');
    const ws = new Workspace();
    await ws.indexWorkspace([uri], dialectAlwaysFasm2);

    ws.updateDocument(uri, 2, 'EDITOR_ONLY_NAME = 1\n', 'fasm2');
    assert.strictEqual(ws.findWorkspaceSymbols('EDITOR_ONLY_NAME').length, 1);
    assert.strictEqual(ws.findWorkspaceSymbols('DISK_NAME').length, 0);

    // Closing the editor without saving should fall back to whatever's still indexed from disk,
    // not just delete the symbol from the global index outright.
    ws.removeDocument(uri);
    assert.strictEqual(ws.findWorkspaceSymbols('EDITOR_ONLY_NAME').length, 0);
    assert.strictEqual(ws.findWorkspaceSymbols('DISK_NAME').length, 1);
  });

  it('retracts only the names a changed document no longer contributes, keeping unrelated ones intact', async () => {
    const uriA = await writeFile('multi.asm', 'FIRST = 1\nSECOND = 2\n');
    const uriB = await writeFile('other.asm', 'THIRD = 3\n');
    const ws = new Workspace();
    await ws.indexWorkspace([uriA, uriB], dialectAlwaysFasm2);

    assert.strictEqual(ws.findWorkspaceSymbols('FIRST').length, 1);
    assert.strictEqual(ws.findWorkspaceSymbols('SECOND').length, 1);
    assert.strictEqual(ws.findWorkspaceSymbols('THIRD').length, 1);

    // Edit multi.asm to drop SECOND and add a brand new name, leaving FIRST untouched.
    ws.updateDocument(uriA, 2, 'FIRST = 1\nBRAND_NEW = 4\n', 'fasm2');

    assert.strictEqual(ws.findWorkspaceSymbols('FIRST').length, 1);
    assert.strictEqual(ws.findWorkspaceSymbols('SECOND').length, 0);
    assert.strictEqual(ws.findWorkspaceSymbols('BRAND_NEW').length, 1);
    // A completely unrelated file's symbol must survive an edit to a different file untouched.
    assert.strictEqual(ws.findWorkspaceSymbols('THIRD').length, 1);
  });

  it('never throws when given a mix of missing, unreadable and valid files', async () => {
    const uriValid = await writeFile('ok.asm', 'OK = 1\n');
    const uriMissing = URI.file(path.join(tmpDir, 'does-not-exist.asm')).toString();

    const ws = new Workspace();
    const { indexed, skipped } = await ws.indexWorkspace([uriValid, uriMissing], dialectAlwaysFasm2);
    assert.strictEqual(indexed, 1);
    assert.strictEqual(skipped, 1);
  });

  describe('findEntryFile', () => {
    it('walks back through `include` to find the entry point for a fragment with no format directive', async () => {
      const uriMain = await writeFile('cc.asm', "format ELF64 executable 3\n\ninclude 'lexer.asm'\n");
      const uriFragment = await writeFile('lexer.asm', 'lex_source:\n\tmov r12, rsi\n');

      const ws = new Workspace();
      await ws.indexWorkspace([uriMain, uriFragment], dialectAlwaysFasm2);

      assert.strictEqual(ws.findEntryFile(uriFragment), uriMain);
    });

    it('returns the file itself when it already has a format directive', async () => {
      const uriMain = await writeFile('standalone.asm', 'format binary\nstart:\n\tmov eax, 1\n');
      const ws = new Workspace();
      await ws.indexWorkspace([uriMain], dialectAlwaysFasm2);

      assert.strictEqual(ws.findEntryFile(uriMain), uriMain);
    });

    it('returns undefined for an orphaned fragment with no known includer', async () => {
      const uriOrphan = await writeFile('orphan.inc', 'X = 1\n');
      const ws = new Workspace();
      await ws.indexWorkspace([uriOrphan], dialectAlwaysFasm2);

      assert.strictEqual(ws.findEntryFile(uriOrphan), undefined);
    });

    it('walks multiple levels of inclusion to find the entry point', async () => {
      const uriMain = await writeFile('top.asm', "format binary\ninclude 'mid.inc'\n");
      const uriMid = await writeFile('mid.inc', "include 'leaf.inc'\n");
      const uriLeaf = await writeFile('leaf.inc', 'Y = 1\n');

      const ws = new Workspace();
      await ws.indexWorkspace([uriMain, uriMid, uriLeaf], dialectAlwaysFasm2);

      assert.strictEqual(ws.findEntryFile(uriLeaf), uriMain);
    });
  });

  describe('listEntryPoints', () => {
    it('lists every file with its own format directive, across multiple unrelated projects, and nothing else', async () => {
      // Mirrors a real scenario found in fasmg's own example tree: several independent example
      // programs (each its own entry point) sitting alongside shared fragments and each other,
      // none including one another.
      const uriA = await writeFile('projectA.asm', 'format binary\nstart:\n\tnop\n');
      const uriB = await writeFile('projectB.asm', 'format binary\nstart:\n\tnop\n');
      const uriFragment = await writeFile('shared-util.inc', 'HELPER = 1\n');

      const ws = new Workspace();
      await ws.indexWorkspace([uriA, uriB, uriFragment], dialectAlwaysFasm2);

      const entryPoints = ws.listEntryPoints();
      assert.deepStrictEqual([...entryPoints].sort(), [uriA, uriB].sort());
    });

    it('returns an empty list when no known document has a format directive', async () => {
      const uriFragment = await writeFile('orphan.inc', 'X = 1\n');
      const ws = new Workspace();
      await ws.indexWorkspace([uriFragment], dialectAlwaysFasm2);

      assert.deepStrictEqual(ws.listEntryPoints(), []);
    });
  });

  describe('findReachableEntryPoints', () => {
    it('finds the single entry point for a normal, unambiguous fragment', async () => {
      const uriMain = await writeFile('cc.asm', "format ELF64 executable 3\ninclude 'lexer.asm'\n");
      const uriFragment = await writeFile('lexer.asm', 'lex_source:\n\tnop\n');

      const ws = new Workspace();
      await ws.indexWorkspace([uriMain, uriFragment], dialectAlwaysFasm2);

      assert.deepStrictEqual(ws.findReachableEntryPoints(uriFragment), [uriMain]);
    });

    it('finds every unrelated entry point when a fragment is shared by more than one project (unlike findEntryFile, which silently picks just one)', async () => {
      const uriShared = await writeFile('shared.inc', 'SHARED_CONST = 1\n');
      const uriA = await writeFile('projectA.asm', "format binary\ninclude 'shared.inc'\n");
      const uriB = await writeFile('projectB.asm', "format binary\ninclude 'shared.inc'\n");

      const ws = new Workspace();
      await ws.indexWorkspace([uriShared, uriA, uriB], dialectAlwaysFasm2);

      assert.deepStrictEqual(ws.findReachableEntryPoints(uriShared), [uriA, uriB].sort());
      // findEntryFile still silently returns just one of them — the right choice for diagnostics
      // (any reachable entry compiles the same fragment code the same way), but not for
      // build/run/debug, which actually produces output and needs to know when that's ambiguous.
      assert.ok([uriA, uriB].includes(ws.findEntryFile(uriShared)!));
    });

    it('returns an empty list for a genuinely orphaned fragment', async () => {
      const uriOrphan = await writeFile('orphan.inc', 'X = 1\n');
      const ws = new Workspace();
      await ws.indexWorkspace([uriOrphan], dialectAlwaysFasm2);

      assert.deepStrictEqual(ws.findReachableEntryPoints(uriOrphan), []);
    });
  });
});
