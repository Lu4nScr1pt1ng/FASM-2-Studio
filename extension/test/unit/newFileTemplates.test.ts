// The "FASM: New File" templates, checked by assembling them with the real compiler rather than by
// reading them. A starter program that does not build is worse than no starter program at all: it
// is the first thing a new user sees, and they have no way to tell their setup from our typo.
import * as assert from 'assert';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { TEMPLATES, templatesFor, uniqueFileName } from '../../src/newFileTemplates';
import { makeTempDir, removeTempDir } from '../tempDir';

function fasm2Available(): boolean {
  const result = spawnSync('fasm2', [], { shell: true, timeout: 5000, encoding: 'utf8' });
  return `${result.stdout ?? ''}${result.stderr ?? ''}`.toLowerCase().includes('flat assembler');
}

/** The official Windows fasm2 is a .cmd wrapper, which only spawns through a shell; everywhere
 * else the arguments go straight to the binary, unescaped and unsurprising. */
function assemble(src: string, out: string): { status: number | null; output: string } {
  const result = spawnSync('fasm2', [src, out], { shell: process.platform === 'win32', timeout: 15000, encoding: 'utf8' });
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

describe('new-file templates', () => {
  it('offers the running platform first, without hiding the others', () => {
    assert.strictEqual(templatesFor('win32')[0].platform, 'win32');
    assert.strictEqual(templatesFor('linux')[0].platform, 'linux');
    assert.strictEqual(templatesFor('linux').length, TEMPLATES.length);
    // On a platform no template targets (macOS), nothing is lost and nothing is promoted wrongly.
    assert.strictEqual(templatesFor('darwin').length, TEMPLATES.length);
    assert.strictEqual(templatesFor('darwin')[0].platform, undefined);
  });

  // A picker that leads with a Windows binary on Linux is one whose first entry cannot be run by
  // the button the template's own header comment tells you to press.
  it('groups every template for this platform ahead of every template for another one', () => {
    for (const platform of ['linux', 'win32'] as const) {
      const ranks = templatesFor(platform).map((t) => (t.platform === platform ? 0 : t.platform === undefined ? 1 : 2));
      assert.deepStrictEqual([...ranks].sort((a, b) => a - b), ranks, `out of order for ${platform}: ${ranks}`);
    }
  });

  // The OS-independent ones are the reason `platform` is optional; a template that simply forgot to
  // declare one would be silently promoted above a foreign-platform template on every host.
  it('leaves platform unset only where no operating system loads the output', () => {
    for (const template of TEMPLATES.filter((t) => t.platform === undefined)) {
      assert.ok(
        /format\s+binary/i.test(template.content),
        `"${template.label}" declares no platform but does not emit a raw binary`,
      );
    }
  });

  it('never proposes a name that is already taken', () => {
    assert.strictEqual(uniqueFileName(new Set(), 'hello.asm'), 'hello.asm');
    assert.strictEqual(uniqueFileName(new Set(['hello.asm']), 'hello.asm'), 'hello2.asm');
    assert.strictEqual(uniqueFileName(new Set(['hello.asm', 'hello2.asm']), 'hello.asm'), 'hello3.asm');
  });

  describe('assembled by the real compiler', () => {
    // Cross-assembly is a normal thing for fasm: the PE64 template builds on Linux and the ELF64
    // one builds on Windows, so both are checked wherever this runs.
    for (const template of TEMPLATES) {
      it(`"${template.label}" assembles`, async function () {
        if (!fasm2Available()) {
          this.skip();
          return;
        }
        this.timeout(20000);

        const dir = makeTempDir('fasm2-studio-template-test-');
        try {
          const src = path.join(dir, template.fileName);
          const out = path.join(dir, 'out.bin');
          fs.writeFileSync(src, template.content, 'utf8');

          const { status, output } = assemble(src, out);
          assert.strictEqual(status, 0, `fasm2 rejected the template:\n${output}`);
          assert.ok(fs.existsSync(out), `no binary was produced:\n${output}`);
        } finally {
          await removeTempDir(dir);
        }
      });
    }

    // The one template with a hard, externally-imposed shape: a BIOS will not boot a sector that
    // is not exactly 512 bytes ending in 55 AA, and nothing about a wrong one looks wrong until it
    // silently fails to boot. The padding expression is what holds this, so it is worth pinning.
    it('the boot sector is exactly 512 bytes and ends in the boot signature', async function () {
      if (!fasm2Available()) {
        this.skip();
        return;
      }
      this.timeout(20000);

      const template = TEMPLATES.find((t) => t.label.startsWith('Boot sector'))!;
      const dir = makeTempDir('fasm2-studio-template-boot-');
      try {
        const src = path.join(dir, template.fileName);
        const out = path.join(dir, 'boot.bin');
        fs.writeFileSync(src, template.content, 'utf8');
        const { status, output } = assemble(src, out);
        assert.strictEqual(status, 0, output);

        const image = fs.readFileSync(out);
        assert.strictEqual(image.length, 512, 'a boot sector must be exactly one 512-byte sector');
        assert.strictEqual(image[510], 0x55, 'byte 510 is not 0x55');
        assert.strictEqual(image[511], 0xaa, 'byte 511 is not 0xAA');
      } finally {
        await removeTempDir(dir);
      }
    });

    it('the Linux template actually prints its greeting when run', async function () {
      if (process.platform !== 'linux' || !fasm2Available()) {
        this.skip();
        return;
      }
      this.timeout(20000);

      const template = TEMPLATES.find((t) => t.platform === 'linux')!;
      const dir = makeTempDir('fasm2-studio-template-run-');
      try {
        const src = path.join(dir, template.fileName);
        const out = path.join(dir, 'hello');
        fs.writeFileSync(src, template.content, 'utf8');
        const built = assemble(src, out);
        assert.strictEqual(built.status, 0, built.output);

        // fasm never marks its output executable, the same reason runCommand.ts chmods before it runs.
        fs.chmodSync(out, 0o755);
        const run = spawnSync(out, { timeout: 10000, encoding: 'utf8' });
        assert.strictEqual(run.status, 0, `the template exited with ${run.status}: ${run.stderr}`);
        assert.strictEqual(run.stdout, 'Hello, world!\n');
      } finally {
        await removeTempDir(dir);
      }
    });
  });
});
