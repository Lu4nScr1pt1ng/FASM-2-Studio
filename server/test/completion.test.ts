import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as path from 'path';
import { CompletionItemKind } from 'vscode-languageserver/node';
import { URI } from 'vscode-uri';
import { getCompletions } from '../src/features/completion';
import { Workspace } from '../src/workspace';
import { makeTempDir, removeTempDir } from './tempDir';

const dialectAlwaysFasm2 = () => 'fasm2' as const;

describe('getCompletions', () => {
  it('suggests a known instruction mnemonic', () => {
    const ws = new Workspace();
    const uri = 'file:///synthetic.asm';
    ws.updateDocument(uri, 1, 'format binary\n', 'fasm2');

    const labels = getCompletions(ws, uri, 'fasm2').map((i) => i.label);
    assert.ok(labels.includes('mov'));
  });

  it('suggests hover.ts\'s own logical/value operators (defined, eqtype, relativeto, scale, trunc, ...), not just directives/mnemonics', () => {
    // Found a real gap while validating against manual.txt: LOGICAL_OPERATORS/VALUE_OPERATORS in
    // hover.ts fed hover only, never completion, unlike every other keyword family here.
    const ws = new Workspace();
    const uri = 'file:///synthetic.asm';
    ws.updateDocument(uri, 1, 'format binary\n', 'fasm2');

    const labels = getCompletions(ws, uri, 'fasm2').map((i) => i.label);
    for (const word of ['defined', 'definite', 'used', 'eqtype', 'eq', 'relativeto', 'scale', 'metadata', 'elementof', 'trunc']) {
      assert.ok(labels.includes(word), `expected "${word}" among completions`);
    }
    // Bare punctuation ("~"/"&"/"|") isn't something a user types a prefix of, so it's excluded.
    assert.ok(!labels.includes('~'));
  });

  it('still suggests a struct field whose name spells a real directive/register (e.g. "segment"), matching hover\'s own carve-out', () => {
    // Mirrors a real field name in fasmg's own packages/x86/projects/challenger/challenger.asm.
    // Before this fix, completion's blanket "already a keyword" filter silently dropped every
    // struct field colliding with a directive/register/mnemonic name, unlike hover.ts/
    // symbolIndex.ts, which already special-case isStructField to win over that same collision.
    const ws = new Workspace();
    const uri = 'file:///synthetic.asm';
    const src = ['format binary', 'struct Frame', '\tsegment dd ?', 'ends'].join('\n');
    ws.updateDocument(uri, 1, src, 'fasm2');

    // "segment" is already offered as a static directive keyword regardless of this fix, so
    // asserting mere presence in the label list would pass trivially — check specifically for the
    // struct field's own completion item (kind Reference, per SYMBOL_KIND_TO_COMPLETION[Label]).
    const items = getCompletions(ws, uri, 'fasm2').filter((i) => i.label === 'segment');
    assert.ok(
      items.some((i) => i.kind === CompletionItemKind.Reference),
      `expected a struct-field completion for "segment" alongside the directive keyword, got kinds: ${items.map((i) => i.kind)}`,
    );
  });

  it('suggests a symbol in a sibling fragment neither includes directly, both reachable only via their shared entry point', async () => {
    // Regression test for the same underlying bug fixed in workspace.ts's walkIncludeGraph: cc.asm
    // includes both callsite.asm and constants.inc, but callsite.asm doesn't include
    // constants.inc itself — completion while editing callsite.asm must still offer it.
    const tmpDir = makeTempDir('fasm2-studio-completion-test-');
    try {
      const writeFile = async (name: string, content: string): Promise<string> => {
        const fsPath = path.join(tmpDir, name);
        await fs.writeFile(fsPath, content, 'utf8');
        return URI.file(fsPath).toString();
      };

      const constantsUri = await writeFile('constants.inc', 'SRC_CAP = 65536\n');
      const callsiteUri = await writeFile('callsite.asm', 'start:\n\tnop\n');
      const mainUri = await writeFile('cc.asm', "format binary\ninclude 'callsite.asm'\ninclude 'constants.inc'\n");

      const ws = new Workspace();
      await ws.indexWorkspace([mainUri, callsiteUri, constantsUri], dialectAlwaysFasm2);

      const labels = getCompletions(ws, callsiteUri, 'fasm2').map((i) => i.label);
      assert.ok(labels.includes('SRC_CAP'), 'expected SRC_CAP, reachable via the shared entry point cc.asm');
    } finally {
      await removeTempDir(tmpDir);
    }
  });
  // --- foreign instruction sets ---------------------------------------------------------------
  // fasmg has no built-in instruction set: mnemonics come from an included package. When that
  // package is not x86, this extension's hardcoded x86 tables describe a different CPU entirely.
  describe('when the include graph supplies a non-x86 instruction set', () => {
    let tmpDir: string;

    beforeEach(async () => {
      tmpDir = makeTempDir('fasm2-studio-isa-completion-');
    });

    afterEach(async () => {
      await removeTempDir(tmpDir);
    });

    async function foreignIsaProject(): Promise<{ ws: Workspace; uri: string }> {
      // "mov" is deliberately among these: 23 aarch64 mnemonics are spelled exactly like x86 ones,
      // and those collisions are precisely the cases that used to resolve to the wrong CPU.
      const shared = ['mov', 'add', 'ret'];
      const own = Array.from({ length: 40 }, (_, i) => `zzq${i}`);
      const pkg = [...shared, ...own].map((m) => `macro ${m} a*, b*\nend macro\n`).join('') +
        'repeat 31, i:0\n    element x#i : 0\nend repeat\n';
      await fs.writeFile(path.join(tmpDir, 'myisa.inc'), pkg, 'utf8');

      const text = "format binary\ninclude 'myisa.inc'\n\tmov x0, x1\n";
      const fsPath = path.join(tmpDir, 'prog.asm');
      await fs.writeFile(fsPath, text, 'utf8');
      const uri = URI.file(fsPath).toString();

      const ws = new Workspace();
      ws.updateDocument(uri, 1, text, 'fasm2');
      return { ws, uri };
    }

    it('does not offer x86 registers, which do not exist on the target CPU', async () => {
      const { ws, uri } = await foreignIsaProject();
      const labels = getCompletions(ws, uri, 'fasm2').map((i) => i.label);

      for (const reg of ['rax', 'eax', 'al', 'xmm0']) {
        assert.ok(!labels.includes(reg), `expected no x86 register "${reg}" in a non-x86 file`);
      }
    });

    it('does not offer the ~1400 x86 mnemonics', async () => {
      const { ws, uri } = await foreignIsaProject();
      const labels = getCompletions(ws, uri, 'fasm2').map((i) => i.label);

      for (const mnemonic of ['cpuid', 'lodsb', 'vaddpd']) {
        assert.ok(!labels.includes(mnemonic), `expected no x86 mnemonic "${mnemonic}" in a non-x86 file`);
      }
    });

    it('offers the package\'s own mnemonics, including ones spelled like x86 instructions', async () => {
      const { ws, uri } = await foreignIsaProject();
      const labels = getCompletions(ws, uri, 'fasm2').map((i) => i.label);

      // These were dropped outright before: a workspace symbol colliding with a static item was
      // skipped by the dedup, so the file's real "mov" appeared nowhere at all.
      for (const mnemonic of ['mov', 'add', 'ret', 'zzq7']) {
        assert.ok(labels.includes(mnemonic), `expected the package's own "${mnemonic}"`);
      }
    });

    it('offers registers generated by the package\'s own `repeat`/`element` block', async () => {
      const { ws, uri } = await foreignIsaProject();
      const labels = getCompletions(ws, uri, 'fasm2').map((i) => i.label);

      assert.ok(labels.includes('x0'));
      assert.ok(labels.includes('x30'));
    });

    it('still offers fasmg directives, which are engine syntax and ISA-independent', async () => {
      const { ws, uri } = await foreignIsaProject();
      const labels = getCompletions(ws, uri, 'fasm2').map((i) => i.label);

      for (const directive of ['macro', 'virtual', 'namespace']) {
        assert.ok(labels.includes(directive), `expected the ISA-independent directive "${directive}"`);
      }
    });

    it('leaves an ordinary x86 file untouched', async () => {
      const ws = new Workspace();
      const uri = 'file:///plain.asm';
      ws.updateDocument(uri, 1, 'format ELF64 executable\n\tmov eax, 1\n', 'fasm2');

      const labels = getCompletions(ws, uri, 'fasm2').map((i) => i.label);
      assert.ok(labels.includes('mov'));
      assert.ok(labels.includes('rax'));
      assert.ok(labels.includes('cpuid'));
    });
  });
});
