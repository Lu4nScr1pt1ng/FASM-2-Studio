// The "FASM: New File" templates, checked by assembling them with the real compiler rather than by
// reading them. A starter program that does not build is worse than no starter program at all: it
// is the first thing a new user sees, and they have no way to tell their setup from our typo.
import * as assert from 'assert';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TEMPLATES, templatesFor, uniqueFileName } from '../../src/newFileTemplates';

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
  it('offers the running platform first, without hiding the other', () => {
    assert.strictEqual(templatesFor('win32')[0].platform, 'win32');
    assert.strictEqual(templatesFor('linux')[0].platform, 'linux');
    assert.strictEqual(templatesFor('linux').length, TEMPLATES.length);
    // On a platform neither template targets (macOS), the order is arbitrary but nothing is lost.
    assert.strictEqual(templatesFor('darwin').length, TEMPLATES.length);
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
      it(`"${template.label}" assembles`, function () {
        if (!fasm2Available()) {
          this.skip();
          return;
        }
        this.timeout(20000);

        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fasm2-studio-template-test-'));
        try {
          const src = path.join(dir, template.fileName);
          const out = path.join(dir, 'out.bin');
          fs.writeFileSync(src, template.content, 'utf8');

          const { status, output } = assemble(src, out);
          assert.strictEqual(status, 0, `fasm2 rejected the template:\n${output}`);
          assert.ok(fs.existsSync(out), `no binary was produced:\n${output}`);
        } finally {
          fs.rmSync(dir, { recursive: true, force: true });
        }
      });
    }

    it('the Linux template actually prints its greeting when run', function () {
      if (process.platform !== 'linux' || !fasm2Available()) {
        this.skip();
        return;
      }
      this.timeout(20000);

      const template = TEMPLATES.find((t) => t.platform === 'linux')!;
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fasm2-studio-template-run-'));
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
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
