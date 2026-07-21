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

    it('recognizes vaddpd and loadall, both found missing against the real fasmg source tree', () => {
      assert.match(value(getHover(ws, uri, 'fasm2', 'vaddpd')), /AVX: add packed double-precision floats/);
      assert.match(value(getHover(ws, uri, 'fasm2', 'loadall')), /loads the entire visible and hidden CPU state/);
    });

    it('completes the lods/cmps/scas string-instruction families to match the existing movs/stos byte-width variants', () => {
      assert.match(value(getHover(ws, uri, 'fasm2', 'lodsb')), /Load string byte\./);
      assert.match(value(getHover(ws, uri, 'fasm2', 'lodsq')), /Load string quadword\./);
      assert.match(value(getHover(ws, uri, 'fasm2', 'cmpsw')), /Compare string word operands\./);
      assert.match(value(getHover(ws, uri, 'fasm2', 'scasd')), /Scan string doubleword\./);
    });

    it('completes the setcc/cmovcc condition-code families to match the existing jcc set', () => {
      assert.match(value(getHover(ws, uri, 'fasm2', 'setge')), /Set byte if greater or equal/);
      assert.match(value(getHover(ws, uri, 'fasm2', 'setnp')), /Set byte if not parity/);
      assert.match(value(getHover(ws, uri, 'fasm2', 'cmova')), /Conditional move if above/);
      assert.match(value(getHover(ws, uri, 'fasm2', 'cmovns')), /Conditional move if not sign/);
    });

    it('renders both forms of cmpsd (string compare vs. SSE2 scalar compare), the same conflict movsd already has', () => {
      const v = value(getHover(ws, uri, 'fasm2', 'cmpsd'));
      assert.match(v, /2 forms of `cmpsd`/);
      assert.match(v, /Compare string doubleword operands\./);
      assert.match(v, /Compare scalar double-precision floats against an immediate predicate\./);
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

  it('tags a CALM sub-command distinctly from an ordinary directive', () => {
    assert.match(value(getHover(ws, uri, 'fasm2', 'match')), /\*\*match\*\* — \*CALM command\*/);
  });

  it('recognizes the CALM flow-control commands (jump/jyes/exit), found missing against the real fasmg source tree', () => {
    assert.match(value(getHover(ws, uri, 'fasm2', 'jump')), /\*\*jump\*\* — \*CALM command\*/);
    assert.match(value(getHover(ws, uri, 'fasm2', 'jyes')), /\*\*jyes\*\* — \*CALM command\*/);
    assert.match(value(getHover(ws, uri, 'fasm2', 'exit')), /\*\*exit\*\* — \*CALM command\*/);
  });

  it('prefers the real x86 "jno" instruction over the identically-named CALM command (the far more common meaning outside a calminstruction block)', () => {
    assert.match(value(getHover(ws, uri, 'fasm2', 'jno')), /Jump if not overflow/);
  });

  it('documents "load"/"store" as both a directive and a CALM command, since they mean genuinely different things in each context', () => {
    const load = value(getHover(ws, uri, 'fasm2', 'load'));
    assert.match(load, /reading a string of already-generated bytes/); // the plain directive
    assert.match(load, /As a CALM command/); // the distinct three-argument raw-offset variant

    const store = value(getHover(ws, uri, 'fasm2', 'store'));
    assert.match(store, /overwrites already-generated bytes/);
    assert.match(store, /As a CALM command/);
  });

  it('renders a directive\'s completion snippet as a plain-text fenced example, tabstops stripped', () => {
    const v = value(getHover(ws, uri, 'fasm2', 'include'));
    assert.match(v, /```fasm\ninclude 'file\.inc'\n```/);
    assert.ok(!v.includes('${1'), 'tabstop syntax must not leak into the rendered example');
  });

  it('tags a format keyword with its specific category, not one generic label for all of them', () => {
    assert.match(value(getHover(ws, uri, 'fasm2', 'ELF64')), /\*\*ELF64\*\* — \*output format\*/);
    assert.match(value(getHover(ws, uri, 'fasm2', 'console')), /\*\*console\*\* — \*PE subsystem\*/);
    assert.match(value(getHover(ws, uri, 'fasm2', 'readable')), /\*\*readable\*\* — \*segment\/section attribute\*/);
  });

  it('distinguishes a size specifier from an addressing qualifier', () => {
    assert.match(value(getHover(ws, uri, 'fasm2', 'dword')), /\*\*dword\*\* — \*size specifier\*/);
    assert.match(value(getHover(ws, uri, 'fasm2', 'ptr')), /\*\*ptr\*\* — \*addressing qualifier\*/);
  });

  describe('size specifier vs. same-width data directive (easily conflated, genuinely different)', () => {
    it('cross-references dword to dd/rd, and vice versa', () => {
      assert.match(value(getHover(ws, uri, 'fasm2', 'dword')), /Not the same as the `dd`\/`rd` data directives/);
      assert.match(value(getHover(ws, uri, 'fasm2', 'dd')), /Not the same as the `dword` operand-size specifier/);
      assert.match(value(getHover(ws, uri, 'fasm2', 'rd')), /Not the same as the `dword` operand-size specifier/);
    });

    it('points fasm1\'s "df"/"rf" synonyms at fword, the primary size name, not the synonym pword', () => {
      const v = value(getHover(ws, uri, 'fasm1', 'df'));
      assert.match(v, /Not the same as the `fword` operand-size specifier/);
    });

    it('does not add the cross-reference note to an addressing qualifier (no matching data directive exists)', () => {
      const v = value(getHover(ws, uri, 'fasm2', 'ptr'));
      assert.ok(!v.includes('Not the same as'), 'ptr/near/far/short have no corresponding data directive');
    });

    it('does not add the cross-reference note to a directive with no corresponding size specifier', () => {
      const v = value(getHover(ws, uri, 'fasm2', 'format'));
      assert.ok(!v.includes('Not the same as'), '"format" has no same-width data-directive counterpart');
    });
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

    it('explains "?" (weak), "!" (unconditional), "*" (required), ":" (default value), and "&" (rest-of-line) macro modifiers', async () => {
      // Mirrors fasmg's own packages/x86/include/macro/import64.inc ("macro library?
      // definitions&") and proc64.inc ("macro endp?!").
      const src = ['format binary', 'macro library? definitions&', 'end macro', 'macro endp?!', 'end macro', 'macro proc name*,flag:0', 'end macro'].join('\n');
      const mainUri = await writeFile('main.asm', src);
      const local = new Workspace();
      local.updateDocument(mainUri, 1, src, 'fasm2');

      const lib = value(getHover(local, mainUri, 'fasm2', 'library'));
      assert.match(lib, /weak\/overridable/);
      assert.match(lib, /captures the entire rest of the line/);

      const endp = value(getHover(local, mainUri, 'fasm2', 'endp'));
      assert.match(endp, /unconditional/);
      assert.strictEqual(endp.includes('captures the entire rest of the line'), false);

      const proc = value(getHover(local, mainUri, 'fasm2', 'proc'));
      assert.match(proc, /required argument/);
      assert.match(proc, /default value/);
    });

    it('resolves a macro name to the one *nested* macro actually in scope, not an unrelated same-named macro or instruction elsewhere', async () => {
      // Mirrors fasmg's own packages/x86/include/macro/com64.inc: "cominvk" and "comcall" each
      // define their own private "call" macro (no "?", so it would otherwise permanently shadow
      // — or be shadowed by — the real CALL instruction and each other).
      const src = [
        'format binary',
        'macro cominvk Object,proc,args&',
        '\tmacro call dummy',
        '\t\tCall [rax+Object.proc]',
        '\tend macro',
        '\tpurge call',
        'end macro',
        'macro comcall handle,Interface,proc,args&',
        '\tmacro call dummy',
        '\t\tCall [rax+Interface.proc]',
        '\tend macro',
        '\tpurge call',
        'end macro',
        'call somewhere_else',
      ].join('\n');
      const mainUri = await writeFile('main.asm', src);
      const local = new Workspace();
      local.updateDocument(mainUri, 1, src, 'fasm2');

      // Line 2 (0-based) is cominvk's own "macro call dummy".
      assert.match(value(getHover(local, mainUri, 'fasm2', 'call', 2)), /\*Macro\*/);
      // Line 8 (0-based) is comcall's own, distinct "macro call dummy" — not cominvk's.
      const insideComcall = value(getHover(local, mainUri, 'fasm2', 'call', 8));
      assert.match(insideComcall, /\*Macro\*/);
      // Outside either macro, "call" falls back to the real x86 instruction.
      assert.match(value(getHover(local, mainUri, 'fasm2', 'call', 13)), /x86 instruction/);
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

    it('resolves a `local` variable to the one enclosing macro actually in scope, not an unrelated macro that happens to declare the same name', async () => {
      // Mirrors a real bug found in fasmg's own core/examples/8051/8051.inc: dozens of unrelated
      // macros each declare their own private "value"/"offset" via `local` — before scoping this,
      // hovering any of them always resolved to whichever macro happened to come first in the
      // file, regardless of which macro you were actually looking at.
      const src = [
        'format binary',
        'macro AJMP addr',
        '\tlocal value',
        '\tvalue = 1111h',
        'end macro',
        'macro LJMP addr',
        '\tlocal value',
        '\tvalue = 2222h',
        'end macro',
      ].join('\n');
      const mainUri = await writeFile('main.asm', src);
      const local = new Workspace();
      local.updateDocument(mainUri, 1, src, 'fasm2');

      // Line 3 (0-based) is AJMP's own "value = 1111h"; line 7 is LJMP's own "value = 2222h".
      assert.match(value(getHover(local, mainUri, 'fasm2', 'value', 3)), /1111h/);
      assert.match(value(getHover(local, mainUri, 'fasm2', 'value', 7)), /2222h/);
    });

    it('prefers an in-scope `local` variable over an identically-named instruction mnemonic', async () => {
      // Mirrors a real bug found in fasmg's own packages/x86/include/macro/if.inc: `local neg,conj`
      // then later `neg = mode` uses "neg" purely as a value, never as the NEG instruction — but
      // hovering it always showed the NEG instruction's description, since that check ran first
      // and never even looked at whether a local variable of the same name was actually in scope.
      const src = ['format binary', 'macro doif condition', '\tlocal neg,conj', '\tneg = 1', '\tconj = 0', 'end macro'].join('\n');
      const mainUri = await writeFile('main.asm', src);
      const local = new Workspace();
      local.updateDocument(mainUri, 1, src, 'fasm2');

      // Line 3 (0-based) is "neg = 1", inside doif's own macro body.
      const v = value(getHover(local, mainUri, 'fasm2', 'neg', 3));
      assert.match(v, /neg = 1/);
      assert.doesNotMatch(v, /two's-complement negation/i);

      // Outside any macro body (or without position info at all), the instruction still wins —
      // this fix is specifically about the in-scope case, not a blanket symbol-over-instruction
      // priority change.
      assert.match(value(getHover(local, mainUri, 'fasm2', 'neg')), /x86 instruction/);
    });

    it('renders an "equ" constant with equ syntax and a note that it\'s textual substitution, not "="', async () => {
      const src = 'format binary\nBACKGROUND equ 0\n';
      const mainUri = await writeFile('main.asm', src);
      const local = new Workspace();
      local.updateDocument(mainUri, 1, src, 'fasm2');

      const v = value(getHover(local, mainUri, 'fasm2', 'BACKGROUND'));
      assert.match(v, /```fasm\nBACKGROUND equ 0\n```/);
      assert.match(v, /Textual substitution/);
    });

    it('renders ":=", "=:", "reequ", "define", and "redefine" with their own syntax and a note on how each differs from "="', async () => {
      const src = ['format binary', 'A := 1', 'B =: 2', 'C reequ 3', 'define D 4', 'redefine E 5'].join('\n');
      const mainUri = await writeFile('main.asm', src);
      const local = new Workspace();
      local.updateDocument(mainUri, 1, src, 'fasm2');

      const a = value(getHover(local, mainUri, 'fasm2', 'A'));
      assert.match(a, /```fasm\nA := 1\n```/);
      assert.match(a, /exactly once/);

      const b = value(getHover(local, mainUri, 'fasm2', 'B'));
      assert.match(b, /```fasm\nB =: 2\n```/);
      assert.match(b, /Preserves the previous value/);

      const c = value(getHover(local, mainUri, 'fasm2', 'C'));
      assert.match(c, /```fasm\nC reequ 3\n```/);
      assert.match(c, /discards the previous value/);

      const d = value(getHover(local, mainUri, 'fasm2', 'D'));
      assert.match(d, /```fasm\ndefine D 4\n```/);
      assert.match(d, /does not evaluate symbolic variables/);

      const e = value(getHover(local, mainUri, 'fasm2', 'E'));
      assert.match(e, /```fasm\nredefine E 5\n```/);
      assert.match(e, /Like `define`/);
    });

    it('documents the built-in "$"/"$$"/"$@"/"%"/"%%" pseudo-variables', async () => {
      const src = 'format binary\nrepeat 4\n\tdb %\nend repeat\n';
      const mainUri = await writeFile('main.asm', src);
      const local = new Workspace();
      local.updateDocument(mainUri, 1, src, 'fasm2');

      assert.match(value(getHover(local, mainUri, 'fasm2', '$')), /current address/);
      assert.match(value(getHover(local, mainUri, 'fasm2', '$$')), /base address of the current addressing space/);
      assert.match(value(getHover(local, mainUri, 'fasm2', '$@')), /block of uninitialized/);
      assert.match(value(getHover(local, mainUri, 'fasm2', '%')), /current repetition number/);
      assert.match(value(getHover(local, mainUri, 'fasm2', '%%')), /total number of repetitions/);
    });

    it('documents "~"/"&"/"|" as logical-expression operators, distinct from macro-parameter "&" and arithmetic and/or/not', async () => {
      // Mirrors real usage in fasmg's own packages/x86/include/macro/com64.inc: "if ~ defined
      // Interface#.com.interface".
      const src = 'format binary\nif ~ defined X\nend if\n';
      const mainUri = await writeFile('main.asm', src);
      const local = new Workspace();
      local.updateDocument(mainUri, 1, src, 'fasm2');

      const tilde = value(getHover(local, mainUri, 'fasm2', '~'));
      assert.match(tilde, /Logical negation/);
      assert.match(tilde, /not a general bitwise-NOT/);

      const amp = value(getHover(local, mainUri, 'fasm2', '&'));
      assert.match(amp, /Logical conjunction/);
      assert.match(amp, /last parameter/);

      const pipe = value(getHover(local, mainUri, 'fasm2', '|'));
      assert.match(pipe, /Logical alternative/);
    });

    it('does not show the equ note for an ordinary "=" constant', async () => {
      const src = 'format binary\nCAP = 65536\n';
      const mainUri = await writeFile('main.asm', src);
      const local = new Workspace();
      local.updateDocument(mainUri, 1, src, 'fasm2');

      const v = value(getHover(local, mainUri, 'fasm2', 'CAP'));
      assert.ok(!v.includes('Textual substitution'), '"=" is a stored value, not textual substitution');
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

    it('finds a symbol in a sibling fragment neither includes directly, both reachable only via their shared entry point', async () => {
      // Regression test: cc.asm includes both lexer.asm and io.asm, but lexer.asm doesn't include
      // io.asm directly (or vice versa) — hovering a symbol from io.asm while looking at lexer.asm
      // must still resolve as "included", since walking from lexer.asm's own uri alone (instead of
      // from the shared entry point cc.asm) would never reach io.asm.
      const lexerUri = await writeFile('lexer.asm', 'lex_source:\n\tnop\n');
      const ioUri = await writeFile('io.asm', 'IO_BUF_CAP = 4096\n');
      const mainUri = await writeFile('cc.asm', "format ELF64 executable 3\ninclude 'lexer.asm'\ninclude 'io.asm'\n");

      const local = new Workspace();
      await local.indexWorkspace([mainUri, lexerUri, ioUri], dialectAlwaysFasm2);

      const v = value(getHover(local, lexerUri, 'fasm2', 'IO_BUF_CAP'));
      assert.match(v, /Defined in `io\.asm`/);
      assert.ok(!v.includes('Not included'), 'io.asm IS included — just indirectly, via the shared entry point cc.asm');
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
