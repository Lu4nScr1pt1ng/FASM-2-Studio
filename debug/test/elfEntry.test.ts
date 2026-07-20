import * as assert from 'assert';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readElfEntryPoint } from '../src/elfEntry';

function isAvailable(command: string): boolean {
  const result = spawnSync(command, ['--version'], { timeout: 5000 });
  return !(result.error && (result.error as NodeJS.ErrnoException).code === 'ENOENT');
}

describe('readElfEntryPoint', () => {
  it('reads the real entry point of a fasm2-built ELF64 executable', function () {
    if (!isAvailable('fasm2') || os.platform() !== 'linux') {
      this.skip();
      return;
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fasm2-studio-elf-test-'));
    try {
      const asmPath = path.join(dir, 'prog.asm');
      const programPath = path.join(dir, 'prog');
      fs.writeFileSync(asmPath, ['format ELF64 executable 3', 'entry start', '', 'segment readable executable', '', 'start:', '\tnop', ''].join('\n'));
      const build = spawnSync('fasm2', [asmPath, programPath], { cwd: dir, timeout: 15000 });
      assert.strictEqual(build.status, 0, `fasm2 build failed: ${build.stdout}${build.stderr}`);

      const entry = readElfEntryPoint(programPath);
      assert.ok(entry !== undefined);
      assert.ok(entry! > 0n);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns undefined for a non-ELF file instead of throwing', () => {
    const tmp = path.join(os.tmpdir(), `fasm2-studio-not-elf-${Date.now()}.bin`);
    fs.writeFileSync(tmp, 'this is not an ELF file');
    try {
      assert.strictEqual(readElfEntryPoint(tmp), undefined);
    } finally {
      fs.rmSync(tmp);
    }
  });

  it('returns undefined for a missing file instead of throwing', () => {
    assert.strictEqual(readElfEntryPoint('/nonexistent/path/to/nothing'), undefined);
  });
});
