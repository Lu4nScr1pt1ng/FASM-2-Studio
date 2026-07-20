// Tests the probe/cache/in-flight-dedup logic against fake tools on a controlled PATH, rather
// than only ever exercising it against whatever real fasm2 happens to be installed on the
// machine running the suite. This is exactly the category of module that produced two real bugs
// earlier (a blocking spawnSync, and a Windows exit-code false-positive) without ever having a
// direct test — those only surfaced via slower, indirect integration tests.
import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { invalidateCompilerCache, resolveCompilerOnPath } from '../src/compilerDiscovery';

describe('resolveCompilerOnPath (against fake tools on a controlled PATH)', () => {
  let tmpDir: string;
  let originalPath: string | undefined;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fasm2-studio-compiler-discovery-'));
    originalPath = process.env.PATH;
    // Replace, not prepend: this dev machine has a real fasm2 installed, and prepending would
    // let it leak into the "not found" test if a fake candidate's name happened to be absent.
    process.env.PATH = tmpDir;
    invalidateCompilerCache();
  });

  afterEach(async () => {
    process.env.PATH = originalPath;
    invalidateCompilerCache();
    await fs.rm(tmpDir, { recursive: true, force: true });
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
});
