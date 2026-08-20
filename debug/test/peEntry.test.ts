import * as assert from 'assert';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readPeEntryPoint } from '../src/peEntry';
import { makeTempDir, removeTempDir } from './tempDir';

/** `shell: true` because the official fasm2 distribution for Windows is a `fasm2.cmd` wrapper
 * script, which spawnSync cannot launch at all (not just "not found") without one — see
 * server/src/features/diagnostics.ts's execCompiler for the same fix, and its own comment on why. */
function isAvailable(command: string): boolean {
  const result = spawnSync(command, ['--version'], { timeout: 5000, shell: true });
  return !result.error;
}

describe('readPeEntryPoint', () => {
  it('reads the real entry point of a fasm2-built PE64 executable', async function () {
    if (!isAvailable('fasm2.cmd') || os.platform() !== 'win32') {
      this.skip();
      return;
    }
    const dir = makeTempDir('fasm2-studio-pe-test-');
    try {
      const asmPath = path.join(dir, 'prog.asm');
      const programPath = path.join(dir, 'prog.exe');
      fs.writeFileSync(
        asmPath,
        ['format PE64 console', 'entry start', '', 'section \'.text\' code readable executable', '', 'start:', '\tnop', ''].join('\n'),
      );
      const build = spawnSync('fasm2.cmd', [asmPath, programPath], { cwd: dir, timeout: 15000, shell: true });
      assert.strictEqual(build.status, 0, `fasm2 build failed: ${build.stdout}${build.stderr}`);

      const entry = readPeEntryPoint(programPath);
      assert.ok(entry !== undefined);
      assert.ok(entry! > 0n);
    } finally {
      await removeTempDir(dir);
    }
  });

  function writeTemp(name: string, content: Buffer): string {
    const tmp = path.join(os.tmpdir(), `${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.writeFileSync(tmp, content);
    return tmp;
  }

  /** Builds a minimal but complete DOS header + "PE\0\0" + COFF header + optional header, with the
   * optional header's AddressOfEntryPoint and ImageBase set as given. `plus` selects PE32+ (8-byte
   * ImageBase, no BaseOfData) over PE32 (4-byte ImageBase, with BaseOfData) — real fasm2 output is
   * always PE32+ for "format PE64" and PE32 for "format PE", so both are worth getting right. */
  function buildPeHeader(entryRva: number, imageBase: bigint, plus: boolean): Buffer {
    const dos = Buffer.alloc(64);
    dos.set([0x4d, 0x5a], 0); // "MZ"
    const peHeaderOffset = 64;
    dos.writeUInt32LE(peHeaderOffset, 0x3c); // e_lfanew

    const optionalSize = plus ? 24 + 8 : 28 + 4; // just enough for this reader, real files are larger
    const coff = Buffer.alloc(20);
    coff.writeUInt16LE(plus ? 0x8664 : 0x14c, 0); // Machine: x86-64 or i386
    coff.writeUInt16LE(optionalSize, 16); // SizeOfOptionalHeader (unused by the reader, filled in anyway)

    const optional = Buffer.alloc(optionalSize);
    optional.writeUInt16LE(plus ? 0x20b : 0x10b, 0); // Magic
    optional.writeUInt32LE(entryRva, 16); // AddressOfEntryPoint
    if (plus) optional.writeBigUInt64LE(imageBase, 24);
    else optional.writeUInt32LE(Number(imageBase), 28);

    return Buffer.concat([dos, Buffer.from('PE\0\0'), coff, optional]);
  }

  it('reads a hand-crafted PE32+ (64-bit) header, adding ImageBase to the entry RVA', () => {
    const tmp = writeTemp('fasm2-studio-pe32plus', buildPeHeader(0x1000, 0x140000000n, true));
    try {
      assert.strictEqual(readPeEntryPoint(tmp), 0x140001000n);
    } finally {
      fs.rmSync(tmp);
    }
  });

  it('reads a hand-crafted PE32 (32-bit) header, adding ImageBase to the entry RVA', () => {
    const tmp = writeTemp('fasm2-studio-pe32', buildPeHeader(0x2000, 0x400000n, false));
    try {
      assert.strictEqual(readPeEntryPoint(tmp), 0x402000n);
    } finally {
      fs.rmSync(tmp);
    }
  });

  it('returns undefined for a file with no "MZ" magic', () => {
    const tmp = writeTemp('fasm2-studio-pe-not-mz', Buffer.alloc(64));
    try {
      assert.strictEqual(readPeEntryPoint(tmp), undefined);
    } finally {
      fs.rmSync(tmp);
    }
  });

  it('returns undefined when e_lfanew points somewhere with no "PE\\0\\0" signature', () => {
    const dos = Buffer.alloc(64);
    dos.set([0x4d, 0x5a], 0);
    dos.writeUInt32LE(64, 0x3c);
    const tmp = writeTemp('fasm2-studio-pe-bad-sig', Buffer.concat([dos, Buffer.from('NOPE')]));
    try {
      assert.strictEqual(readPeEntryPoint(tmp), undefined);
    } finally {
      fs.rmSync(tmp);
    }
  });

  it('returns undefined for an unrecognized optional-header magic (neither PE32 nor PE32+)', () => {
    const header = buildPeHeader(0x1000, 0x400000n, false);
    // The optional header's Magic field sits right after the DOS header + "PE\0\0" + 20-byte COFF header.
    header.writeUInt16LE(0x9999, 64 + 4 + 20);
    const tmp = writeTemp('fasm2-studio-pe-bad-magic', header);
    try {
      assert.strictEqual(readPeEntryPoint(tmp), undefined);
    } finally {
      fs.rmSync(tmp);
    }
  });

  it('returns undefined for a truncated file (valid MZ/PE signatures, header cut short)', () => {
    const full = buildPeHeader(0x1000, 0x140000000n, true);
    const tmp = writeTemp('fasm2-studio-pe-truncated', full.subarray(0, 70));
    try {
      assert.strictEqual(readPeEntryPoint(tmp), undefined);
    } finally {
      fs.rmSync(tmp);
    }
  });

  it('returns undefined for a missing file instead of throwing', () => {
    assert.strictEqual(readPeEntryPoint('C:\\nonexistent\\path\\to\\nothing.exe'), undefined);
  });

  it('returns undefined for an empty file', () => {
    const tmp = writeTemp('fasm2-studio-pe-empty', Buffer.alloc(0));
    try {
      assert.strictEqual(readPeEntryPoint(tmp), undefined);
    } finally {
      fs.rmSync(tmp);
    }
  });
});
