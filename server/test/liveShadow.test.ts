import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { buildLiveShadowRoot, buildShadowRoot } from '../src/features/liveShadow';
import { makeTempDir, removeTempDir } from './tempDir';

describe('buildLiveShadowRoot', () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempDir('fasm2-studio-shadow-test-');
  });

  afterEach(async () => {
    await removeTempDir(dir);
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

  // `src/main.asm` + `include '../lib/x.inc'`: the library's unsaved text was ignored, so its
  // program showed the errors of the last saved version.
  it('overrides a live document beside an ancestor of the target directory', async () => {
    const main = path.join(dir, 'src', 'main.asm');
    const lib = path.join(dir, 'lib', 'x.inc');
    fs.mkdirSync(path.dirname(main));
    fs.mkdirSync(path.dirname(lib));
    fs.writeFileSync(main, "format binary\ninclude '../lib/x.inc'\n");
    fs.writeFileSync(lib, 'db 1\n');

    const shadow = await buildLiveShadowRoot(main, lib, 'db 2\n');
    assert.ok(shadow);
    try {
      assert.strictEqual(fs.readFileSync(path.resolve(shadow!.cwd, '../lib/x.inc'), 'utf8'), 'db 2\n');
      assert.ok(fs.lstatSync(shadow!.compileFsPath).isSymbolicLink(), 'the entry file stays a link to the real one');
      assert.strictEqual(shadow!.toRealPath(path.resolve(shadow!.cwd, '../lib/x.inc')), lib);
      assert.strictEqual(fs.readFileSync(lib, 'utf8'), 'db 1\n', 'the real file on disk must be untouched');
    } finally {
      await shadow!.cleanup();
    }
  });

  it('overrides a live document opened through a symlinked directory', async () => {
    const main = path.join(dir, 'src', 'main.asm');
    fs.mkdirSync(path.join(dir, 'src'));
    fs.mkdirSync(path.join(dir, 'shared'));
    fs.writeFileSync(path.join(dir, 'shared', 'x.inc'), 'db 1\n');
    fs.writeFileSync(path.join(dir, 'shared', 'y.inc'), 'db 3\n');
    fs.symlinkSync('../shared', path.join(dir, 'src', 'linked'));
    fs.writeFileSync(main, "format binary\ninclude 'linked/x.inc'\n");

    const shadow = await buildLiveShadowRoot(main, path.join(dir, 'src', 'linked', 'x.inc'), 'db 2\n');
    assert.ok(shadow);
    try {
      assert.strictEqual(fs.readFileSync(path.join(shadow!.cwd, 'linked', 'x.inc'), 'utf8'), 'db 2\n');
      assert.strictEqual(fs.readFileSync(path.join(shadow!.cwd, 'linked', 'y.inc'), 'utf8'), 'db 3\n', 'its siblings are still reachable');
      assert.strictEqual(fs.readFileSync(path.join(dir, 'shared', 'x.inc'), 'utf8'), 'db 1\n', 'the real file on disk must be untouched');
    } finally {
      await shadow!.cleanup();
    }
  });

  it('returns undefined instead of throwing when the target directory does not exist', async () => {
    const missing = path.join(dir, 'does-not-exist', 'main.asm');
    const shadow = await buildLiveShadowRoot(missing, missing, 'format binary\n');
    assert.strictEqual(shadow, undefined);
  });

  describe('toRealPath', () => {
    // The compiler only ever sees the shadow tree, so every location it reports for an included
    // file names a temp directory about to be deleted. Diagnostics for those files are unusable
    // until translated back.
    it('translates a reported shadow path back to the real project file', async () => {
      const main = path.join(dir, 'main.asm');
      const sibling = path.join(dir, 'sibling.inc');
      fs.writeFileSync(main, "format binary\ninclude 'sibling.inc'\n");
      fs.writeFileSync(sibling, 'db 1\n');

      const shadow = await buildLiveShadowRoot(main, main, "format binary\ninclude 'sibling.inc'\n");
      assert.ok(shadow);
      assert.strictEqual(shadow!.toRealPath(path.join(shadow!.cwd, 'sibling.inc')), sibling);

      await shadow!.cleanup();
    });

    it('translates a path in a mirrored ancestor directory, not just the compile directory', async () => {
      const main = path.join(dir, 'src', 'main.asm');
      fs.mkdirSync(path.join(dir, 'src'));
      fs.writeFileSync(main, "format binary\ninclude '../shared.inc'\n");
      const shared = path.join(dir, 'shared.inc');
      fs.writeFileSync(shared, 'db 1\n');

      const shadow = await buildLiveShadowRoot(main, main, "format binary\ninclude '../shared.inc'\n");
      assert.ok(shadow);
      assert.strictEqual(shadow!.toRealPath(path.join(shadow!.cwd, '..', 'shared.inc')), shared);

      await shadow!.cleanup();
    });

    it('returns undefined for a path that was never part of the shadow tree', async () => {
      const main = path.join(dir, 'main.asm');
      fs.writeFileSync(main, 'format binary\n');

      const shadow = await buildLiveShadowRoot(main, main, 'format binary\n');
      assert.ok(shadow);
      // An absolute path the compiler printed for a file it found elsewhere — the assembler's own
      // include library, say — is already real and must be handed back untranslated.
      assert.strictEqual(shadow!.toRealPath('/usr/share/fasm2/include/format/elfexe.inc'), undefined);

      await shadow!.cleanup();
    });
  });
});

describe('buildShadowRoot', () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempDir('fasm2-studio-shadow-test-');
  });

  afterEach(async () => {
    await removeTempDir(dir);
  });

  // A program is a whole include tree: compiling it with one file's buffer and the rest as saved
  // assembled a program that does not exist (an unsaved include added to the entry point was
  // invisible to every other file's compile).
  it('puts every open buffer inside the target directory in place of its file', async () => {
    const main = path.join(dir, 'main.asm');
    const lib = path.join(dir, 'lib', 'util.inc');
    fs.mkdirSync(path.dirname(lib));
    fs.writeFileSync(main, 'format binary\n');
    fs.writeFileSync(lib, 'db 1\n');
    fs.writeFileSync(path.join(dir, 'untouched.inc'), 'db 3\n');

    const shadow = await buildShadowRoot(main, new Map([[main, "format binary\ninclude 'lib/util.inc'\n"], [lib, 'db 2\n']]));
    assert.ok(shadow);
    try {
      assert.strictEqual(fs.readFileSync(shadow.compileFsPath, 'utf8'), "format binary\ninclude 'lib/util.inc'\n");
      assert.strictEqual(fs.readFileSync(path.join(shadow.cwd, 'lib', 'util.inc'), 'utf8'), 'db 2\n');
      assert.ok(fs.lstatSync(path.join(shadow.cwd, 'untouched.inc')).isSymbolicLink(), 'files without a buffer stay links to the real ones');
      assert.strictEqual(shadow.toRealPath(path.join(shadow.cwd, 'lib', 'util.inc')), lib);
      assert.strictEqual(fs.readFileSync(lib, 'utf8'), 'db 1\n', 'the real file on disk must be untouched');
    } finally {
      await shadow.cleanup();
    }
  });

  it('keeps the buffer of a file deleted on disk while still open', async () => {
    const main = path.join(dir, 'main.asm');
    fs.writeFileSync(main, 'format binary\n');
    const gone = path.join(dir, 'gone', 'mod.inc');

    const shadow = await buildShadowRoot(main, new Map([[gone, 'db 7\n']]));
    assert.ok(shadow);
    try {
      assert.strictEqual(fs.readFileSync(path.join(shadow.cwd, 'gone', 'mod.inc'), 'utf8'), 'db 7\n');
    } finally {
      await shadow.cleanup();
    }
  });

  it('returns undefined when there are no buffers at all (the real file is compiled)', async () => {
    const main = path.join(dir, 'project', 'main.asm');
    fs.mkdirSync(path.dirname(main));
    fs.writeFileSync(main, 'format binary\n');
    assert.strictEqual(await buildShadowRoot(main, new Map()), undefined);
  });
});
