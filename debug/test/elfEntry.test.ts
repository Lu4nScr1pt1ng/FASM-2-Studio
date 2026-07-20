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

  function writeTemp(name: string, content: Buffer): string {
    const tmp = path.join(os.tmpdir(), `${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.writeFileSync(tmp, content);
    return tmp;
  }

  it('reads a hand-crafted ELF32 header (little-endian) correctly', () => {
    const header = Buffer.alloc(32);
    header.set([0x7f, 0x45, 0x4c, 0x46], 0); // magic
    header[4] = 1; // EI_CLASS = ELFCLASS32
    header[5] = 1; // EI_DATA = little-endian
    header.writeUInt32LE(0x08048080, 24); // e_entry (4 bytes for ELF32)

    const tmp = writeTemp('fasm2-studio-elf32', header);
    try {
      assert.strictEqual(readElfEntryPoint(tmp), 0x08048080n);
    } finally {
      fs.rmSync(tmp);
    }
  });

  it('reads a hand-crafted ELF64 header with a large (high-bit) entry address', () => {
    const header = Buffer.alloc(32);
    header.set([0x7f, 0x45, 0x4c, 0x46], 0);
    header[4] = 2; // EI_CLASS = ELFCLASS64
    header[5] = 1;
    header.writeBigUInt64LE(0xffffffff81000000n, 24); // a typical Linux kernel-space-style address

    const tmp = writeTemp('fasm2-studio-elf64-high', header);
    try {
      assert.strictEqual(readElfEntryPoint(tmp), 0xffffffff81000000n);
    } finally {
      fs.rmSync(tmp);
    }
  });

  it('returns undefined for a truncated file (valid magic, fewer than 32 bytes total)', () => {
    const header = Buffer.alloc(10);
    header.set([0x7f, 0x45, 0x4c, 0x46], 0);
    header[4] = 2;

    const tmp = writeTemp('fasm2-studio-elf-truncated', header);
    try {
      assert.strictEqual(readElfEntryPoint(tmp), undefined);
    } finally {
      fs.rmSync(tmp);
    }
  });

  it('returns undefined for a file with valid magic but an unrecognized EI_CLASS', () => {
    const header = Buffer.alloc(32);
    header.set([0x7f, 0x45, 0x4c, 0x46], 0);
    header[4] = 99; // neither ELFCLASS32 (1) nor ELFCLASS64 (2)

    const tmp = writeTemp('fasm2-studio-elf-bad-class', header);
    try {
      assert.strictEqual(readElfEntryPoint(tmp), undefined);
    } finally {
      fs.rmSync(tmp);
    }
  });

  it('returns undefined for an empty file', () => {
    const tmp = writeTemp('fasm2-studio-elf-empty', Buffer.alloc(0));
    try {
      assert.strictEqual(readElfEntryPoint(tmp), undefined);
    } finally {
      fs.rmSync(tmp);
    }
  });
});
