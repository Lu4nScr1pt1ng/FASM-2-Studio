// Tests the probe/cache/in-flight-dedup logic against fake tools on a controlled PATH, rather
// than only ever exercising it against whatever real fasm2 happens to be installed on the
// machine running the suite. This is exactly the category of module that produced two real bugs
// earlier (a blocking spawnSync, and a Windows exit-code false-positive) without ever having a
// direct test — those only surfaced via slower, indirect integration tests.
import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as path from 'path';
import { detectBundledIncludeDir, hasX86Preload, invalidateCompilerCache, resolveAbsolutePath, resolveCompilerOnPath } from '../src/compilerDiscovery';
import { makeTempDir, removeTempDir } from './tempDir';

describe('resolveCompilerOnPath (against fake tools on a controlled PATH)', () => {
  let tmpDir: string;
  let originalPath: string | undefined;
  let originalHome: string | undefined;

  beforeEach(async () => {
    tmpDir = makeTempDir('fasm2-studio-compiler-discovery-');
    originalPath = process.env.PATH;
    originalHome = process.env.HOME;
    // Replace, not prepend: this dev machine has a real fasm2 installed, and prepending would
    // let it leak into the "not found" test if a fake candidate's name happened to be absent.
    process.env.PATH = tmpDir;
    // PATH alone does not isolate this: discovery also probes well-known install directories by
    // absolute path (see extraSearchDirs), and ~/.local/bin is both one of them and the location
    // this project's own README tells people to install into. Pointing HOME at the empty temp
    // directory is what actually makes "not found" mean not found, on any developer's machine.
    process.env.HOME = tmpDir;
    invalidateCompilerCache();
  });

  afterEach(async () => {
    process.env.PATH = originalPath;
    process.env.HOME = originalHome;
    invalidateCompilerCache();
    await removeTempDir(tmpDir);
  });

  async function writeFakeTool(name: string, script: string): Promise<void> {
    const fsPath = path.join(tmpDir, name);
    await fs.writeFile(fsPath, `#!/bin/sh\n${script}\n`, 'utf8');
    await fs.chmod(fsPath, 0o755);
  }

  it('resolves a candidate whose output contains the flat assembler banner', async () => {
    await writeFakeTool('fasm2', 'echo "flat assembler  version g.fake"');
    const result = await resolveCompilerOnPath('fasm2');
    assert.strictEqual(result, 'fasm2');
  });

  it('skips a first candidate that exists but is not actually a flat assembler, and finds the second', async () => {
    // Simulates a PATH collision: something else entirely happens to be named "fasm2".
    await writeFakeTool('fasm2', 'echo "unrelated tool, not what you think"; exit 1');
    await writeFakeTool('fasmg', 'echo "flat assembler  version g.fake"');
    const result = await resolveCompilerOnPath('fasm2');
    assert.strictEqual(result, 'fasmg');
  });

  it('returns undefined when neither candidate exists or matches', async () => {
    const result = await resolveCompilerOnPath('fasm2');
    assert.strictEqual(result, undefined);
  });

  it('does not misreport a found tool as missing just because it exits non-zero', async () => {
    // fasm2 itself exits non-zero when run with no arguments (it prints usage and returns an
    // error code) -- detection must not treat "found but exited non-zero" as "not found".
    await writeFakeTool('fasm2', 'echo "flat assembler  version g.fake"; exit 2');
    const result = await resolveCompilerOnPath('fasm2');
    assert.strictEqual(result, 'fasm2');
  });

  it('caches the result: a second call succeeds even after the tool is removed from disk', async () => {
    await writeFakeTool('fasm2', 'echo "flat assembler  version g.fake"');
    const first = await resolveCompilerOnPath('fasm2');
    assert.strictEqual(first, 'fasm2');

    await fs.rm(path.join(tmpDir, 'fasm2'));
    const second = await resolveCompilerOnPath('fasm2');
    assert.strictEqual(second, 'fasm2', 'expected the cached result, not a fresh (now-failing) probe');
  });

  it('shares one in-flight probe across concurrent callers instead of spawning once per caller', async () => {
    const counterFile = path.join(tmpDir, 'invocations.txt');
    await writeFakeTool('fasm2', `echo "x" >> "${counterFile}"; sleep 0.2; echo "flat assembler  version g.fake"`);

    const [a, b, c] = await Promise.all([resolveCompilerOnPath('fasm2'), resolveCompilerOnPath('fasm2'), resolveCompilerOnPath('fasm2')]);
    assert.deepStrictEqual([a, b, c], ['fasm2', 'fasm2', 'fasm2']);

    const invocations = (await fs.readFile(counterFile, 'utf8')).trim().split('\n').filter(Boolean);
    assert.strictEqual(invocations.length, 1, `expected exactly one probe spawn, got ${invocations.length}`);
  });

  it('resolves independently per dialect rather than sharing a single cache slot', async () => {
    await writeFakeTool('fasm2', 'echo "flat assembler  version g.fake (fasm2)"');
    await writeFakeTool('fasm1', 'echo "flat assembler  version 1.fake (fasm1)"');

    const [fasm2Result, fasm1Result] = await Promise.all([resolveCompilerOnPath('fasm2'), resolveCompilerOnPath('fasm1')]);
    assert.strictEqual(fasm2Result, 'fasm2');
    assert.strictEqual(fasm1Result, 'fasm1');
  });

  it('invalidateCompilerCache forces a fresh probe on the next call', async () => {
    await writeFakeTool('fasm2', 'echo "flat assembler  version g.fake"');
    assert.strictEqual(await resolveCompilerOnPath('fasm2'), 'fasm2');

    await fs.rm(path.join(tmpDir, 'fasm2'));
    invalidateCompilerCache();
    assert.strictEqual(await resolveCompilerOnPath('fasm2'), undefined, 'expected a fresh probe to reflect the tool now being gone');
  });

  describe('falling back to well-known install directories not on PATH', () => {
    let originalHome: string | undefined;
    let emptyPathDir: string;

    beforeEach(async () => {
      // PATH points somewhere that genuinely has nothing in it, simulating a GUI-launched process
      // whose PATH lacks the ~/.local/bin an interactive shell's rc file would normally add.
      emptyPathDir = makeTempDir('fasm2-studio-compiler-discovery-emptypath-');
      process.env.PATH = emptyPathDir;
      originalHome = process.env.HOME;
      process.env.HOME = tmpDir;
    });

    afterEach(async () => {
      process.env.HOME = originalHome;
      await removeTempDir(emptyPathDir);
    });

    it('finds a tool in ~/.local/bin even when PATH does not include it', async () => {
      const localBin = path.join(tmpDir, '.local', 'bin');
      await fs.mkdir(localBin, { recursive: true });
      const fsPath = path.join(localBin, 'fasm2');
      await fs.writeFile(fsPath, '#!/bin/sh\necho "flat assembler  version g.fake"\n', 'utf8');
      await fs.chmod(fsPath, 0o755);

      const result = await resolveCompilerOnPath('fasm2');
      assert.strictEqual(result, fsPath);
    });

    it('still prefers a PATH match over the ~/.local/bin fallback', async () => {
      await writeFakeTool('fasm2', 'echo "flat assembler  version g.fake (on PATH)"');
      process.env.PATH = `${emptyPathDir}${path.delimiter}${tmpDir}`;

      const localBin = path.join(tmpDir, '.local', 'bin');
      await fs.mkdir(localBin, { recursive: true });
      const fallbackPath = path.join(localBin, 'fasm2');
      await fs.writeFile(fallbackPath, '#!/bin/sh\necho "flat assembler  version g.fake (fallback)"\n', 'utf8');
      await fs.chmod(fallbackPath, 0o755);

      const result = await resolveCompilerOnPath('fasm2');
      assert.strictEqual(result, 'fasm2', 'expected the bare PATH-resolved name, not the ~/.local/bin full path');
    });
  });
});

describe('hasX86Preload (against fake tools that do or do not know an instruction set)', () => {
  // fasm2 is the fasmg binary plus a wrapper preloading the x86 package; the two executables are
  // byte-identical and print the same banner, so only a functional probe distinguishes them.
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = makeTempDir('fasm2-studio-preload-test-');
    invalidateCompilerCache();
  });

  afterEach(async () => {
    invalidateCompilerCache();
    await removeTempDir(tmpDir);
  });

  async function writeFakeTool(name: string, script: string): Promise<string> {
    const fsPath = path.join(tmpDir, name);
    await fs.writeFile(fsPath, `#!/bin/sh\n${script}\n`, 'utf8');
    await fs.chmod(fsPath, 0o755);
    return fsPath;
  }

  it('reports a preload for a tool that assembles the probe source', async () => {
    const tool = await writeFakeTool('fasm2', 'echo "flat assembler  version g.fake"; echo "1 pass, 1 byte."; exit 0');
    assert.strictEqual(await hasX86Preload(tool), true);
  });

  it('reports no preload for a tool that rejects the probe as an illegal instruction', async () => {
    // Exactly what a bare fasmg does with "nop": it has no instruction set at all.
    const tool = await writeFakeTool('fasmg', 'echo "flat assembler  version g.fake"; echo "Error: illegal instruction."; exit 2');
    assert.strictEqual(await hasX86Preload(tool), false);
  });

  it('does not confuse an ordinary failure with a missing instruction set', async () => {
    const tool = await writeFakeTool('fasm2', 'echo "Error: out of memory."; exit 2');
    assert.strictEqual(await hasX86Preload(tool), true);
  });

  it('assumes a preload when the tool cannot be run at all, so a broken probe never becomes a false accusation', async () => {
    assert.strictEqual(await hasX86Preload(path.join(tmpDir, 'does-not-exist')), true);
  });

  it('caches per path: a second call succeeds even after the tool is removed from disk', async () => {
    const tool = await writeFakeTool('fasmg', 'echo "Error: illegal instruction."; exit 2');
    assert.strictEqual(await hasX86Preload(tool), false);

    await fs.rm(tool);
    assert.strictEqual(await hasX86Preload(tool), false, 'expected the cached answer, not a fresh (now-failing) probe');
  });

  it('shares one in-flight probe across concurrent callers', async () => {
    const counterFile = path.join(tmpDir, 'preload-invocations.txt');
    const tool = await writeFakeTool('fasm2', `echo x >> ${counterFile}; exit 0`);

    await Promise.all([hasX86Preload(tool), hasX86Preload(tool), hasX86Preload(tool)]);

    const invocations = (await fs.readFile(counterFile, 'utf8')).trim().split('\n').length;
    assert.strictEqual(invocations, 1, 'expected concurrent callers to share a single probe');
  });
});

describe('resolveAbsolutePath (against a controlled PATH)', () => {
  let tmpDir: string;
  let originalPath: string | undefined;

  beforeEach(() => {
    tmpDir = makeTempDir('fasm2-studio-resolve-absolute-');
    originalPath = process.env.PATH;
    process.env.PATH = tmpDir;
  });

  afterEach(async () => {
    process.env.PATH = originalPath;
    await removeTempDir(tmpDir);
  });

  it('returns an already-absolute path unchanged, once confirmed to exist', async () => {
    const file = path.join(tmpDir, 'fasm2');
    await fs.writeFile(file, '', 'utf8');
    assert.strictEqual(resolveAbsolutePath(file), file);
  });

  it('returns undefined for an absolute path that does not exist', () => {
    assert.strictEqual(resolveAbsolutePath(path.join(tmpDir, 'does-not-exist')), undefined);
  });

  it('finds a bare command name by searching PATH, trying PATHEXT entries on Windows', async () => {
    const file = path.join(tmpDir, process.platform === 'win32' ? 'fasm2.exe' : 'fasm2');
    await fs.writeFile(file, '', 'utf8');
    // Built from PATHEXT (conventionally uppercase, ".EXE") rather than read back off disk, so the
    // result is case-equivalent to the real file on Windows's case-insensitive filesystem without
    // necessarily matching the exact case it was created with — a distinction that never matters to
    // anything that goes on to open the path, only to a test asserting the literal string.
    assert.strictEqual(resolveAbsolutePath('fasm2')?.toLowerCase(), file.toLowerCase());
  });

  it('returns undefined for a bare command name found nowhere on PATH', () => {
    assert.strictEqual(resolveAbsolutePath('does-not-exist-anywhere'), undefined);
  });
});

describe('detectBundledIncludeDir (against a fake fasm2 install layout)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir('fasm2-studio-bundled-include-');
    invalidateCompilerCache();
  });

  afterEach(async () => {
    invalidateCompilerCache();
    await removeTempDir(tmpDir);
  });

  /** Mirrors the real fasm2 distribution's own layout: the binary sits directly beside `include/`,
   * which holds win64a.inc alongside everything else it bundles. `withMarker` controls whether
   * fasm2.inc — the file this detector treats as fasm2's own signature — is present, so both the
   * "real install" and "coincidentally named folder" cases can be exercised. */
  async function makeInstall(withMarker: boolean): Promise<string> {
    const binPath = path.join(tmpDir, process.platform === 'win32' ? 'fasm2.cmd' : 'fasm2');
    await fs.writeFile(binPath, '', 'utf8');
    const includeDir = path.join(tmpDir, 'include');
    await fs.mkdir(includeDir);
    await fs.writeFile(path.join(includeDir, 'win64a.inc'), '', 'utf8');
    if (withMarker) await fs.writeFile(path.join(includeDir, 'fasm2.inc'), '', 'utf8');
    return binPath;
  }

  it("finds the include directory next to the binary, once fasm2.inc confirms it is really fasm2's own", async () => {
    const binPath = await makeInstall(true);
    assert.strictEqual(detectBundledIncludeDir(binPath), path.join(tmpDir, 'include'));
  });

  it('refuses a same-named "include" directory that has no fasm2.inc in it — not every "include" folder next to a binary is fasm2\'s', async () => {
    const binPath = await makeInstall(false);
    assert.strictEqual(detectBundledIncludeDir(binPath), undefined);
  });

  it('returns undefined for a binary that does not exist at all', () => {
    assert.strictEqual(detectBundledIncludeDir(path.join(tmpDir, 'does-not-exist')), undefined);
  });

  it('caches per compiler path: a directory removed after the first call still answers the cached way', async () => {
    const binPath = await makeInstall(true);
    assert.strictEqual(detectBundledIncludeDir(binPath), path.join(tmpDir, 'include'));

    await fs.rm(path.join(tmpDir, 'include'), { recursive: true, force: true });
    assert.strictEqual(detectBundledIncludeDir(binPath), path.join(tmpDir, 'include'), 'expected the cached answer, not a fresh (now-missing) check');
  });

  it('invalidateCompilerCache clears the cache too, so a settings change can pick up a real install change', async () => {
    const binPath = await makeInstall(true);
    assert.strictEqual(detectBundledIncludeDir(binPath), path.join(tmpDir, 'include'));

    await fs.rm(path.join(tmpDir, 'include'), { recursive: true, force: true });
    invalidateCompilerCache();
    assert.strictEqual(detectBundledIncludeDir(binPath), undefined);
  });

  it('resolves a bare command name via PATH before deriving the include directory', async () => {
    const binPath = await makeInstall(true);
    const originalPath = process.env.PATH;
    process.env.PATH = tmpDir;
    try {
      const bareName = path.basename(binPath, path.extname(binPath));
      assert.strictEqual(detectBundledIncludeDir(bareName), path.join(tmpDir, 'include'));
    } finally {
      process.env.PATH = originalPath;
    }
  });
});
