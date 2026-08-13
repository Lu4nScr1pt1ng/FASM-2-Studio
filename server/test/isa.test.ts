// fasmg has no instruction set of its own — every mnemonic comes from an `include`d package — so
// the hardcoded x86 tables must not be applied to a file whose include graph supplies a different
// one. These tests cover that classification, using generated packages rather than a checked-in
// copy of fasmg's own tree so the suite stays self-contained (CI has no fasmg installed).

import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as path from 'path';
import { URI } from 'vscode-uri';
import instructionsData from '../src/data/instructions.json';
import { classifyIsa, detectIsa, invalidateIsaCache } from '../src/isa';
import { parseDocument } from '../src/parser/symbolIndex';
import { InstructionEntry, ParsedDocument } from '../src/types';
import { Workspace } from '../src/workspace';
import { makeTempDir, removeTempDir } from './tempDir';

const x86Mnemonics = (instructionsData as InstructionEntry[]).map((i) => i.mnemonic);

function doc(name: string, text: string): ParsedDocument {
  return parseDocument(`file:///${name}`, 1, text, 'fasm2');
}

/** A package body defining `count` macros with names that are deliberately not x86 mnemonics —
 * the shape of any non-x86 instruction-set package (aarch64, Z80, a private in-house ISA). */
function foreignPackage(count: number): string {
  return Array.from({ length: count }, (_, i) => `macro zzq${i} a*, b*\nend macro\n`).join('');
}

/** A package body defining `count` macros named after real x86 mnemonics — the shape of fasmg's
 * own packages/x86 and of fasm2's bundled x86-2.inc, both of which define every instruction as an
 * ordinary macro/calminstruction. */
function x86Package(count: number): string {
  return x86Mnemonics.slice(0, count).map((m) => `calminstruction ${m}? dest*, src*\nend calminstruction\n`).join('');
}

describe('classifyIsa', () => {
  it('classifies a package of non-x86 mnemonics as foreign', () => {
    assert.strictEqual(classifyIsa([doc('a64.inc', foreignPackage(40))]), 'foreign');
  });

  it('classifies a package of x86 mnemonics as x86', () => {
    assert.strictEqual(classifyIsa([doc('x86.inc', x86Package(40))]), 'x86');
  });

  it('classifies a file with no includes and no macros as x86, since a plain fasm2 source relies on a preload the server never sees', () => {
    assert.strictEqual(classifyIsa([doc('plain.asm', 'format ELF64 executable\nentry $\n\tmov eax, 60\n\tsyscall\n')]), 'x86');
  });

  it('does not call a small helper package a foreign instruction set — too few macros to be evidence of anything', () => {
    // fasmg's own packages/utility is exactly this: 24 macros, none of them x86 mnemonics. Reading
    // that as "a foreign ISA" would switch the x86 tables off for ordinary x86 projects that
    // merely include some helpers.
    assert.strictEqual(classifyIsa([doc('utility.inc', foreignPackage(24))]), 'x86');
  });

  it('does not mistake a large helper-macro library for an instruction set', () => {
    // The regression that mattered most: KolibriOS's macros.inc defines 73 macros of which only 5
    // spell x86 mnemonics — from the include graph alone that is indistinguishable from a small
    // ISA package, and it wrongly switched x86 support off across a whole real project. What
    // settles it is that the *file* executes x86 instructions the graph never defines.
    const helpers = ['fps', 'library', 'import', 'export', 'm2m', 'iglobal', 'uglobal', 'mstr', 'mls', 'szc', 'meos_app_start', 'mcall']
      .concat(Array.from({ length: 60 }, (_, i) => `helper${i}`));
    const lib = doc('macros.inc', helpers.map((m) => `macro ${m} a\nend macro\n`).join(''));
    const program = doc('prog.asm', 'format binary\nstart:\n\tmov eax, 1\n\tpush ebx\n\tcall foo\n\tjmp start\n\tmcall 1\n');

    assert.strictEqual(classifyIsa([program, lib], program), 'x86');
  });

  it('still says x86 for a small program that executes only a couple of distinct mnemonics', () => {
    // KolibriOS's hello.asm executes just call/mov/je/jmp; an absolute threshold set any higher
    // than a couple silently reclassified files like it.
    const lib = doc('macros.inc', Array.from({ length: 70 }, (_, i) => `macro helper${i} a\nend macro\n`).join(''));
    const program = doc('hello.asm', 'use32\nstart:\n\tmov eax, 1\n\tje start\n');

    assert.strictEqual(classifyIsa([program, lib], program), 'x86');
  });

  it('keeps calling it foreign when the document executes the package\'s own instructions', () => {
    const pkg = doc('myisa.inc', foreignPackage(40));
    const program = doc('prog.asm', 'format binary\n\tzzq1 r0, r1\n\tzzq2 r2, r3\n\tzzq7 r4, r5\n');

    assert.strictEqual(classifyIsa([program, pkg], program), 'foreign');
  });

  it('classifies a small CISC ISA that heavily overlaps x86 as foreign, not x86', () => {
    // Regression guard for the case that broke an earlier share-based rule. fasmg's own
    // core/examples/8051 defines 49 instructions, 19 of which are spelled exactly as x86 spells
    // them (mov, add, inc, dec, mul, div, nop, call, ret, push, pop, jz, jnz, jc, jb, ...) -- a
    // 0.39 share, against 0.42 for fasm2's real x86 include tree. Those are far too close to
    // separate by share, so classification keys on absolute x86 coverage instead.
    const sharedWithX86 = ['mov', 'add', 'inc', 'dec', 'mul', 'div', 'nop', 'call', 'ret', 'push', 'pop', 'jz', 'jnz', 'jc', 'jb', 'jnb', 'jnc', 'jmp', 'setb'];
    const ownOnly = ['cjne', 'djnz', 'sjmp', 'ajmp', 'ljmp', 'acall', 'lcall', 'movx', 'movc', 'swap', 'anl', 'orl', 'xrl', 'clr', 'cpl', 'rlc', 'rrc', 'subb', 'xch', 'xchd', 'jbc', 'reti', 'da', 'rl', 'rr', 'jnbc', 'push2', 'pop2', 'movb', 'setc'];
    const pkg = [...sharedWithX86, ...ownOnly].map((m) => `macro ${m} a*, b*\nend macro\n`).join('');

    assert.strictEqual(classifyIsa([doc('8051.inc', pkg)]), 'foreign');
  });

  it('still says x86 when an x86 package is reached alongside a pile of non-instruction helper macros', () => {
    // fasm2's own include tree scores 0.42 this way (430 macros, many of them helpers rather than
    // mnemonics), so the threshold has to tolerate substantial dilution before flipping.
    assert.strictEqual(classifyIsa([doc('x86.inc', x86Package(120)), doc('helpers.inc', foreignPackage(120))]), 'x86');
  });

  it('aggregates across every document in the graph, not just the first', () => {
    const half = foreignPackage(40).split('end macro\n');
    const partA = half.slice(0, 20).join('end macro\n') + 'end macro\n';
    const partB = half.slice(20).join('end macro\n');
    assert.strictEqual(classifyIsa([doc('a.inc', partA), doc('b.inc', partB)]), 'foreign');
  });
});

describe('detectIsa (through a real include graph)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = makeTempDir('fasm2-studio-isa-test-');
    invalidateIsaCache();
  });

  afterEach(async () => {
    await removeTempDir(tmpDir);
    invalidateIsaCache();
  });

  async function write(name: string, content: string): Promise<string> {
    const fsPath = path.join(tmpDir, name);
    await fs.writeFile(fsPath, content, 'utf8');
    return URI.file(fsPath).toString();
  }

  it('follows `include` to the instruction-set package and reports foreign', async () => {
    await write('myisa.inc', foreignPackage(40));
    const uri = await write('prog.asm', "format binary\ninclude 'myisa.inc'\n\tzzq3 r1, r2\n");

    const ws = new Workspace();
    ws.updateDocument(uri, 1, "format binary\ninclude 'myisa.inc'\n\tzzq3 r1, r2\n", 'fasm2');

    assert.strictEqual(detectIsa(ws, uri, 'fasm2'), 'foreign');
  });

  it('reports x86 for the same file once it includes an x86 package instead', async () => {
    await write('x86.inc', x86Package(40));
    const text = "format binary\ninclude 'x86.inc'\n\tmov eax, 1\n";
    const uri = await write('prog.asm', text);

    const ws = new Workspace();
    ws.updateDocument(uri, 1, text, 'fasm2');

    assert.strictEqual(detectIsa(ws, uri, 'fasm2'), 'x86');
  });

  it('never reports foreign for fasm1, which is a fixed x86 assembler with no package mechanism', async () => {
    await write('myisa.inc', foreignPackage(40));
    const text = "format binary\ninclude 'myisa.inc'\n";
    const uri = await write('prog.asm', text);

    const ws = new Workspace();
    ws.updateDocument(uri, 1, text, 'fasm1');

    assert.strictEqual(detectIsa(ws, uri, 'fasm1'), 'x86');
  });

  it('sees an instruction set supplied only as a command-line preload', async () => {
    // Real projects do not write their instruction set into the source: fasmg has none built in,
    // so a wrapper script preloads it. fasm2 does this for x86, and third-party ISA ports copy
    // the idiom exactly — fredrik-hjarner/fasm68k launches `fasmg -i"Include 'm68k.inc'"` with
    // INCLUDE pointing at its src/. Without honouring the preload, such a file has no reachable
    // instruction set at all and wrongly falls back to x86.
    await write('m68k.inc', foreignPackage(40));
    const text = 'format binary\n\tmove d0, d1\n'; // note: no include statement anywhere
    const uri = await write('prog.asm', text);

    const ws = new Workspace();
    ws.setIncludeSearchPaths([tmpDir]);
    ws.updateDocument(uri, 1, text, 'fasm2');
    assert.strictEqual(detectIsa(ws, uri, 'fasm2'), 'x86', 'without the preload there is nothing to go on');

    ws.setPreloadInclude('m68k.inc');
    assert.strictEqual(detectIsa(ws, uri, 'fasm2'), 'foreign');
  });

  it('still reports x86 when the preload is an x86 package, as it is for plain fasm2', async () => {
    await write('fasm2.inc', x86Package(120));
    const text = 'format binary\n\tmov eax, 1\n';
    const uri = await write('prog.asm', text);

    const ws = new Workspace();
    ws.setIncludeSearchPaths([tmpDir]);
    ws.setPreloadInclude('fasm2.inc');
    ws.updateDocument(uri, 1, text, 'fasm2');

    assert.strictEqual(detectIsa(ws, uri, 'fasm2'), 'x86');
  });

  it('ignores a preload that cannot be resolved, rather than failing the whole lookup', async () => {
    const text = 'format binary\n\tmov eax, 1\n';
    const uri = await write('prog.asm', text);

    const ws = new Workspace();
    ws.setPreloadInclude('nonexistent-package.inc');
    ws.updateDocument(uri, 1, text, 'fasm2');

    assert.strictEqual(detectIsa(ws, uri, 'fasm2'), 'x86');
  });

  it('re-classifies after an edit adds an include, rather than serving a stale cached answer', async () => {
    await write('myisa.inc', foreignPackage(40));
    const before = 'format binary\n\tnop\n';
    const uri = await write('prog.asm', before);

    const ws = new Workspace();
    ws.updateDocument(uri, 1, before, 'fasm2');
    assert.strictEqual(detectIsa(ws, uri, 'fasm2'), 'x86');

    const after = "format binary\ninclude 'myisa.inc'\n";
    ws.updateDocument(uri, 2, after, 'fasm2');
    assert.strictEqual(detectIsa(ws, uri, 'fasm2'), 'foreign', 'editing in an include must invalidate the cached classification');
  });
});
