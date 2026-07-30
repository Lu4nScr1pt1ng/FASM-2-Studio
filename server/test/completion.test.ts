import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { CompletionItemKind } from 'vscode-languageserver/node';
import { URI } from 'vscode-uri';
import { getCompletions } from '../src/features/completion';
import { Workspace } from '../src/workspace';

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
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fasm2-studio-completion-test-'));
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
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
