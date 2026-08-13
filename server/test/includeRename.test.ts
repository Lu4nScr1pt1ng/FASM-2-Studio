import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { URI } from 'vscode-uri';
import { includeRenameEdits } from '../src/features/includeRename';
import { Workspace } from '../src/workspace';

const dialectAlwaysFasm2 = () => 'fasm2' as const;

describe('include rewriting on file rename', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fasm2-studio-rename-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  /** Writes a file (creating its directories) and returns its uri. */
  async function writeFile(name: string, content: string): Promise<string> {
    const fsPath = path.join(tmpDir, name);
    await fs.mkdir(path.dirname(fsPath), { recursive: true });
    await fs.writeFile(fsPath, content, 'utf8');
    return URI.file(fsPath).toString();
  }

  function uriOf(name: string): string {
    return URI.file(path.join(tmpDir, name)).toString();
  }

  async function indexed(uris: string[], searchDirs: string[] = []): Promise<Workspace> {
    const ws = new Workspace();
    if (searchDirs.length > 0) ws.setIncludeSearchPaths(searchDirs);
    await ws.indexWorkspace(uris, dialectAlwaysFasm2);
    return ws;
  }

  /** The single edit's replacement text, asserting there is exactly one edit in one file. */
  function onlyEdit(changes: { [uri: string]: { newText: string }[] }, uri: string): string {
    assert.deepStrictEqual(Object.keys(changes), [uri]);
    assert.strictEqual(changes[uri].length, 1);
    return changes[uri][0].newText;
  }

  it('repoints an includer at the renamed file', async () => {
    const main = await writeFile('main.asm', "format ELF64\ninclude 'util.inc'\n");
    await writeFile('util.inc', 'PAGE = 4096\n');

    const ws = await indexed([main, uriOf('util.inc')]);
    const { changes } = includeRenameEdits(ws, [{ oldUri: uriOf('util.inc'), newUri: uriOf('helpers.inc') }]);

    assert.strictEqual(onlyEdit(changes, main), "'helpers.inc'");
  });

  it('replaces the quotes as well as the path, so the line stays syntactically whole', async () => {
    const main = await writeFile('main.asm', "format ELF64\ninclude 'util.inc'\n");
    await writeFile('util.inc', 'PAGE = 4096\n');

    const ws = await indexed([main, uriOf('util.inc')]);
    const { changes } = includeRenameEdits(ws, [{ oldUri: uriOf('util.inc'), newUri: uriOf('helpers.inc') }]);

    const edit = changes[main][0];
    assert.strictEqual(edit.range.start.character, "include ".length);
    assert.strictEqual(edit.range.end.character, "include 'util.inc'".length);
  });

  it('keeps the quote character the author used', async () => {
    const main = await writeFile('main.asm', 'format ELF64\ninclude "util.inc"\n');
    await writeFile('util.inc', 'PAGE = 4096\n');

    const ws = await indexed([main, uriOf('util.inc')]);
    const { changes } = includeRenameEdits(ws, [{ oldUri: uriOf('util.inc'), newUri: uriOf('helpers.inc') }]);

    assert.strictEqual(onlyEdit(changes, main), '"helpers.inc"');
  });

  it('follows a file moved into a subdirectory', async () => {
    const main = await writeFile('main.asm', "format ELF64\ninclude 'util.inc'\n");
    await writeFile('util.inc', 'PAGE = 4096\n');

    const ws = await indexed([main, uriOf('util.inc')]);
    const { changes } = includeRenameEdits(ws, [{ oldUri: uriOf('util.inc'), newUri: uriOf('lib/util.inc') }]);

    assert.strictEqual(onlyEdit(changes, main), "'lib/util.inc'");
  });

  it('follows a file moved out of a subdirectory, with the .. the new path needs', async () => {
    const main = await writeFile('src/main.asm', "format ELF64\ninclude 'util.inc'\n");
    await writeFile('src/util.inc', 'PAGE = 4096\n');

    const ws = await indexed([main, uriOf('src/util.inc')]);
    const { changes } = includeRenameEdits(ws, [{ oldUri: uriOf('src/util.inc'), newUri: uriOf('util.inc') }]);

    assert.strictEqual(onlyEdit(changes, main), "'../util.inc'");
  });

  it('rewrites the moved file’s own includes, which are resolved from its new directory', async () => {
    const main = await writeFile('main.asm', "format ELF64\ninclude 'macros.inc'\n");
    await writeFile('macros.inc', 'PAGE = 4096\n');

    const ws = await indexed([main, uriOf('macros.inc')]);
    const { changes } = includeRenameEdits(ws, [{ oldUri: uriOf('main.asm'), newUri: uriOf('src/main.asm') }]);

    assert.strictEqual(onlyEdit(changes, main), "'../macros.inc'");
  });

  it('leaves an include alone when both ends move together', async () => {
    const main = await writeFile('main.asm', "format ELF64\ninclude 'util.inc'\n");
    await writeFile('util.inc', 'PAGE = 4096\n');

    const ws = await indexed([main, uriOf('util.inc')]);
    const { changes } = includeRenameEdits(ws, [
      { oldUri: uriOf('main.asm'), newUri: uriOf('src/main.asm') },
      { oldUri: uriOf('util.inc'), newUri: uriOf('src/util.inc') },
    ]);

    assert.deepStrictEqual(changes, {});
  });

  it('keeps an include that resolves through the include search path written that way', async () => {
    const main = await writeFile('main.asm', "format ELF64\ninclude 'win64a.inc'\n");
    await writeFile('include/win64a.inc', 'PAGE = 4096\n');

    const ws = await indexed([main, uriOf('include/win64a.inc')], [path.join(tmpDir, 'include')]);
    const { changes } = includeRenameEdits(ws, [{ oldUri: uriOf('main.asm'), newUri: uriOf('src/main.asm') }]);

    // The path is written against the search directory, not against main.asm, so moving main.asm
    // cannot invalidate it — a "../include/win64a.inc" rewrite here would be a worse line.
    assert.deepStrictEqual(changes, {});
  });

  it('falls back to a relative path when the target leaves every search directory', async () => {
    const main = await writeFile('main.asm', "format ELF64\ninclude 'win64a.inc'\n");
    await writeFile('include/win64a.inc', 'PAGE = 4096\n');

    const ws = await indexed([main, uriOf('include/win64a.inc')], [path.join(tmpDir, 'include')]);
    const { changes } = includeRenameEdits(ws, [
      { oldUri: uriOf('include/win64a.inc'), newUri: uriOf('vendor/win64a.inc') },
    ]);

    assert.strictEqual(onlyEdit(changes, main), "'vendor/win64a.inc'");
  });

  it('keeps a backslash-written path backslashed', async () => {
    const main = await writeFile('main.asm', "format PE64 GUI\ninclude 'api\\kernel32.inc'\n");
    await writeFile('api/kernel32.inc', 'PAGE = 4096\n');

    const ws = await indexed([main, uriOf('api/kernel32.inc')]);
    const { changes } = includeRenameEdits(ws, [
      { oldUri: uriOf('api/kernel32.inc'), newUri: uriOf('api/win32/kernel32.inc') },
    ]);

    assert.strictEqual(onlyEdit(changes, main), "'api\\win32\\kernel32.inc'");
  });

  it('leaves an include that does not resolve today untouched', async () => {
    const main = await writeFile('main.asm', "format ELF64\ninclude 'nowhere.inc'\ninclude 'util.inc'\n");
    await writeFile('util.inc', 'PAGE = 4096\n');

    const ws = await indexed([main, uriOf('util.inc')]);
    const { changes } = includeRenameEdits(ws, [{ oldUri: uriOf('util.inc'), newUri: uriOf('helpers.inc') }]);

    assert.strictEqual(onlyEdit(changes, main), "'helpers.inc'");
  });

  it('rewrites every includer of the same file, in every file that includes it', async () => {
    const one = await writeFile('one.asm', "format ELF64\ninclude 'util.inc'\n");
    const two = await writeFile('two.asm', "format ELF64\ninclude 'util.inc'\ninclude 'util.inc'\n");
    await writeFile('util.inc', 'PAGE = 4096\n');

    const ws = await indexed([one, two, uriOf('util.inc')]);
    const { changes } = includeRenameEdits(ws, [{ oldUri: uriOf('util.inc'), newUri: uriOf('lib/util.inc') }]);

    assert.strictEqual(changes[one].length, 1);
    assert.strictEqual(changes[two].length, 2);
    for (const edit of [...changes[one], ...changes[two]]) assert.strictEqual(edit.newText, "'lib/util.inc'");
  });

  it('reports no edits when nothing actually moved', async () => {
    const main = await writeFile('main.asm', "format ELF64\ninclude 'util.inc'\n");
    await writeFile('util.inc', 'PAGE = 4096\n');

    const ws = await indexed([main, uriOf('util.inc')]);
    const { changes } = includeRenameEdits(ws, [{ oldUri: uriOf('util.inc'), newUri: uriOf('util.inc') }]);

    assert.deepStrictEqual(changes, {});
  });

  it('uses the live buffer of an unsaved includer rather than what is on disk', async () => {
    const main = await writeFile('main.asm', 'format ELF64\n');
    await writeFile('util.inc', 'PAGE = 4096\n');

    const ws = await indexed([main, uriOf('util.inc')]);
    ws.updateDocument(main, 2, "format ELF64\ninclude 'util.inc'\n", 'fasm2');

    const { changes } = includeRenameEdits(ws, [{ oldUri: uriOf('util.inc'), newUri: uriOf('helpers.inc') }]);
    assert.strictEqual(onlyEdit(changes, main), "'helpers.inc'");
  });
});
