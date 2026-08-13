// Tests the probe/cache/in-flight-dedup logic against fake tools on a controlled PATH, rather
// than only ever exercising it against whatever real fasm2 happens to be installed on the
// machine running the suite. This is exactly the category of module that produced two real bugs
// earlier (a blocking spawnSync, and a Windows exit-code false-positive) without ever having a
// direct test — those only surfaced via slower, indirect integration tests.
import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as path from 'path';
import { hasX86Preload, invalidateCompilerCache, resolveCompilerOnPath } from '../src/compilerDiscovery';
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
