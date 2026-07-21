import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { URI } from 'vscode-uri';
import { getHover } from '../src/features/hover';
import { Workspace } from '../src/workspace';

const dialectAlwaysFasm2 = () => 'fasm2' as const;

function value(h: ReturnType<typeof getHover>): string {
  assert.ok(h, 'expected a hover result');
  const contents = h.contents as { value: string };
  return contents.value;
}

describe('getHover', () => {
  const ws = new Workspace();
  const uri = 'file:///synthetic.asm';

  it('returns undefined for a word that matches nothing', () => {
    assert.strictEqual(getHover(ws, uri, 'fasm2', 'not_a_real_anything'), undefined);
  });

  describe('instructions', () => {
    it('renders a single-form mnemonic as a fenced signature plus summary and ISA', () => {
      const v = value(getHover(ws, uri, 'fasm2', 'mov'));
      assert.match(v, /```fasm\nmov dest, src\n```/);
      assert.match(v, /Copy a value between registers, memory and immediates\./);
      assert.match(v, /\*x86 instruction\*/);
    });

    it('renders every form of an overloaded mnemonic (e.g. movsd: string op vs. SSE2 scalar), not just the first', () => {
      const v = value(getHover(ws, uri, 'fasm2', 'movsd'));
      assert.match(v, /2 forms of `movsd`/);
      assert.match(v, /Move string doubleword\./);
      assert.match(v, /Move scalar double-precision float\./);
      assert.match(v, /\*x86 instruction\*/);
      assert.match(v, /\*sse2 instruction\*/);
    });

    it('is case-insensitive', () => {
      assert.match(value(getHover(ws, uri, 'fasm2', 'MOV')), /```fasm\nmov dest, src\n```/);
    });
  });

  describe('registers', () => {
    it('shows a legacy GP register\'s full width family with the hovered one bolded, plus its ABI role', () => {
      const v = value(getHover(ws, uri, 'fasm2', 'al'));
      assert.match(v, /\*\*al\*\* — 8-bit general-purpose register/);
      assert.match(v, /Accumulator — return value and syscall number/);
      assert.match(v, /\*\*`al`\*\* → `ax` → `eax` → `rax`/);
      assert.match(v, /high byte: `ah`/);
    });

    it('bolds a different member of the family when hovering a different width', () => {
      const v = value(getHover(ws, uri, 'fasm2', 'rax'));
      assert.match(v, /`al` → `ax` → `eax` → \*\*`rax`\*\*/);
    });

    it('gives r8-r15 (no legacy high byte) their own calling-convention role', () => {
      const v = value(getHover(ws, uri, 'fasm2', 'r10'));
      assert.match(v, /syscall specifically, holds the 4th argument/);
      assert.match(v, /`r10b` → `r10w` → `r10d` → \*\*`r10`\*\*/);
      assert.ok(!v.includes('high byte'), 'r8-r15 have no legacy high-byte alias');
    });

    it('describes a non-GP register by its group instead of a family', () => {
      const v = value(getHover(ws, uri, 'fasm2', 'cr0'));
      assert.match(v, /\*\*cr0\*\* — 64-bit control register/);
      assert.match(v, /privileged/);
    });

    it('gives fs/gs their own thread-local-storage note instead of the generic segment description', () => {
      const v = value(getHover(ws, uri, 'fasm2', 'fs'));
      assert.match(v, /thread-local storage/);
    });

    it('uses the generic segment description for cs (no TLS note)', () => {
      const v = value(getHover(ws, uri, 'fasm2', 'cs'));
      assert.match(v, /vestigial in 64-bit long mode/);
    });
  });

  it('renders a size specifier with its tag', () => {
    assert.match(value(getHover(ws, uri, 'fasm2', 'dword')), /\*\*dword\*\* — \*size specifier\*\n\n4-byte/);
  });

  it('renders a directive with its dialect', () => {
    const v = value(getHover(ws, uri, 'fasm2', 'format'));
    assert.match(v, /\*\*format\*\* — \*directive\*/);
  });

  it('documents both meanings of "executable" (format-level ET_EXEC vs. segment PF_X attribute)', () => {
    const v = value(getHover(ws, uri, 'fasm2', 'executable'));
    assert.match(v, /ET_EXEC/);
    assert.match(v, /segment.*pages as executable/s);
  });

  describe('user symbols', () => {
    let tmpDir: string;

    beforeEach(async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fasm2-studio-hover-test-'));
    });

    afterEach(async () => {
      await fs.rm(tmpDir, { recursive: true, force: true });
    });

    async function writeFile(name: string, content: string): Promise<string> {
      const fsPath = path.join(tmpDir, name);
      await fs.writeFile(fsPath, content, 'utf8');
      return URI.file(fsPath).toString();
    }

    it('renders a macro as a fenced signature, with no stray "{" when the body opens on the same line', async () => {
      const src = 'format binary\nmacro push_all reg1, reg2 {\n\tpush reg1\n\tpush reg2\n}\n';
      const mainUri = await writeFile('main.asm', src);
      const local = new Workspace();
      local.updateDocument(mainUri, 1, src, 'fasm2');

      const v = value(getHover(local, mainUri, 'fasm2', 'push_all'));
      assert.match(v, /```fasm\npush_all reg1,reg2\n```/);
      assert.ok(!v.includes('{'), 'the inline macro-body brace must not leak into the rendered signature');
      assert.match(v, /\*Macro\*/);
    });

    it('renders a constant as "name = value" and a label/local label with kind + scope', async () => {
      const src = ['format binary', 'CAP = 65536', 'start:', '.loop:', '\tnop', '\tjmp .loop'].join('\n');
      const mainUri = await writeFile('main.asm', src);
      const local = new Workspace();
      local.updateDocument(mainUri, 1, src, 'fasm2');

      assert.match(value(getHover(local, mainUri, 'fasm2', 'CAP')), /```fasm\nCAP = 65536\n```\n\n\*Constant\*/);
      assert.match(value(getHover(local, mainUri, 'fasm2', 'start')), /\*\*start\*\* — \*Label\*/);
      const loopHover = value(getHover(local, mainUri, 'fasm2', '.loop'));
      assert.match(loopHover, /\*\*\.loop\*\* — \*Local label\*/);
      assert.match(loopHover, /Scoped to `start`/);
    });

    it('shows the defining file for a symbol reached via this file\'s own include chain, with no "not included" warning', async () => {
      const incUri = await writeFile('constants.inc', 'SRC_CAP = 65536\n');
      const mainUri = await writeFile('main.asm', "format binary\ninclude 'constants.inc'\nstart:\n\tnop\n");

      const local = new Workspace();
      await local.indexWorkspace([mainUri, incUri], dialectAlwaysFasm2);

      const v = value(getHover(local, mainUri, 'fasm2', 'SRC_CAP'));
      assert.match(v, /Defined in `constants\.inc`/);
      assert.ok(!v.includes('Not included'), 'this symbol IS reachable via main.asm\'s own include chain');
    });

    it('flags a symbol found elsewhere in the workspace but not reachable via this file\'s includes', async () => {
      const mainUri = await writeFile('main.asm', 'format binary\nstart:\n\tnop\n');
      const orphanUri = await writeFile('orphan.inc', 'ORPHAN_CONST = 1\n');

      const local = new Workspace();
      await local.indexWorkspace([mainUri, orphanUri], dialectAlwaysFasm2);

      const v = value(getHover(local, mainUri, 'fasm2', 'ORPHAN_CONST'));
      assert.match(v, /Defined in `orphan\.inc`/);
      assert.match(v, /\*\*Not included\*\* — defined elsewhere in the workspace/);
    });

    it('omits the "defined in" line when the symbol is defined in the same file being hovered', async () => {
      const mainUri = await writeFile('main.asm', 'format binary\nCAP = 1\n');
      const local = new Workspace();
      local.updateDocument(mainUri, 1, 'format binary\nCAP = 1\n', 'fasm2');

      const v = value(getHover(local, mainUri, 'fasm2', 'CAP'));
      assert.ok(!v.includes('Defined in'), 'no point saying a symbol is "defined in" the very file you are looking at');
    });
  });
});
