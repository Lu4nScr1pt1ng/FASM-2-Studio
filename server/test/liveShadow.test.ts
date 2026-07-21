import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildLiveShadowRoot } from '../src/features/liveShadow';

describe('buildLiveShadowRoot', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fasm2-studio-shadow-test-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('overrides the live document itself when it is the compile target', async () => {
    const main = path.join(dir, 'main.asm');
    fs.writeFileSync(main, 'format binary\nmov eax, 1\n');

    const shadow = await buildLiveShadowRoot(main, main, 'format binary\nmov eax, 2\n');
    assert.ok(shadow);
    assert.strictEqual(fs.readFileSync(shadow!.compileFsPath, 'utf8'), 'format binary\nmov eax, 2\n');
    assert.strictEqual(fs.readFileSync(main, 'utf8'), 'format binary\nmov eax, 1\n', 'the real file on disk must be untouched');

    await shadow!.cleanup();
    assert.ok(!fs.existsSync(shadow!.compileFsPath), 'shadow root should be gone after cleanup');
    assert.ok(fs.existsSync(main), 'real file must survive cleanup');
  });

  it('symlinks untouched siblings back to their real content', async () => {
    const main = path.join(dir, 'main.asm');
    const sibling = path.join(dir, 'sibling.inc');
    fs.writeFileSync(main, "format binary\ninclude 'sibling.inc'\n");
    fs.writeFileSync(sibling, 'db 1\n');

    const shadow = await buildLiveShadowRoot(main, main, "format binary\ninclude 'sibling.inc'\nlive\n");
    assert.ok(shadow);
    const shadowSibling = path.join(shadow!.cwd, 'sibling.inc');
    assert.strictEqual(fs.readFileSync(shadowSibling, 'utf8'), 'db 1\n');

    await shadow!.cleanup();
  });

  it('overrides a nested fragment while leaving the entry file a symlink to the real one', async () => {
    const main = path.join(dir, 'main.asm');
    fs.mkdirSync(path.join(dir, 'util'));
    const fragment = path.join(dir, 'util', 'macros.inc');
    fs.writeFileSync(main, "format binary\ninclude 'util/macros.inc'\n");
    fs.writeFileSync(fragment, 'db 1\n');

    const shadow = await buildLiveShadowRoot(main, fragment, 'db 2 ; live edit\n');
    assert.ok(shadow);
    assert.strictEqual(path.basename(shadow!.compileFsPath), 'main.asm');
    assert.strictEqual(fs.readFileSync(shadow!.compileFsPath, 'utf8'), "format binary\ninclude 'util/macros.inc'\n", 'entry file itself was not edited');
    assert.strictEqual(fs.readFileSync(path.join(shadow!.cwd, 'util', 'macros.inc'), 'utf8'), 'db 2 ; live edit\n');
    assert.strictEqual(fs.readFileSync(fragment, 'utf8'), 'db 1\n', 'the real fragment on disk must be untouched');

    await shadow!.cleanup();
    assert.ok(fs.existsSync(fragment), 'real fragment must survive cleanup');
  });

  it('resolves an include that climbs above the entry file\'s own directory with ".."', async () => {
    // Mirrors a real, confirmed bug found in fasm2's own source tree: source/windows/dll/fasmg.asm
    // has "include '../../version.inc'" (two levels above its own directory) -- the shadow used to
    // mirror only the entry file's immediate directory into an unrelated fresh temp root, so a
    // ".." include escaped into that temp root's real, unrelated parent instead of the project's
    // actual ancestor directory, and failed to resolve even though the real (non-shadowed) compile
    // works fine.
    fs.mkdirSync(path.join(dir, 'source', 'windows', 'dll'), { recursive: true });
    const shared = path.join(dir, 'source', 'shared.inc');
    fs.writeFileSync(shared, 'db 42\n');
    const main = path.join(dir, 'source', 'windows', 'dll', 'fasmg.asm');
    fs.writeFileSync(main, "format binary\ninclude '../../shared.inc'\n");

    const shadow = await buildLiveShadowRoot(main, main, "format binary\ninclude '../../shared.inc'\nlive\n");
    assert.ok(shadow);
    const resolved = path.join(shadow!.cwd, '..', '..', 'shared.inc');
    assert.strictEqual(fs.readFileSync(resolved, 'utf8'), 'db 42\n');

    await shadow!.cleanup();
  });

  it('returns undefined when the live document lives outside the target directory', async () => {
    const main = path.join(dir, 'sub', 'main.asm');
    fs.mkdirSync(path.join(dir, 'sub'));
    fs.writeFileSync(main, 'format binary\n');
    const outsider = path.join(dir, 'outsider.inc');
    fs.writeFileSync(outsider, 'db 1\n');

    const shadow = await buildLiveShadowRoot(main, outsider, 'db 2\n');
    assert.strictEqual(shadow, undefined);
  });

  it('returns undefined instead of throwing when the target directory does not exist', async () => {
    const missing = path.join(dir, 'does-not-exist', 'main.asm');
    const shadow = await buildLiveShadowRoot(missing, missing, 'format binary\n');
    assert.strictEqual(shadow, undefined);
  });
});
