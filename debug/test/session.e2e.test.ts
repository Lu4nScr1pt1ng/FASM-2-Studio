// True end-to-end test: spawns the actual built adapter.js as a child process and speaks raw DAP
// wire protocol to it (Content-Length framing over stdio) — exactly what VS Code itself does.
// This is the strongest validation available short of driving real VS Code: it exercises the
// full chain (DAP framing -> session.ts -> GdbDriver -> real gdb -> real compiled fasm2 binary)
// with nothing mocked.
import * as assert from 'assert';
import { ChildProcessWithoutNullStreams, spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DapClient, isAvailable } from './dapClient';
import { makeTempDir, removeTempDir } from './tempDir';

const PROGRAM_SRC = [
  'format ELF64 executable 3',
  'entry start',
  '',
  'segment readable executable',
  '',
  'start:',
  '\tmov eax, 1',
  '\tmov ebx, 2',
  '\tadd eax, ebx',
  '\tnop',
  '\tmov edi, 0',
  '\tmov eax, 60',
  '\tsyscall',
  '',
].join('\n');

/**
 * The Registers scope is a tree, not a flat list — its top-level variablesReference resolves to
 * group headers ("General Purpose", "Pointers", "Flags", "Segment"), each with its own nested
 * variablesReference holding the actual registers. Finds `registerName`'s own formatted value,
 * searching every group (read-only lookups don't care which one it's in).
 */
async function findRegisterValue(client: DapClient, registersRef: number, registerName: string): Promise<string | undefined> {
  const groups = await client.sendRequest<{ variables: Array<{ name: string; variablesReference: number }> }>('variables', {
    variablesReference: registersRef,
  });
  for (const group of groups.variables) {
    const members = await client.sendRequest<{ variables: Array<{ name: string; value: string }> }>('variables', {
      variablesReference: group.variablesReference,
    });
    const match = members.variables.find((v) => v.name === registerName);
    if (match) return match.value;
  }
  return undefined;
}

/** The children of one register's own row — the full-width/binary/byte/sub-register readings the
 * compact row value deliberately leaves out (see session.ts's registerDetailVariables). */
async function findRegisterDetail(client: DapClient, registersRef: number, registerName: string): Promise<Array<{ name: string; value: string }>> {
  const detail = await client.sendRequest<{ variables: Array<{ name: string; value: string }> }>('variables', {
    variablesReference: await findRegisterRef(client, registersRef, registerName),
  });
  return detail.variables;
}

/** One register row's own variablesReference — the container its detail children (and its
 * settable sub-register views) live under. */
async function findRegisterRef(client: DapClient, registersRef: number, registerName: string): Promise<number> {
  const groups = await client.sendRequest<{ variables: Array<{ variablesReference: number }> }>('variables', { variablesReference: registersRef });
  for (const group of groups.variables) {
    const members = await client.sendRequest<{ variables: Array<{ name: string; variablesReference: number }> }>('variables', {
      variablesReference: group.variablesReference,
    });
    const match = members.variables.find((v) => v.name === registerName);
    if (match) return match.variablesReference;
  }
  throw new Error(`no "${registerName}" row in this Registers scope`);
}

/** setVariable targets a *group's* variablesReference (the container), not an individual
 * register's own — the register being set doesn't have to already be a listed row in that
 * specific group (setRegister validates the name against REGISTER_WIDTH_BITS directly, not
 * against whatever this group happens to enumerate), it just has to be a real container kind. */
async function getRegisterGroupRef(client: DapClient, registersRef: number, groupLabel: string): Promise<number> {
  const groups = await client.sendRequest<{ variables: Array<{ name: string; variablesReference: number }> }>('variables', {
    variablesReference: registersRef,
  });
  const group = groups.variables.find((v) => v.name === groupLabel);
  if (!group) throw new Error(`no "${groupLabel}" register group in this Registers scope`);
  return group.variablesReference;
}

describe('FasmDebugSession end-to-end (real adapter.js process, real gdb, real fasm2 binary)', function () {
  let dir: string;
  let asmPath: string;
  let programPath: string;
  let listingPath: string;
  const gdbAvailable = isAvailable('gdb');
  const fasm2Available = isAvailable('fasm2');

  before(function () {
    if (!gdbAvailable || !fasm2Available || os.platform() !== 'linux') {
      this.skip();
      return;
    }
    dir = makeTempDir('fasm2-studio-dap-e2e-');
    asmPath = path.join(dir, 'prog.asm');
    programPath = path.join(dir, 'prog');
    listingPath = path.join(dir, 'prog.lst');
    fs.writeFileSync(asmPath, PROGRAM_SRC, 'utf8');

    const build = spawnSync('fasm2', ['-i', "include 'listing.inc'", asmPath, programPath], { cwd: dir, timeout: 15000 });
    if (build.status !== 0) {
      throw new Error(`fasm2 build failed:\n${build.stdout}\n${build.stderr}`);
    }
    fs.chmodSync(programPath, 0o755);
    assert.ok(fs.existsSync(listingPath), 'expected the -i injected listing.inc to produce a .lst file');
  });

  after(async () => {
    await removeTempDir(dir);
  });

  it('runs a full launch -> breakpoint -> stop -> inspect -> continue -> terminate session over real DAP framing', async function () {
    this.timeout(30000);

    const proc = spawn(process.execPath, [path.join(__dirname, '..', 'dist', 'adapter.js')], { stdio: ['pipe', 'pipe', 'pipe'] });
    const client = new DapClient(proc);
    const stderrChunks: string[] = [];
    proc.stderr.on('data', (c: Buffer) => stderrChunks.push(c.toString('utf8')));

    try {
      await client.sendRequest('initialize', { adapterID: 'fasm2', linesStartAt1: true, columnsStartAt1: true, pathFormat: 'path' });
      await client.waitForEvent('initialized');

      const launchPromise = client.sendRequest('launch', {
        program: programPath,
        asmFile: asmPath,
        listingFile: listingPath,
        cwd: dir,
      });
      await launchPromise;

      const bpResponse = await client.sendRequest<{ breakpoints: Array<{ verified: boolean; line: number }> }>('setBreakpoints', {
        source: { path: asmPath },
        breakpoints: [{ line: 9 }], // "add eax, ebx"
      });
      assert.strictEqual(bpResponse.breakpoints.length, 1);
      assert.strictEqual(bpResponse.breakpoints[0].verified, true, 'expected the breakpoint on a real instruction line to verify');

      await client.sendRequest('configurationDone');

      const stoppedBody = (await client.waitForEvent('stopped', (b) => (b as { reason?: string }).reason === 'breakpoint')) as {
        threadId: number;
      };
      assert.strictEqual(stoppedBody.threadId, 1);

      const stackTrace = await client.sendRequest<{ stackFrames: Array<{ line: number; source: { path: string } }> }>('stackTrace', { threadId: 1 });
      assert.strictEqual(stackTrace.stackFrames[0].line, 9);
      assert.strictEqual(stackTrace.stackFrames[0].source.path, asmPath);

      const scopes = await client.sendRequest<{ scopes: Array<{ name: string; variablesReference: number }> }>('scopes', { frameId: 1 });
      const registersScope = scopes.scopes.find((s) => s.name === 'Registers')!;
      assert.ok(registersScope);

      const rax = await findRegisterValue(client, registersScope.variablesReference, 'rax');
      assert.strictEqual(rax, '0x1', `expected rax to read back as 1 before "add eax,ebx" executes, got: ${rax}`);

      const evalResult = await client.sendRequest<{ result: string }>('evaluate', { expression: '$eax', context: 'watch' });
      assert.strictEqual(evalResult.result, '0x1');

      await client.sendRequest('continue', { threadId: 1 });
      await client.waitForEvent('terminated');

      await client.sendRequest('disconnect');
    } catch (err) {
      throw new Error(`${(err as Error).message}\n--- adapter stderr ---\n${stderrChunks.join('')}`);
    } finally {
      proc.kill();
    }
  });

  it('formats registers as unsigned hex/decimal/binary, not gdb\'s raw signed default', async function () {
    this.timeout(30000);

    // eax/dl chosen specifically because their top bit is set: gdb's own default evaluation of a
    // plain register is *signed*, so 0xffffffff would print as "-1" and 0xab as "-85" — exactly
    // the confusing behavior this feature fixes. sil is a 64-bit-only sub-register (no 32-bit
    // legacy alias) to prove the wider REGISTER_WIDTH_BITS alias table works, not just the curated
    // Registers-scope set.
    const regDir = makeTempDir('fasm2-studio-dap-e2e-regs-');
    const regAsmPath = path.join(regDir, 'regs.asm');
    const regProgramPath = path.join(regDir, 'regs');
    const regListingPath = path.join(regDir, 'regs.lst');
    const REG_PROGRAM_SRC = [
      'format ELF64 executable 3',
      'entry start',
      '',
      'segment readable executable',
      'start:',
      '\tmov eax, 0xFFFFFFFF',
      '\tmov dl, 0xAB',
      '\tmov sil, 0x7F',
      '\tnop',
      '\tmov edi, 0',
      '\tmov eax, 60',
      '\tsyscall',
      '',
    ].join('\n');
    fs.writeFileSync(regAsmPath, REG_PROGRAM_SRC, 'utf8');
    const build = spawnSync('fasm2', ['-i', "include 'listing.inc'", regAsmPath, regProgramPath], { cwd: regDir, timeout: 15000 });
    if (build.status !== 0) throw new Error(`fasm2 build failed:\n${build.stdout}\n${build.stderr}`);
    fs.chmodSync(regProgramPath, 0o755);

    const proc = spawn(process.execPath, [path.join(__dirname, '..', 'dist', 'adapter.js')], { stdio: ['pipe', 'pipe', 'pipe'] });
    const client = new DapClient(proc);
    const stderrChunks: string[] = [];
    proc.stderr.on('data', (c: Buffer) => stderrChunks.push(c.toString('utf8')));

    try {
      await client.sendRequest('initialize', { adapterID: 'fasm2', linesStartAt1: true, columnsStartAt1: true, pathFormat: 'path' });
      await client.waitForEvent('initialized');
      await client.sendRequest('launch', { program: regProgramPath, asmFile: regAsmPath, listingFile: regListingPath, cwd: regDir });

      const bpResponse = await client.sendRequest<{ breakpoints: Array<{ verified: boolean }> }>('setBreakpoints', {
        source: { path: regAsmPath },
        breakpoints: [{ line: 9 }], // "nop"
      });
      assert.strictEqual(bpResponse.breakpoints[0].verified, true);

      await client.sendRequest('configurationDone');
      await client.waitForEvent('stopped', (b) => (b as { reason?: string }).reason === 'breakpoint');

      // Hovering over "eax" gets the detailed block — the one context with room for every reading
      // of the value at once, including the sub-register slices of it that no other view shows.
      const eax = await client.sendRequest<{ result: string }>('evaluate', { expression: 'eax', context: 'hover' });
      assert.strictEqual(
        eax.result,
        [
          'eax  (32-bit register)',
          '0xffffffff  4294967295  signed: -1',
          '0b1111_1111 1111_1111 1111_1111 1111_1111',
          'bytes: ff ff ff ff  (little-endian)',
          'ax = 0xffff   al = 0xff   ah = 0xff',
        ].join('\n'),
      );

      const dl = await client.sendRequest<{ result: string }>('evaluate', { expression: 'dl', context: 'hover' });
      assert.strictEqual(dl.result, ['dl  (8-bit register)', '0xab  171  signed: -85', '0b1010_1011', 'bytes: ab  (little-endian)'].join('\n'));

      const sil = await client.sendRequest<{ result: string }>('evaluate', { expression: 'sil', context: 'hover' });
      assert.strictEqual(sil.result, ['sil  (8-bit register)', '0x7f  127', '0b0111_1111', 'bytes: 7f  (little-endian)'].join('\n'));

      // Watch (and the inline decorations VS Code asks for under the same context) already show the
      // expression beside the result, so the value goes back on its own — unsigned, not gdb's raw
      // signed default, and with the two's-complement reading kept alongside it.
      const dollarEax = await client.sendRequest<{ result: string }>('evaluate', { expression: '$eax', context: 'watch' });
      assert.strictEqual(dollarEax.result, '0xffffffff  4294967295  -1');

      // The Debug Console has no name column of its own, so there the value says what it is.
      const replEax = await client.sendRequest<{ result: string }>('evaluate', { expression: '$eax', context: 'clipboard' });
      assert.strictEqual(replEax.result, 'eax = 0xffffffff  4294967295  -1');

      // A compound expression is untouched — still falls through to the generic gdb evaluator.
      const compound = await client.sendRequest<{ result: string }>('evaluate', { expression: '$eax + 1', context: 'watch' });
      assert.match(compound.result, /^-?\d+$/);

      // The Registers panel row carries the value alone — its name column already says "rax" — and
      // rax reads back zero-extended from the eax write (standard x86-64 semantics).
      const scopes = await client.sendRequest<{ scopes: Array<{ variablesReference: number }> }>('scopes', { frameId: 1 });
      const rax = await findRegisterValue(client, scopes.scopes[0].variablesReference, 'rax');
      assert.strictEqual(rax, '0xffffffff  4294967295');

      // r15 is untouched by this program, and it is the case that motivated the whole format: a
      // register holding nothing now says so in three characters instead of a hundred.
      const r15 = await findRegisterValue(client, scopes.scopes[0].variablesReference, 'r15');
      assert.strictEqual(r15, '0x0');

      // Expanding a register row is where the full-width hex, the binary expansion, the byte
      // breakdown and the sub-register slices went — none of them fetched until asked for.
      const raxDetail = await findRegisterDetail(client, scopes.scopes[0].variablesReference, 'rax');
      const byName = new Map(raxDetail.map((v) => [v.name, v.value]));
      assert.strictEqual(byName.get('hex'), '0x00000000ffffffff');
      assert.strictEqual(byName.get('unsigned'), '4294967295');
      // No "signed" row: rax's top bit is clear here, so the two readings are the same digits and
      // the second row would only repeat the first. It appears when they actually differ — see the
      // "al"/"ah" slices below, which are negative at 8 bits and say so.
      assert.strictEqual(byName.has('signed'), false);
      assert.strictEqual(byName.get('binary'), '0b0000_0000 0000_0000 0000_0000 0000_0000 1111_1111 1111_1111 1111_1111 1111_1111');
      assert.strictEqual(byName.get('bytes'), 'ff ff ff ff 00 00 00 00');
      assert.strictEqual(byName.get('eax'), '0xffffffff  4294967295  -1');
      assert.strictEqual(byName.get('al'), '0xff  255  -1');
      assert.strictEqual(byName.get('ah'), '0xff  255  -1');

      // The Flags group answers the question EFLAGS is actually read for: which jumps would go.
      const flagsRef = await getRegisterGroupRef(client, scopes.scopes[0].variablesReference, 'Flags');
      const flagRows = await client.sendRequest<{ variables: Array<{ name: string; value: string; variablesReference: number }> }>('variables', {
        variablesReference: flagsRef,
      });
      const eflagsRow = flagRows.variables.find((v) => v.name === 'eflags');
      assert.ok(eflagsRow, 'expected the eflags register itself to be a row in the Flags group');
      const conditionsRow = flagRows.variables.find((v) => v.name === 'Conditions')!;
      assert.ok(conditionsRow, 'expected a "Conditions" row in the Flags group');
      const conditions = await client.sendRequest<{ variables: Array<{ name: string; value: string }> }>('variables', {
        variablesReference: conditionsRow.variablesReference,
      });
      const je = conditions.variables.find((c) => c.name === 'je / jz')!;
      const jne = conditions.variables.find((c) => c.name === 'jne / jnz')!;
      assert.ok(je && jne, 'expected both halves of the equality condition to be listed');
      assert.notStrictEqual(je.value, jne.value, 'je and jne can never both be taken');
      assert.ok(['taken', 'not taken'].includes(je.value), je.value);
      // Whichever ones are taken are exactly the ones summarized on the row itself.
      const takenNames = conditions.variables.filter((c) => c.value === 'taken').map((c) => c.name.split(' / ')[0]);
      assert.strictEqual(conditionsRow.value, takenNames.join(', '));

      // Every individual flag bit still reads out by name, now saying set/clear rather than 1/0.
      const zf = flagRows.variables.find((v) => v.name === 'ZF')!;
      assert.match(zf.value, /^[01]  (set|clear)$/);

      await client.sendRequest('continue', { threadId: 1 });
      await client.waitForEvent('terminated');
      await client.sendRequest('disconnect');
    } catch (err) {
      throw new Error(`${(err as Error).message}\n--- adapter stderr ---\n${stderrChunks.join('')}`);
    } finally {
      proc.kill();
      await removeTempDir(regDir);
    }
  });

  it('sets register values from the Registers panel and from a Watch expression', async function () {
    this.timeout(30000);

    const proc = spawn(process.execPath, [path.join(__dirname, '..', 'dist', 'adapter.js')], { stdio: ['pipe', 'pipe', 'pipe'] });
    const client = new DapClient(proc);
    const stderrChunks: string[] = [];
    proc.stderr.on('data', (c: Buffer) => stderrChunks.push(c.toString('utf8')));

    try {
      await client.sendRequest('initialize', { adapterID: 'fasm2', linesStartAt1: true, columnsStartAt1: true, pathFormat: 'path' });
      await client.waitForEvent('initialized');
      await client.sendRequest('launch', { program: programPath, asmFile: asmPath, listingFile: listingPath, cwd: dir });

      await client.sendRequest('setBreakpoints', { source: { path: asmPath }, breakpoints: [{ line: 9 }] }); // "add eax, ebx"
      await client.sendRequest('configurationDone');
      await client.waitForEvent('stopped', (b) => (b as { reason?: string }).reason === 'breakpoint');

      const scopes = await client.sendRequest<{ scopes: Array<{ variablesReference: number }> }>('scopes', { frameId: 1 });
      // eax/ebx are both "General Purpose" registers — setVariable targets that group's own
      // variablesReference, not the Registers scope's top-level one.
      const registersRef = await getRegisterGroupRef(client, scopes.scopes[0].variablesReference, 'General Purpose');

      // setVariable (the Registers panel's in-place editor), plain decimal.
      const viaSetVariable = await client.sendRequest<{ value: string }>('setVariable', {
        variablesReference: registersRef,
        name: 'eax',
        value: '42',
      });
      // The echoed-back value is the *row's* form, identical to what the next variables request
      // would paint — a labelled string here would read as the write having done something else.
      assert.strictEqual(viaSetVariable.value, '0x2a  42');

      // The write is real, not just echoed back: re-reading confirms it via a fresh evaluate.
      const reread = await client.sendRequest<{ result: string }>('evaluate', { expression: 'eax', context: 'watch' });
      assert.strictEqual(reread.result, viaSetVariable.value);

      // setExpression (editing a Watch entry), asm-style "h" hex suffix and a "$"-prefixed name.
      const viaSetExpression = await client.sendRequest<{ value: string }>('setExpression', {
        expression: '$eax',
        value: '2Ah',
      });
      assert.strictEqual(viaSetExpression.value, viaSetVariable.value, 'expected "2Ah" (asm hex) to parse to the same 42 as decimal "42"');

      // A negative decimal wraps to the register's own two's-complement bit pattern.
      const negative = await client.sendRequest<{ value: string }>('setVariable', {
        variablesReference: registersRef,
        name: 'ebx',
        value: '-1',
      });
      assert.strictEqual(negative.value, '0xffffffff  4294967295  -1');

      // An unparseable value is rejected with an error response, not silently ignored.
      await assert.rejects(
        client.sendRequest('setVariable', { variablesReference: registersRef, name: 'eax', value: 'not a number' }),
        /Could not parse/,
      );

      // The real user-reported bug: VS Code's in-place editor pre-fills the *entire* current row
      // value ("0x2a  42"), not a bare number. Editing only the decimal column and submitting the
      // whole string back used to silently do nothing (only the hex column ever took effect) —
      // confirmed here against the real adapter and a real register write. The compact row has no
      // third column to break the tie with, so this specifically exercises the "diff against what
      // the register currently holds" path.
      const currentEax = (await client.sendRequest<{ result: string }>('evaluate', { expression: 'eax', context: 'watch' })).result;
      const editedDecimalOnly = currentEax.replace(/(?<=\s)\d+$/, '100'); // change only the decimal column
      assert.strictEqual(editedDecimalOnly, '0x2a  100');
      const viaDecimalEdit = await client.sendRequest<{ value: string }>('setVariable', {
        variablesReference: registersRef,
        name: 'eax',
        value: editedDecimalOnly,
      });
      assert.strictEqual(viaDecimalEdit.value, '0x64  100');

      // ...and editing only the hex column of the same two-column string still works too.
      const editedHexOnly = viaDecimalEdit.value.replace(/^0x[0-9a-f]+/, '0xff');
      const viaHexEdit = await client.sendRequest<{ value: string }>('setVariable', {
        variablesReference: registersRef,
        name: 'eax',
        value: editedHexOnly,
      });
      assert.strictEqual(viaHexEdit.value, '0xff  255');

      // Re-submitting a row unedited is a no-op rather than a parse failure or a stale write.
      const unchanged = await client.sendRequest<{ value: string }>('setVariable', {
        variablesReference: registersRef,
        name: 'eax',
        value: viaHexEdit.value,
      });
      assert.strictEqual(unchanged.value, '0xff  255');

      // A sub-register row under an expanded register is a real register gdb can write: setting
      // "al" from rax's own children changes only the low byte.
      const scopesAgain = await client.sendRequest<{ scopes: Array<{ variablesReference: number }> }>('scopes', { frameId: 1 });
      const raxRef = await findRegisterRef(client, scopesAgain.scopes[0].variablesReference, 'rax');
      const viaSubRegister = await client.sendRequest<{ value: string }>('setVariable', {
        variablesReference: raxRef,
        name: 'al',
        value: '0x7f',
      });
      assert.strictEqual(viaSubRegister.value, '0x7f  127');
      const eaxAfterAl = (await client.sendRequest<{ result: string }>('evaluate', { expression: 'eax', context: 'watch' })).result;
      assert.strictEqual(eaxAfterAl, '0x7f  127', 'expected writing al to have changed only the low byte of eax');

      // Writing a 32-bit view zeroes the upper half of its 64-bit parent, the way every real
      // "mov eax, ..." does. gdb's own "$eax = 1" does not (it leaves rax at 0xffffffff00000001, a
      // state no instruction could have produced), so the write is redirected to rax — see
      // wideParentOf32BitView.
      await client.sendRequest('setVariable', { variablesReference: registersRef, name: 'rax', value: '0xffffffffffffffff' });
      await client.sendRequest('setVariable', { variablesReference: raxRef, name: 'eax', value: '0x1' });
      assert.strictEqual(
        (await client.sendRequest<{ result: string }>('evaluate', { expression: 'rax', context: 'watch' })).result,
        '0x1',
        'expected writing eax to zero the upper half of rax, as x86-64 does',
      );

      // ...while an 8- or 16-bit write must NOT, since no instruction at those widths does.
      await client.sendRequest('setVariable', { variablesReference: raxRef, name: 'ax', value: '0xbeef' });
      assert.strictEqual(
        (await client.sendRequest<{ result: string }>('evaluate', { expression: 'rax', context: 'watch' })).result,
        '0xbeef  48879',
        'expected writing ax to leave the rest of rax alone',
      );

      // The low byte of r8-r15 is "r12b" in fasm syntax and "r12l" to gdb, which does not reject the
      // name it does not know — it reads "$r12b" as an invented convenience variable, so the write
      // used to report success and change nothing at all. The regression this guards is a *silent*
      // one: the panel would show the value it had asked for while the CPU still held the old one.
      const r12Ref = await findRegisterRef(client, scopesAgain.scopes[0].variablesReference, 'r12');
      await client.sendRequest('setVariable', { variablesReference: registersRef, name: 'r12', value: '0xffffffffffffffff' });
      await client.sendRequest('setVariable', { variablesReference: r12Ref, name: 'r12b', value: '0x2a' });
      assert.strictEqual(
        (await client.sendRequest<{ result: string }>('evaluate', { expression: 'r12', context: 'watch' })).result,
        '0xffffffffffffff2a  -214',
        'expected "r12b" to reach the real register rather than a gdb convenience variable',
      );

      // A mistyped hex literal is refused rather than scavenged for the "0" inside it — setting a
      // register to zero over a typo is worse than saying no.
      await assert.rejects(
        client.sendRequest('setVariable', { variablesReference: registersRef, name: 'eax', value: '0xzz' }),
        /Could not parse/,
      );

      await client.sendRequest('continue', { threadId: 1 });
      await client.waitForEvent('terminated');
      await client.sendRequest('disconnect');
    } catch (err) {
      throw new Error(`${(err as Error).message}\n--- adapter stderr ---\n${stderrChunks.join('')}`);
    } finally {
      proc.kill();
    }
  });

  it('reports which registers each step actually changed, and what they moved by', async function () {
    this.timeout(60000);

    // Each of these instructions moves a different, individually checkable thing: two plain
    // register writes, then a push/pop pair that moves rsp by exactly one machine word in each
    // direction, then a prologue-style reservation. That makes the assertions below statements
    // about x86 rather than about whatever the machine happened to be holding.
    const diffDir = makeTempDir('fasm2-studio-dap-e2e-diff-');
    const diffAsmPath = path.join(diffDir, 'diff.asm');
    const diffProgramPath = path.join(diffDir, 'diff');
    const DIFF_SRC = [
      'format ELF64 executable 3',
      'entry start',
      '',
      'segment readable executable',
      'start:',
      '\tmov rax, 1', // line 6 — the breakpoint
      '\tmov rcx, 2', // 7
      '\tpush rax', // 8
      '\tsub rsp, 0x28', // 9
      '\tmov edi, 0',
      '\tmov eax, 60',
      '\tsyscall',
      '',
    ].join('\n');
    fs.writeFileSync(diffAsmPath, DIFF_SRC, 'utf8');
    const build = spawnSync('fasm2', ['-i', "include 'listing.inc'", diffAsmPath, diffProgramPath], { cwd: diffDir, timeout: 15000 });
    if (build.status !== 0) throw new Error(`fasm2 build failed:\n${build.stdout}\n${build.stderr}`);
    fs.chmodSync(diffProgramPath, 0o755);

    const proc = spawn(process.execPath, [path.join(__dirname, '..', 'dist', 'adapter.js')], { stdio: ['pipe', 'pipe', 'pipe'] });
    const client = new DapClient(proc);
    const stderrChunks: string[] = [];
    proc.stderr.on('data', (c: Buffer) => stderrChunks.push(c.toString('utf8')));

    /** The Registers scope's group headers, by group name — what is readable with everything
     * collapsed, which is the whole point of putting the summary there. */
    const groupHeaders = async (): Promise<Map<string, string>> => {
      const scopes = await client.sendRequest<{ scopes: Array<{ name: string; variablesReference: number }> }>('stackTrace', { threadId: 1 })
        .then(() => client.sendRequest<{ scopes: Array<{ name: string; variablesReference: number }> }>('scopes', { frameId: 1 }));
      const registers = scopes.scopes.find((s) => s.name === 'Registers')!;
      const { variables } = await client.sendRequest<{ variables: Array<{ name: string; value: string }> }>('variables', {
        variablesReference: registers.variablesReference,
      });
      return new Map(variables.map((v) => [v.name, v.value]));
    };

    /** One register's "previous" detail row, or undefined when it did not move. */
    const previousRow = async (register: string): Promise<string | undefined> => {
      const scopes = await client.sendRequest<{ scopes: Array<{ variablesReference: number }> }>('scopes', { frameId: 1 });
      const detail = await findRegisterDetail(client, scopes.scopes[0].variablesReference, register);
      return detail.find((d) => d.name === 'previous')?.value;
    };

    const step = async (): Promise<void> => {
      await client.sendRequest('next', { threadId: 1 });
      await client.waitForEvent('stopped');
    };

    try {
      await client.sendRequest('initialize', { adapterID: 'fasm2', linesStartAt1: true, columnsStartAt1: true, pathFormat: 'path' });
      await client.waitForEvent('initialized');
      await client.sendRequest('launch', { program: diffProgramPath, asmFile: diffAsmPath, listingFile: path.join(diffDir, 'diff.lst'), cwd: diffDir });
      await client.sendRequest('setBreakpoints', { source: { path: diffAsmPath }, breakpoints: [{ line: 6 }] });
      await client.sendRequest('configurationDone');
      await client.waitForEvent('stopped', (b) => (b as { reason?: string }).reason === 'breakpoint');

      // The first stop has nothing to be compared against yet — and says so, rather than declaring
      // every register in the file to have "changed" from an absence of information.
      assert.strictEqual((await groupHeaders()).get('General Purpose'), '');

      await step(); // executes "mov rax, 1"
      assert.strictEqual((await groupHeaders()).get('General Purpose'), 'changed: rax');
      assert.match((await previousRow('rax')) ?? '', /\(\+1 = \+0x1\)$/);

      await step(); // executes "mov rcx, 2"
      const afterRcx = await groupHeaders();
      // Only what the *last* step touched: rax moved a step ago and is no longer news.
      assert.strictEqual(afterRcx.get('General Purpose'), 'changed: rcx');
      // rip moves at every stop, so naming it would make the Pointers summary a constant.
      assert.strictEqual(afterRcx.get('Pointers'), '');
      assert.strictEqual(await previousRow('rax'), undefined, 'rax did not move at this step');

      await step(); // executes "push rax" — one machine word down, and no GP register touched
      const afterPush = await groupHeaders();
      assert.strictEqual(afterPush.get('General Purpose'), '');
      assert.strictEqual(afterPush.get('Pointers'), 'changed: rsp');
      assert.match((await previousRow('rsp')) ?? '', /\(-8 = -0x8\)$/);

      await step(); // executes "sub rsp, 0x28"
      assert.strictEqual((await groupHeaders()).get('Pointers'), 'changed: rsp');
      assert.match((await previousRow('rsp')) ?? '', /\(-40 = -0x28\)$/);

      await client.sendRequest('disconnect');
    } catch (err) {
      throw new Error(`${(err as Error).message}\n--- adapter stderr ---\n${stderrChunks.join('')}`);
    } finally {
      proc.kill();
      await removeTempDir(diffDir);
    }
  });

  it('shows real 32-bit registers (not "<unavailable>") and resolves a data label to its address+value, for a real 32-bit ELF target', async function () {
    // The exact bug report this guards against: registers used to be hardcoded to x86-64 names
    // only, so every single one read back "<unavailable>" against a 32-bit target (there's no
    // "$rax" on an i386 process) — and there was no way at all to ask "what's the address/value
    // of this label" for a plain data variable like "argc" (fasmg emits no symbol table for gdb
    // to resolve that from). Uses the user's own real-world snippet almost verbatim: reading argc
    // off the initial stack and storing it into a "argc dd ?" variable.
    this.timeout(30000);

    const argcDir = makeTempDir('fasm2-studio-dap-e2e-argc32-');
    const argcAsmPath = path.join(argcDir, 'argc32.asm');
    const argcProgramPath = path.join(argcDir, 'argc32');
    const argcListingPath = path.join(argcDir, 'argc32.lst');
    const ARGC32_SRC = [
      'format ELF executable 3', // EM_386 — a genuine 32-bit target, not ELF64
      'entry start',
      '',
      'segment readable executable',
      '',
      'start:',
      '\tmov ecx, [esp]',
      '\tmov [argc], ecx',
      '\tnop',
      '\tmov eax, 1',
      '\tmov ebx, 0',
      '\tint 0x80',
      '',
      'segment readable writeable',
      '',
      'argc dd ?',
      '',
    ].join('\n');
    fs.writeFileSync(argcAsmPath, ARGC32_SRC, 'utf8');
    const build = spawnSync('fasm2', ['-i', "include 'listing.inc'", argcAsmPath, argcProgramPath], { cwd: argcDir, timeout: 15000 });
    if (build.status !== 0) throw new Error(`fasm2 build failed:\n${build.stdout}\n${build.stderr}`);
    fs.chmodSync(argcProgramPath, 0o755);

    const proc = spawn(process.execPath, [path.join(__dirname, '..', 'dist', 'adapter.js')], { stdio: ['pipe', 'pipe', 'pipe'] });
    const client = new DapClient(proc);
    const stderrChunks: string[] = [];
    proc.stderr.on('data', (c: Buffer) => stderrChunks.push(c.toString('utf8')));

    try {
      await client.sendRequest('initialize', { adapterID: 'fasm2', linesStartAt1: true, columnsStartAt1: true, pathFormat: 'path' });
      await client.waitForEvent('initialized');
      await client.sendRequest('launch', { program: argcProgramPath, asmFile: argcAsmPath, listingFile: argcListingPath, cwd: argcDir });

      const bpResponse = await client.sendRequest<{ breakpoints: Array<{ verified: boolean }> }>('setBreakpoints', {
        source: { path: argcAsmPath },
        breakpoints: [{ line: 9 }], // "nop", right after "mov [argc], ecx" has executed
      });
      assert.strictEqual(bpResponse.breakpoints[0].verified, true);

      await client.sendRequest('configurationDone');
      await client.waitForEvent('stopped', (b) => (b as { reason?: string }).reason === 'breakpoint');

      const scopes = await client.sendRequest<{ scopes: Array<{ variablesReference: number }> }>('scopes', { frameId: 1 });
      const registersRef = scopes.scopes[0].variablesReference;

      // The bug: eax used to be entirely absent (only rax/rbx/... were ever queried), so every
      // register on a 32-bit target read back "<unavailable>".
      const eax = await findRegisterValue(client, registersRef, 'eax');
      assert.ok(eax, 'expected "eax" to be a real register on a 32-bit target');
      assert.ok(!eax!.includes('unavailable'), `expected eax to have a real value, got: ${eax}`);
      assert.match(eax!, /^0x[0-9a-f]+(  \d+)?(  -\d+)?/);

      // rax must NOT appear at all for a 32-bit target — it doesn't exist on this architecture.
      const rax = await findRegisterValue(client, registersRef, 'rax');
      assert.strictEqual(rax, undefined, 'expected no "rax" register to be reported for a 32-bit (i386) target');

      // Segment registers are real, gdb-reported values too, not just a curated GP set.
      const cs = await findRegisterValue(client, registersRef, 'cs');
      assert.ok(cs && /^0x[0-9a-f]+/.test(cs), `expected a real "cs" segment register value, got: ${cs}`);

      // Flags decode into individual named bits, not just a raw eflags number.
      const flagsGroupRef = await getRegisterGroupRef(client, registersRef, 'Flags');
      const flagsMembers = await client.sendRequest<{ variables: Array<{ name: string; value: string; type?: string }> }>('variables', {
        variablesReference: flagsGroupRef,
      });
      const ifFlag = flagsMembers.variables.find((v) => v.name === 'IF');
      assert.ok(ifFlag, 'expected an "IF" flag entry in the Flags group');
      assert.strictEqual(ifFlag!.value, '1  set', 'expected the Interrupt Enable flag to read as set in a normal running process');
      assert.ok(ifFlag!.type && ifFlag!.type.length > 10, 'expected a real explanatory description on the flag, not a bare name');

      // The actual feature request: hovering/watching "argc" (a label with no gdb symbol at all)
      // shows both its address and, since "dd" makes its size unambiguous, its current value —
      // clearly labeled as distinct things, not just a bare number that could be either.
      const argcHover = await client.sendRequest<{ result: string }>('evaluate', { expression: 'argc', context: 'hover' });
      assert.match(argcHover.result, /^argc {2}\(label, address 0x[0-9a-f]+\)\nvalue = 0x00000001 {2}1\n0b[01_ ]+$/);

      // A plain code label (no declared size) shows only the address — never a guessed-at value.
      const startHover = await client.sendRequest<{ result: string }>('evaluate', { expression: 'start', context: 'hover' });
      assert.match(startHover.result, /^start {2}\(label, address 0x[0-9a-f]+\)$/);

      await client.sendRequest('continue', { threadId: 1 });
      await client.waitForEvent('terminated');
      await client.sendRequest('disconnect');
    } catch (err) {
      throw new Error(`${(err as Error).message}\n--- adapter stderr ---\n${stderrChunks.join('')}`);
    } finally {
      proc.kill();
      await removeTempDir(argcDir);
    }
  });

  it('shows arrays and strings for data labels, in both detailed (hover) and compact (watch/Data Labels scope) form', async function () {
    this.timeout(30000);

    const dataDir = makeTempDir('fasm2-studio-dap-e2e-data-');
    const dataAsmPath = path.join(dataDir, 'data.asm');
    const dataProgramPath = path.join(dataDir, 'data');
    const dataListingPath = path.join(dataDir, 'data.lst');
    const DATA_SRC = [
      'format ELF executable 3',
      'entry start',
      '',
      'segment readable executable',
      '',
      'start:',
      '\tnop',
      '\tmov eax, 1',
      '\tmov ebx, 0',
      '\tint 0x80',
      '',
      'segment readable writeable',
      '',
      'table dd 10, 20, 30, 40',
      "msg db 'Hi there', 0",
      '',
    ].join('\n');
    fs.writeFileSync(dataAsmPath, DATA_SRC, 'utf8');
    const build = spawnSync('fasm2', ['-i', "include 'listing.inc'", dataAsmPath, dataProgramPath], { cwd: dataDir, timeout: 15000 });
    if (build.status !== 0) throw new Error(`fasm2 build failed:\n${build.stdout}\n${build.stderr}`);
    fs.chmodSync(dataProgramPath, 0o755);

    const proc = spawn(process.execPath, [path.join(__dirname, '..', 'dist', 'adapter.js')], { stdio: ['pipe', 'pipe', 'pipe'] });
    const client = new DapClient(proc);
    const stderrChunks: string[] = [];
    proc.stderr.on('data', (c: Buffer) => stderrChunks.push(c.toString('utf8')));

    try {
      await client.sendRequest('initialize', { adapterID: 'fasm2', linesStartAt1: true, columnsStartAt1: true, pathFormat: 'path' });
      await client.waitForEvent('initialized');
      await client.sendRequest('launch', { program: dataProgramPath, asmFile: dataAsmPath, listingFile: dataListingPath, cwd: dataDir });

      const bpResponse = await client.sendRequest<{ breakpoints: Array<{ verified: boolean }> }>('setBreakpoints', {
        source: { path: dataAsmPath },
        breakpoints: [{ line: 7 }], // "nop" — table/msg are statically initialized, already correct here
      });
      assert.strictEqual(bpResponse.breakpoints[0].verified, true);

      await client.sendRequest('configurationDone');
      await client.waitForEvent('stopped', (b) => (b as { reason?: string }).reason === 'breakpoint');

      // Array: detailed (hover) shows every element with its declared type; compact (watch) is a
      // terser bracketed list — both real reads of the actual initialized data, not guesses.
      const tableHover = await client.sendRequest<{ result: string }>('evaluate', { expression: 'table', context: 'hover' });
      assert.match(tableHover.result, /^table {2}\(label, address 0x[0-9a-f]+\)\n4 × dword: \[0xa, 0x14, 0x1e, 0x28\]$/);
      const tableWatch = await client.sendRequest<{ result: string }>('evaluate', { expression: 'table', context: 'watch' });
      assert.strictEqual(tableWatch.result, '[10, 20, 30, 40]');

      // String: detailed shows the byte count and null-terminated note; compact is just the quoted
      // text, ready to read at a glance without cluttering a Watch/inline-value row.
      const msgHover = await client.sendRequest<{ result: string }>('evaluate', { expression: 'msg', context: 'hover' });
      assert.match(msgHover.result, /^msg {2}\(label, address 0x[0-9a-f]+\)\nstring\[9\] = "Hi there"  \(null-terminated\)$/);
      const msgWatch = await client.sendRequest<{ result: string }>('evaluate', { expression: 'msg', context: 'watch' });
      assert.strictEqual(msgWatch.result, '"Hi there"');

      // The Data Labels scope: lists table/msg (real data) but not "start" (a plain code label —
      // deliberately out of scope for this panel, see session.ts). table is expandable into
      // per-index children; msg (a string) is not.
      const scopes = await client.sendRequest<{ scopes: Array<{ name: string; variablesReference: number }> }>('scopes', { frameId: 1 });
      const labelsScope = scopes.scopes.find((s) => s.name === 'Data Labels');
      assert.ok(labelsScope, 'expected a "Data Labels" scope');
      const labelsVars = await client.sendRequest<{ variables: Array<{ name: string; value: string; variablesReference: number }> }>('variables', {
        variablesReference: labelsScope!.variablesReference,
      });
      assert.strictEqual(labelsVars.variables.find((v) => v.name === 'start'), undefined, 'expected no code label in Data Labels');

      const tableRow = labelsVars.variables.find((v) => v.name === 'table');
      assert.ok(tableRow);
      assert.strictEqual(tableRow!.value, '[10, 20, 30, 40]');
      assert.ok(tableRow!.variablesReference > 0, 'expected "table" to be expandable into its elements');

      const msgRow = labelsVars.variables.find((v) => v.name === 'msg');
      assert.ok(msgRow);
      assert.strictEqual(msgRow!.value, '"Hi there"');
      assert.strictEqual(msgRow!.variablesReference, 0, 'expected a string label to not be expandable');

      const tableElements = await client.sendRequest<{ variables: Array<{ name: string; value: string }> }>('variables', {
        variablesReference: tableRow!.variablesReference,
      });
      assert.deepStrictEqual(
        tableElements.variables.map((v) => v.name),
        ['[0]', '[1]', '[2]', '[3]'],
      );
      assert.strictEqual(tableElements.variables[2].value, '0x1e  30');

      await client.sendRequest('continue', { threadId: 1 });
      await client.waitForEvent('terminated');
      await client.sendRequest('disconnect');
    } catch (err) {
      throw new Error(`${(err as Error).message}\n--- adapter stderr ---\n${stderrChunks.join('')}`);
    } finally {
      proc.kill();
      await removeTempDir(dataDir);
    }
  });

  it('returns a clean empty result for a blank Debug Console/Watch expression, instead of gdb\'s raw "Argument required"', async function () {
    this.timeout(30000);

    // The exact user-reported scenario: pressing Enter on an empty Debug Console line, or an empty
    // Watch entry. Before this guard, the empty string sailed through every resolution step and
    // reached gdb as `-data-evaluate-expression ""`, which rejects with its own raw "Argument
    // required (expression to compute)." — confusing for something that was never a real command.
    const proc = spawn(process.execPath, [path.join(__dirname, '..', 'dist', 'adapter.js')], { stdio: ['pipe', 'pipe', 'pipe'] });
    const client = new DapClient(proc);
    const stderrChunks: string[] = [];
    proc.stderr.on('data', (c: Buffer) => stderrChunks.push(c.toString('utf8')));

    try {
      await client.sendRequest('initialize', { adapterID: 'fasm2', linesStartAt1: true, columnsStartAt1: true, pathFormat: 'path' });
      await client.waitForEvent('initialized');
      await client.sendRequest('launch', { program: programPath, asmFile: asmPath, listingFile: listingPath, cwd: dir });
      await client.sendRequest('setBreakpoints', { source: { path: asmPath }, breakpoints: [{ line: 9 }] }); // "add eax, ebx"
      await client.sendRequest('configurationDone');
      await client.waitForEvent('stopped', (b) => (b as { reason?: string }).reason === 'breakpoint');

      const blankRepl = await client.sendRequest<{ result: string }>('evaluate', { expression: '', context: 'repl' });
      assert.strictEqual(blankRepl.result, '');

      const whitespaceWatch = await client.sendRequest<{ result: string }>('evaluate', { expression: '   ', context: 'watch' });
      assert.strictEqual(whitespaceWatch.result, '');

      await client.sendRequest('continue', { threadId: 1 });
      await client.waitForEvent('terminated');
      await client.sendRequest('disconnect');
    } catch (err) {
      throw new Error(`${(err as Error).message}\n--- adapter stderr ---\n${stderrChunks.join('')}`);
    } finally {
      proc.kill();
    }
  });

  it('runs a raw gdb command typed into the Debug Console, and reports the target as continued when the command resumes it', async function () {
    this.timeout(30000);

    // The other half of the "console isn't a real gdb console" complaint: typing "print 1+1" or
    // "continue" directly into the Debug Console used to just be evaluated as a (failing) value
    // expression. Now anything not resolved as a register/label/constant, in 'repl' context only,
    // is run as a real gdb CLI command via -interpreter-exec console — its console output arrives
    // as an 'output' event exactly like any other gdb console text.
    const proc = spawn(process.execPath, [path.join(__dirname, '..', 'dist', 'adapter.js')], { stdio: ['pipe', 'pipe', 'pipe'] });
    const client = new DapClient(proc);
    const stderrChunks: string[] = [];
    proc.stderr.on('data', (c: Buffer) => stderrChunks.push(c.toString('utf8')));

    try {
      await client.sendRequest('initialize', { adapterID: 'fasm2', linesStartAt1: true, columnsStartAt1: true, pathFormat: 'path' });
      await client.waitForEvent('initialized');
      await client.sendRequest('launch', { program: programPath, asmFile: asmPath, listingFile: listingPath, cwd: dir });
      await client.sendRequest('setBreakpoints', { source: { path: asmPath }, breakpoints: [{ line: 9 }] }); // "add eax, ebx"
      await client.sendRequest('configurationDone');
      await client.waitForEvent('stopped', (b) => (b as { reason?: string }).reason === 'breakpoint');

      const printOutput = client.waitForEvent('output', (b) => /\$1 = 2/.test((b as { output?: string }).output ?? ''));
      const printResult = await client.sendRequest<{ result: string }>('evaluate', { expression: 'print 1+1', context: 'repl' });
      assert.strictEqual(printResult.result, '', 'the value itself arrives as console output text, not as the evaluate response');
      await printOutput;

      // A raw "continue" typed here arrives as an 'evaluate' request, not a 'continue' request —
      // without an explicit ContinuedEvent, VS Code would have no way to know the target resumed
      // and would leave the Variables/Call Stack views showing stale, stopped-at-the-breakpoint data.
      const continuedEvent = client.waitForEvent('continued');
      await client.sendRequest('evaluate', { expression: 'continue', context: 'repl' });
      await continuedEvent;

      await client.waitForEvent('terminated');
      await client.sendRequest('disconnect');
    } catch (err) {
      throw new Error(`${(err as Error).message}\n--- adapter stderr ---\n${stderrChunks.join('')}`);
    } finally {
      proc.kill();
    }
  });

  it('Step Over runs straight through a call inside a macro invocation; Step Into dives into it', async function () {
    this.timeout(30000);

    // The real user-reported scenario: a macro like "write_msg target, msg, msglen" whose body
    // ends in a real "call target" — stepping onto the invocation line and pressing Step used to
    // always dive into the callee (both were "-exec-step-instruction" under the hood, no
    // distinction). This macro is deliberately parameter-free ("call_helper" -> "call helper"): its
    // invocation-line text ("call_helper", one token) and its own macro-body text ("call helper",
    // two tokens) are never equal, so the listing's address<->line correlation unambiguously
    // attributes the generated "call" instruction to the *invocation* line, not the macro body —
    // confirmed for real against fasm2's own listing output before writing this test.
    const stepDir = makeTempDir('fasm2-studio-dap-e2e-step-');
    const stepAsmPath = path.join(stepDir, 'step.asm');
    const stepProgramPath = path.join(stepDir, 'step');
    const stepListingPath = path.join(stepDir, 'step.lst');
    const STEP_SRC = [
      'format ELF64 executable 3', // 1
      'entry start', // 2
      '', // 3
      'macro call_helper', // 4
      '    call helper', // 5
      'end macro', // 6
      '', // 7
      'segment readable executable', // 8
      '', // 9
      'start:', // 10
      '\tmov eax, 1', // 11
      '\tcall_helper', // 12
      '\tmov ebx, 2', // 13
      '\tnop', // 14
      '\tmov edi, 0', // 15
      '\tmov eax, 60', // 16
      '\tsyscall', // 17
      '', // 18
      'helper:', // 19
      '\tmov ecx, 3', // 20
      '\tret', // 21
      '', // 22
    ].join('\n');
    fs.writeFileSync(stepAsmPath, STEP_SRC, 'utf8');
    const build = spawnSync('fasm2', ['-i', "include 'listing.inc'", stepAsmPath, stepProgramPath], { cwd: stepDir, timeout: 15000 });
    if (build.status !== 0) throw new Error(`fasm2 build failed:\n${build.stdout}\n${build.stderr}`);
    fs.chmodSync(stepProgramPath, 0o755);

    async function stopAtCallHelper(): Promise<{ client: DapClient; proc: ChildProcessWithoutNullStreams }> {
      const proc = spawn(process.execPath, [path.join(__dirname, '..', 'dist', 'adapter.js')], { stdio: ['pipe', 'pipe', 'pipe'] });
      const client = new DapClient(proc);
      await client.sendRequest('initialize', { adapterID: 'fasm2', linesStartAt1: true, columnsStartAt1: true, pathFormat: 'path' });
      await client.waitForEvent('initialized');
      await client.sendRequest('launch', { program: stepProgramPath, asmFile: stepAsmPath, listingFile: stepListingPath, cwd: stepDir });
      const bp = await client.sendRequest<{ breakpoints: Array<{ verified: boolean }> }>('setBreakpoints', {
        source: { path: stepAsmPath },
        breakpoints: [{ line: 12 }], // "call_helper"
      });
      assert.strictEqual(bp.breakpoints[0].verified, true);
      await client.sendRequest('configurationDone');
      await client.waitForEvent('stopped', (b) => (b as { reason?: string }).reason === 'breakpoint');
      return { client, proc };
    }

    const over = await stopAtCallHelper();
    try {
      await over.client.sendRequest('next', { threadId: 1 });
      await over.client.waitForEvent('stopped', (b) => (b as { reason?: string }).reason === 'step');
      const stackTrace = await over.client.sendRequest<{ stackFrames: Array<{ line: number }> }>('stackTrace', { threadId: 1 });
      assert.strictEqual(stackTrace.stackFrames[0].line, 13, 'Step Over should land on "mov ebx, 2" (line 13), never inside helper: (line 20)');

      await over.client.sendRequest('continue', { threadId: 1 });
      await over.client.waitForEvent('terminated');
      await over.client.sendRequest('disconnect');
    } finally {
      over.proc.kill();
    }

    const into = await stopAtCallHelper();
    try {
      await into.client.sendRequest('stepIn', { threadId: 1 });
      await into.client.waitForEvent('stopped', (b) => (b as { reason?: string }).reason === 'step');
      const stackTrace = await into.client.sendRequest<{ stackFrames: Array<{ line: number }> }>('stackTrace', { threadId: 1 });
      assert.strictEqual(stackTrace.stackFrames[0].line, 20, 'Step Into should dive into helper: (line 20), same as before this distinction existed');

      await into.client.sendRequest('continue', { threadId: 1 });
      await into.client.waitForEvent('terminated');
      await into.client.sendRequest('disconnect');
    } finally {
      into.proc.kill();
    }
  });

  it('stepping into a call that returns many instructions later sends exactly one "stopped" event, not one per internal instruction', async function () {
    this.timeout(30000);

    // Regression test for onStopped forwarding every intermediate stop of stepToNextLine's own
    // internal single-instruction loop to the client. That loop calls -exec-step-instruction
    // repeatedly until the PC reaches a line the listing maps, and gdb reports each of those as an
    // ordinary "end-stepping-range" stop — real, and onStopped used to treat every one of them as a
    // stop worth telling the client about, on top of the one the loop itself sends once it actually
    // decides the step is over. A straight-line program (every other test here) never surfaces
    // this: the very next instruction is almost always already on a new mapped line, so the loop
    // runs once and there is only ever one stop to report regardless. Reported by a real user whose
    // program stepped into a Win32 API call — dozens of instructions with no line of this project's
    // own to land on until the call actually returns — where the flood of spurious StoppedEvents
    // left the Registers view blank and every debug action disabled.
    //
    // "call multi+1" (not "call multi") is what actually reproduces it: multi's own address is
    // itself a mapped line (the db statement that emits the NOPs), so jumping there directly would
    // land on a mapped line after a single step — same as any ordinary call. Landing one byte in
    // finds nothing the listing knows about for every one of the NOPs that follow, exactly as
    // foreign, unmapped code would.
    const dir2 = makeTempDir('fasm2-studio-dap-e2e-manystep-');
    const asmPath2 = path.join(dir2, 'many.asm');
    const programPath2 = path.join(dir2, 'many');
    const listingPath2 = path.join(dir2, 'many.lst');
    const NOP_COUNT = 40;
    const MANY_SRC = [
      'format ELF64 executable 3', // 1
      'entry start', // 2
      '', // 3
      'segment readable executable', // 4
      '', // 5
      'start:', // 6
      '\tmov eax, 1', // 7
      '\tcall multi+1', // 8
      '\tmov edi, 0', // 9
      '\tmov eax, 60', // 10
      '\tsyscall', // 11
      '', // 12
      'multi:', // 13
      `\tdb ${Array(NOP_COUNT).fill('90h').join(',')}`, // 14
      '\tmov ecx, 3', // 15
      '\tret', // 16
      '', // 17
    ].join('\n');
    fs.writeFileSync(asmPath2, MANY_SRC, 'utf8');
    const build2 = spawnSync('fasm2', ['-i', "include 'listing.inc'", asmPath2, programPath2], { cwd: dir2, timeout: 15000 });
    if (build2.status !== 0) throw new Error(`fasm2 build failed:\n${build2.stdout}\n${build2.stderr}`);
    fs.chmodSync(programPath2, 0o755);

    const proc = spawn(process.execPath, [path.join(__dirname, '..', 'dist', 'adapter.js')], { stdio: ['pipe', 'pipe', 'pipe'] });
    const client = new DapClient(proc);
    try {
      await client.sendRequest('initialize', { adapterID: 'fasm2', linesStartAt1: true, columnsStartAt1: true, pathFormat: 'path' });
      await client.waitForEvent('initialized');
      await client.sendRequest('launch', { program: programPath2, asmFile: asmPath2, listingFile: listingPath2, cwd: dir2 });
      await client.sendRequest('setBreakpoints', { source: { path: asmPath2 }, breakpoints: [{ line: 8 }] }); // "call multi+1"
      await client.sendRequest('configurationDone');
      await client.waitForEvent('stopped', (b) => (b as { reason?: string }).reason === 'breakpoint');

      const stoppedBefore = client.events.filter((e) => e.event === 'stopped').length;
      await client.sendRequest('stepIn', { threadId: 1 });
      await client.waitForEvent('stopped', (b) => (b as { reason?: string }).reason === 'step');
      // Any extra, spurious stops would already have arrived alongside the real one — gdb's stops
      // for one gdb.sendCommand('-exec-step-instruction') are not spread out in time — but give the
      // event loop a moment regardless, so a flood arriving in a second burst isn't missed.
      await new Promise((resolve) => setTimeout(resolve, 300));
      const stoppedAfter = client.events.filter((e) => e.event === 'stopped').length;

      assert.strictEqual(
        stoppedAfter - stoppedBefore,
        1,
        'one stepIn request must produce exactly one "stopped" event, however many instructions it took internally',
      );

      const stackTrace = await client.sendRequest<{ stackFrames: Array<{ line: number }> }>('stackTrace', { threadId: 1 });
      assert.strictEqual(stackTrace.stackFrames[0].line, 15, 'must still land correctly on "mov ecx, 3", past every unmapped NOP');

      await client.sendRequest('continue', { threadId: 1 });
      await client.waitForEvent('terminated');
      await client.sendRequest('disconnect');
    } finally {
      proc.kill();
      await removeTempDir(dir2);
    }
  });

  it('a second "next" fired before the first has finished stepping is dropped, not a race that corrupts where the first one lands', async function () {
    this.timeout(30000);

    // Regression test for FasmDebugSession's `stepping` reentrancy guard: waitForNextStop's
    // `once('stopped', ...)` has no way to correlate a stop back to the specific exec command that
    // caused it, so two overlapping "next" requests could each register their own listener and have
    // the wrong one consume the other's stop. Firing both without awaiting the first (as a very fast
    // double-click, or a client not yet disabling the step control, plausibly could) exercises
    // exactly that window. If the guard works, only the *first* request's step actually runs and the
    // second is a no-op — landing on line 8 ("mov ebx, 2"), one line past the breakpoint, not line 9
    // ("add eax, ebx") as it would if both steps had actually executed.
    const proc = spawn(process.execPath, [path.join(__dirname, '..', 'dist', 'adapter.js')], { stdio: ['pipe', 'pipe', 'pipe'] });
    const client = new DapClient(proc);
    try {
      await client.sendRequest('initialize', { adapterID: 'fasm2', linesStartAt1: true, columnsStartAt1: true, pathFormat: 'path' });
      await client.waitForEvent('initialized');
      await client.sendRequest('launch', { program: programPath, asmFile: asmPath, listingFile: listingPath, cwd: dir });
      await client.sendRequest('setBreakpoints', { source: { path: asmPath }, breakpoints: [{ line: 7 }] }); // "mov eax, 1"
      await client.sendRequest('configurationDone');
      await client.waitForEvent('stopped', (b) => (b as { reason?: string }).reason === 'breakpoint');

      const first = client.sendRequest('next', { threadId: 1 });
      const second = client.sendRequest('next', { threadId: 1 });
      await Promise.all([first, second]); // both DAP requests succeed regardless — sendResponse() fires before the guard check

      await client.waitForEvent('stopped', (b) => (b as { reason?: string }).reason === 'step');
      const stackTrace = await client.sendRequest<{ stackFrames: Array<{ line: number }> }>('stackTrace', { threadId: 1 });
      assert.strictEqual(stackTrace.stackFrames[0].line, 8, 'the overlapping second "next" must be dropped, leaving exactly one real step taken');

      await client.sendRequest('continue', { threadId: 1 });
      await client.waitForEvent('terminated');
      await client.sendRequest('disconnect');
    } finally {
      proc.kill();
    }
  });

  it('supports instruction-granularity stepping and exposes instructionPointerReference, backing VS Code\'s Disassembly View', async function () {
    this.timeout(30000);

    const proc = spawn(process.execPath, [path.join(__dirname, '..', 'dist', 'adapter.js')], { stdio: ['pipe', 'pipe', 'pipe'] });
    const client = new DapClient(proc);
    const stderrChunks: string[] = [];
    proc.stderr.on('data', (c: Buffer) => stderrChunks.push(c.toString('utf8')));

    try {
      const capabilities = await client.sendRequest<{ supportsSteppingGranularity?: boolean; supportsDisassembleRequest?: boolean }>('initialize', {
        adapterID: 'fasm2',
        linesStartAt1: true,
        columnsStartAt1: true,
        pathFormat: 'path',
      });
      assert.strictEqual(capabilities.supportsSteppingGranularity, true);
      assert.strictEqual(capabilities.supportsDisassembleRequest, true);
      await client.waitForEvent('initialized');
      await client.sendRequest('launch', { program: programPath, asmFile: asmPath, listingFile: listingPath, cwd: dir });

      await client.sendRequest('setBreakpoints', { source: { path: asmPath }, breakpoints: [{ line: 7 }] }); // "mov eax, 1"
      await client.sendRequest('configurationDone');
      await client.waitForEvent('stopped', (b) => (b as { reason?: string }).reason === 'breakpoint');

      const beforeTrace = await client.sendRequest<{ stackFrames: Array<{ line: number; instructionPointerReference?: string }> }>('stackTrace', {
        threadId: 1,
      });
      const startPc = beforeTrace.stackFrames[0].instructionPointerReference;
      assert.ok(startPc && /^0x[0-9a-f]+$/i.test(startPc), `expected a hex instructionPointerReference, got: ${startPc}`);
      assert.strictEqual(beforeTrace.stackFrames[0].line, 7);

      // One raw machine-instruction step (Disassembly View's own "Step"), not a statement step —
      // "mov eax, 1" is 5 bytes, so the PC should land exactly 5 bytes later, still one real
      // instruction short of "mov ebx, 2" (the next *source-mapped* line).
      await client.sendRequest('next', { threadId: 1, granularity: 'instruction' });
      await client.waitForEvent('stopped', (b) => (b as { reason?: string }).reason === 'step');

      const afterTrace = await client.sendRequest<{ stackFrames: Array<{ line: number; instructionPointerReference?: string }> }>('stackTrace', {
        threadId: 1,
      });
      const afterPc = afterTrace.stackFrames[0].instructionPointerReference;
      assert.ok(afterPc, 'expected instructionPointerReference to still be set even off the exact PC read at the breakpoint');
      assert.strictEqual(BigInt(afterPc!) - BigInt(startPc!), 5n, '"mov eax, 1" (B8 01 00 00 00) is exactly 5 bytes');

      await client.sendRequest('continue', { threadId: 1 });
      await client.waitForEvent('terminated');
      await client.sendRequest('disconnect');
    } catch (err) {
      throw new Error(`${(err as Error).message}\n--- adapter stderr ---\n${stderrChunks.join('')}`);
    } finally {
      proc.kill();
    }
  });

  it('disassembles byte-accurately in Intel syntax, forward and backward through an unmapped mid-macro address, with placeholder rows before the first instruction', async function () {
    this.timeout(30000);

    // "backward" is the hard direction: x86 instructions are variable-length, so there's no
    // generally-sound way to find a real instruction boundary by walking backward from an
    // arbitrary address. This is the actual test of disassembleAround's anchor-and-forward-decode
    // strategy — proven here by asking for the *same* 3 instructions two different ways (forward
    // from their own known-good start, and backward from the last one, an address with no source
    // mapping of its own) and requiring byte-identical results either way.
    const disDir = makeTempDir('fasm2-studio-dap-e2e-disasm-');
    const disAsmPath = path.join(disDir, 'dis.asm');
    const disProgramPath = path.join(disDir, 'dis');
    const disListingPath = path.join(disDir, 'dis.lst');
    const DIS_SRC = [
      'format ELF64 executable 3', // 1
      'entry start', // 2
      '', // 3
      'macro triple target, a, b', // 4
      '    mov eax, a', // 5
      '    mov ebx, b', // 6
      '    call target', // 7
      'end macro', // 8
      '', // 9
      'segment readable executable', // 10
      '', // 11
      'start:', // 12
      '\tnop', // 13
      '\ttriple helper, 0x11, 0x22', // 14
      '\tmov ecx, 0x33', // 15
      '\tnop', // 16
      '\tmov edi, 0', // 17
      '\tmov eax, 60', // 18
      '\tsyscall', // 19
      '', // 20
      'helper:', // 21
      '\tmov edx, 0x44', // 22
      '\tret', // 23
      '', // 24
    ].join('\n');
    fs.writeFileSync(disAsmPath, DIS_SRC, 'utf8');
    const build = spawnSync('fasm2', ['-i', "include 'listing.inc'", disAsmPath, disProgramPath], { cwd: disDir, timeout: 15000 });
    if (build.status !== 0) throw new Error(`fasm2 build failed:\n${build.stdout}\n${build.stderr}`);
    fs.chmodSync(disProgramPath, 0o755);

    const proc = spawn(process.execPath, [path.join(__dirname, '..', 'dist', 'adapter.js')], { stdio: ['pipe', 'pipe', 'pipe'] });
    const client = new DapClient(proc);
    const stderrChunks: string[] = [];
    proc.stderr.on('data', (c: Buffer) => stderrChunks.push(c.toString('utf8')));

    type Insn = { address: string; instruction: string; instructionBytes?: string; line?: number; presentationHint?: string };

    try {
      await client.sendRequest('initialize', { adapterID: 'fasm2', linesStartAt1: true, columnsStartAt1: true, pathFormat: 'path' });
      await client.waitForEvent('initialized');
      await client.sendRequest('launch', { program: disProgramPath, asmFile: disAsmPath, listingFile: disListingPath, cwd: disDir });

      const bp = await client.sendRequest<{ breakpoints: Array<{ verified: boolean }> }>('setBreakpoints', {
        source: { path: disAsmPath },
        breakpoints: [{ line: 13 }, { line: 14 }], // "nop", then "triple helper, 0x11, 0x22"
      });
      assert.strictEqual(bp.breakpoints.length, 2);
      assert.ok(bp.breakpoints.every((b) => b.verified));

      await client.sendRequest('configurationDone');
      await client.waitForEvent('stopped', (b) => (b as { reason?: string }).reason === 'breakpoint');

      // First stop: the very first instruction of the executable segment. Nothing is mapped
      // before it (the ELF header's own listing entry sits at address 0, but "nop" here is
      // already its own nearest-known-address-at-or-before itself), so asking for instructions
      // *before* it must come back as placeholder rows, never garbage decoded from data bytes.
      const nopTrace = await client.sendRequest<{ stackFrames: Array<{ line: number; instructionPointerReference?: string }> }>('stackTrace', {
        threadId: 1,
      });
      assert.strictEqual(nopTrace.stackFrames[0].line, 13);
      const nopPc = nopTrace.stackFrames[0].instructionPointerReference!;

      const beforeNop = await client.sendRequest<{ instructions: Insn[] }>('disassemble', {
        memoryReference: nopPc,
        instructionOffset: -2,
        instructionCount: 2,
      });
      assert.strictEqual(beforeNop.instructions.length, 2);
      for (const insn of beforeNop.instructions) assert.strictEqual(insn.presentationHint, 'invalid', 'nothing real precedes the segment\'s first instruction');

      // Second stop: the macro invocation. Its first generated instruction ("mov eax, 0x11") is
      // the only one of the three the listing attributes a source line to at all — the other two
      // ("mov ebx, 0x22" and "call helper", both inside the same collapsed macro expansion) have
      // no source mapping of their own, which is exactly the scenario disassembleAround's backward
      // reconstruction has to get right.
      await client.sendRequest('continue', { threadId: 1 });
      await client.waitForEvent('stopped', (b) => (b as { reason?: string }).reason === 'breakpoint');

      const macroTrace = await client.sendRequest<{ stackFrames: Array<{ line: number; instructionPointerReference?: string }> }>('stackTrace', {
        threadId: 1,
      });
      assert.strictEqual(macroTrace.stackFrames[0].line, 14);
      const macroStart = macroTrace.stackFrames[0].instructionPointerReference!;

      const forward = await client.sendRequest<{ instructions: Insn[] }>('disassemble', {
        memoryReference: macroStart,
        instructionOffset: 0,
        instructionCount: 3,
      });
      assert.strictEqual(forward.instructions.length, 3);
      const [movEax, movEbx, call] = forward.instructions;

      assert.match(movEax.instruction, /mov\s+eax,\s*0x?11/i, `expected Intel-syntax "mov eax, 0x11", got: ${movEax.instruction}`);
      assert.strictEqual(movEax.address, macroStart);
      assert.strictEqual(movEax.line, 14, 'the macro invocation\'s first generated instruction carries the invocation\'s own source line');
      assert.ok(movEax.instructionBytes && /^[0-9a-f]{2}(\s[0-9a-f]{2})*$/i.test(movEax.instructionBytes), `expected raw opcode bytes, got: ${movEax.instructionBytes}`);

      assert.match(movEbx.instruction, /mov\s+ebx,\s*0x?22/i, `expected Intel-syntax "mov ebx, 0x22", got: ${movEbx.instruction}`);
      assert.strictEqual(movEbx.line, undefined, 'the 2nd instruction of the collapsed macro expansion has no source line of its own');

      assert.match(call.instruction, /^call\b/i, `expected a call instruction, got: ${call.instruction}`);
      assert.strictEqual(call.line, undefined);

      // The actual proof: asking for the same 3 instructions *backward*, anchored on the call's
      // own (unmapped) address, must reconstruct byte-identical results to the forward decode.
      const backward = await client.sendRequest<{ instructions: Insn[] }>('disassemble', {
        memoryReference: call.address,
        instructionOffset: -2,
        instructionCount: 3,
      });
      assert.deepStrictEqual(
        backward.instructions.map((i) => [i.address, i.instruction]),
        forward.instructions.map((i) => [i.address, i.instruction]),
        'backward reconstruction through an unmapped mid-macro address must byte-align with the forward decode from the real, known-good boundary',
      );

      await client.sendRequest('continue', { threadId: 1 });
      await client.waitForEvent('terminated');
      await client.sendRequest('disconnect');
    } catch (err) {
      throw new Error(`${(err as Error).message}\n--- adapter stderr ---\n${stderrChunks.join('')}`);
    } finally {
      proc.kill();
      await removeTempDir(disDir);
    }
  });

  it('hovering/watching a macro invocation itself (e.g. "write_msg" in "write_msg write_stderr, ...") gets a friendly message, not gdb\'s raw "No symbol table is loaded"', async function () {
    this.timeout(30000);

    // The exact user-reported scenario, reproduced with the real write_msg macro shape: a macro
    // vanishes entirely at compile time (fasmg substitutes its body inline; nothing is ever
    // generated for the macro *name* itself), so gdb has no symbol to resolve when hovering/
    // watching "write_msg" on the invocation line — it used to fall through to gdb's own
    // evaluator and surface its raw "No symbol table is loaded. Use the \"file\" command." error.
    const macroDir = makeTempDir('fasm2-studio-dap-e2e-macroname-');
    const macroAsmPath = path.join(macroDir, 'macroname.asm');
    const macroProgramPath = path.join(macroDir, 'macroname');
    const macroListingPath = path.join(macroDir, 'macroname.lst');
    const MACRO_SRC = [
      'format ELF64 executable 3', // 1
      'entry start', // 2
      '', // 3
      'macro write_msg target, msg, msglen', // 4
      '    mov rsi, msg', // 5
      '    mov rdx, msglen', // 6
      '    call target', // 7
      'end macro', // 8
      '', // 9
      'segment readable executable', // 10
      '', // 11
      'start:', // 12
      '\twrite_msg write_stderr, usage_text, usage_text_len', // 13
      '\tmov edi, 0', // 14
      '\tmov eax, 60', // 15
      '\tsyscall', // 16
      '', // 17
      'write_stderr:', // 18
      '\tret', // 19
      '', // 20
      'segment readable writeable', // 21
      'usage_text db "usage",10', // 22
      'usage_text_len = $ - usage_text', // 23
      '', // 24
    ].join('\n');
    fs.writeFileSync(macroAsmPath, MACRO_SRC, 'utf8');
    const build = spawnSync('fasm2', ['-i', "include 'listing.inc'", macroAsmPath, macroProgramPath], { cwd: macroDir, timeout: 15000 });
    if (build.status !== 0) throw new Error(`fasm2 build failed:\n${build.stdout}\n${build.stderr}`);
    fs.chmodSync(macroProgramPath, 0o755);

    const proc = spawn(process.execPath, [path.join(__dirname, '..', 'dist', 'adapter.js')], { stdio: ['pipe', 'pipe', 'pipe'] });
    const client = new DapClient(proc);
    const stderrChunks: string[] = [];
    proc.stderr.on('data', (c: Buffer) => stderrChunks.push(c.toString('utf8')));

    try {
      await client.sendRequest('initialize', { adapterID: 'fasm2', linesStartAt1: true, columnsStartAt1: true, pathFormat: 'path' });
      await client.waitForEvent('initialized');
      await client.sendRequest('launch', { program: macroProgramPath, asmFile: macroAsmPath, listingFile: macroListingPath, cwd: macroDir });

      const bpResponse = await client.sendRequest<{ breakpoints: Array<{ verified: boolean }> }>('setBreakpoints', {
        source: { path: macroAsmPath },
        breakpoints: [{ line: 13 }], // "write_msg write_stderr, usage_text, usage_text_len"
      });
      assert.strictEqual(bpResponse.breakpoints[0].verified, true);

      await client.sendRequest('configurationDone');
      await client.waitForEvent('stopped', (b) => (b as { reason?: string }).reason === 'breakpoint');

      const hover = await client.sendRequest<{ result: string }>('evaluate', { expression: 'write_msg', context: 'hover' });
      assert.match(hover.result, /no runtime value/i);
      assert.doesNotMatch(hover.result, /no symbol table/i);

      const watch = await client.sendRequest<{ result: string }>('evaluate', { expression: 'write_msg', context: 'watch' });
      assert.strictEqual(watch.result, '(no runtime value) write_msg');

      // The macro's *arguments* are real labels and still resolve normally — this fix is scoped
      // to the macro name itself, not a blanket "give up on this whole line" change.
      const argHover = await client.sendRequest<{ result: string }>('evaluate', { expression: 'write_stderr', context: 'hover' });
      assert.match(argHover.result, /\(label, address 0x/);

      // The other real user-reported regression this fix introduced and then had to un-introduce:
      // an instruction mnemonic (e.g. "js") already has a real hover from the language server's
      // own hover provider, shown *alongside* whatever this debug adapter returns for the same
      // token. A *successful* debug-hover response (the "no runtime value" text above) actually
      // gets displayed and steps on that working language hover; a *failed* one is silently
      // dropped by VS Code, leaving the language hover to stand on its own — so a known mnemonic
      // must keep failing the old way, not succeed with this adapter's own message.
      await assert.rejects(
        client.sendRequest('evaluate', { expression: 'js', context: 'hover' }),
        (err: Error) => !/no runtime value/i.test(err.message),
        'a known instruction mnemonic must not get the "no runtime value" short-circuit',
      );

      await client.sendRequest('continue', { threadId: 1 });
      await client.waitForEvent('terminated');
      await client.sendRequest('disconnect');
    } catch (err) {
      throw new Error(`${(err as Error).message}\n--- adapter stderr ---\n${stderrChunks.join('')}`);
    } finally {
      proc.kill();
      await removeTempDir(macroDir);
    }
  });

  it('stepping the exact instruction that exits the program terminates cleanly, with no spurious "step failed: The program is not being run."', async function () {
    this.timeout(30000);

    // Real user-reported bug: waitForNextStop used to resolve `true` for *any* 'stopped' event,
    // including one caused by the inferior exiting (not just gdb's own process exiting). Stepping
    // the program's last instruction (its own exit syscall) hit exactly that: the loop treated the
    // resulting "can't read $pc, no inferior" failure as "landed on an unmapped address, keep
    // stepping", and sent one more step command to an already-dead process.
    const proc = spawn(process.execPath, [path.join(__dirname, '..', 'dist', 'adapter.js')], { stdio: ['pipe', 'pipe', 'pipe'] });
    const client = new DapClient(proc);
    const stderrChunks: string[] = [];
    proc.stderr.on('data', (c: Buffer) => stderrChunks.push(c.toString('utf8')));

    try {
      await client.sendRequest('initialize', { adapterID: 'fasm2', linesStartAt1: true, columnsStartAt1: true, pathFormat: 'path' });
      await client.waitForEvent('initialized');
      await client.sendRequest('launch', { program: programPath, asmFile: asmPath, listingFile: listingPath, cwd: dir });

      // "syscall" (line 13) is the program's very last instruction — it directly exits the process.
      await client.sendRequest('setBreakpoints', { source: { path: asmPath }, breakpoints: [{ line: 13 }] });
      await client.sendRequest('configurationDone');
      await client.waitForEvent('stopped', (b) => (b as { reason?: string }).reason === 'breakpoint');

      await client.sendRequest('next', { threadId: 1 });
      await client.waitForEvent('terminated');

      // The buggy version of this code path fires its spurious second step *after* 'terminated'
      // has already gone out (it's queued on the next microtask via a still-pending
      // waitForNextStop() promise, a separate async chain from the synchronous 'stopped' listener
      // that sends TerminatedEvent) — so this needs a real grace period, not just an immediate
      // check right after 'terminated', to give that straggler command a chance to actually land.
      await new Promise((resolve) => setTimeout(resolve, 500));

      const stepFailedOutput = client.events.find((e) => e.event === 'output' && /step failed/i.test((e.body as { output?: string }).output ?? ''));
      assert.strictEqual(stepFailedOutput, undefined, `expected no spurious step-failed output, got: ${JSON.stringify(stepFailedOutput)}`);

      await client.sendRequest('disconnect');
    } catch (err) {
      throw new Error(`${(err as Error).message}\n--- adapter stderr ---\n${stderrChunks.join('')}`);
    } finally {
      proc.kill();
    }
  });

  it('resolves a symbolic constant (e.g. "FD_STDERR = 2") to its value without ever asking gdb, instead of surfacing "No symbol table is loaded"', async function () {
    this.timeout(30000);

    // The exact user-reported scenario: a plain "NAME = literal" constant (no runtime address at
    // all — fasmg substitutes it at compile time) hovered while stopped. Before this resolved
    // constants itself, evaluateRequest fell through to gdb's own expression evaluator, which
    // correctly — but unhelpfully — rejects it with "No symbol table is loaded. Use the "file"
    // command." (there's no symbol table for gdb to have loaded; fasmg never emits one).
    const constDir = makeTempDir('fasm2-studio-dap-e2e-const-');
    const constAsmPath = path.join(constDir, 'const.asm');
    const constProgramPath = path.join(constDir, 'const');
    const constListingPath = path.join(constDir, 'const.lst');
    const CONST_SRC = [
      'format ELF executable 3',
      'entry start',
      '',
      'FD_STDERR = 2',
      'FD_STDOUT equ 1',
      '',
      'segment readable executable',
      '',
      'start:',
      '\tmov eax, FD_STDERR',
      '\tmov ebx, FD_STDOUT',
      '\tnop',
      '\tmov eax, 1',
      '\tmov ebx, 0',
      '\tint 0x80',
      '',
    ].join('\n');
    fs.writeFileSync(constAsmPath, CONST_SRC, 'utf8');
    const build = spawnSync('fasm2', ['-i', "include 'listing.inc'", constAsmPath, constProgramPath], { cwd: constDir, timeout: 15000 });
    if (build.status !== 0) throw new Error(`fasm2 build failed:\n${build.stdout}\n${build.stderr}`);
    fs.chmodSync(constProgramPath, 0o755);

    const proc = spawn(process.execPath, [path.join(__dirname, '..', 'dist', 'adapter.js')], { stdio: ['pipe', 'pipe', 'pipe'] });
    const client = new DapClient(proc);
    const stderrChunks: string[] = [];
    proc.stderr.on('data', (c: Buffer) => stderrChunks.push(c.toString('utf8')));

    try {
      await client.sendRequest('initialize', { adapterID: 'fasm2', linesStartAt1: true, columnsStartAt1: true, pathFormat: 'path' });
      await client.waitForEvent('initialized');
      await client.sendRequest('launch', { program: constProgramPath, asmFile: constAsmPath, listingFile: constListingPath, cwd: constDir });

      const bpResponse = await client.sendRequest<{ breakpoints: Array<{ verified: boolean }> }>('setBreakpoints', {
        source: { path: constAsmPath },
        breakpoints: [{ line: 11 }], // "nop"
      });
      assert.strictEqual(bpResponse.breakpoints[0].verified, true);

      await client.sendRequest('configurationDone');
      await client.waitForEvent('stopped', (b) => (b as { reason?: string }).reason === 'breakpoint');

      const hover = await client.sendRequest<{ result: string }>('evaluate', { expression: 'FD_STDERR', context: 'hover' });
      assert.strictEqual(hover.result, 'FD_STDERR  (constant, defined via "=")\nvalue = 0x2  2');

      const watch = await client.sendRequest<{ result: string }>('evaluate', { expression: 'FD_STDOUT', context: 'watch' });
      assert.strictEqual(watch.result, '0x1  1');

      await client.sendRequest('continue', { threadId: 1 });
      await client.waitForEvent('terminated');
      await client.sendRequest('disconnect');
    } catch (err) {
      throw new Error(`${(err as Error).message}\n--- adapter stderr ---\n${stderrChunks.join('')}`);
    } finally {
      proc.kill();
      await removeTempDir(constDir);
    }
  });

  it('shows the SIMD, x87, MXCSR, TLS, stack and segment state a real x86-64 program actually has', async function () {
    this.timeout(30000);

    // Every group added here is exercised by a program that genuinely uses it: SSE loads into
    // xmm0-2 (including a movdqu of a 16-byte string, which is what SSE is *for* in a program like
    // this), two x87 pushes so the FPU stack has a TOP other than zero, a push and a call so the
    // stack has a real return address in it, and a labelled pointer for the label resolution.
    const simdDir = makeTempDir('fasm2-studio-dap-e2e-simd-');
    const simdAsmPath = path.join(simdDir, 'simd.asm');
    const simdProgramPath = path.join(simdDir, 'simd');
    const simdListingPath = path.join(simdDir, 'simd.lst');
    const SIMD_PROGRAM_SRC = [
      'format ELF64 executable 3',
      'entry start',
      '',
      'segment readable executable',
      'start:',
      '\tmovsd xmm0, qword [pi]',
      '\tmovupd xmm1, dqword [pair]',
      '\tmovdqu xmm2, dqword [text]',
      '\tfld qword [pi]',
      '\tfld1',
      '\tlea rsi, [msg]',
      '\tpush rsi',
      '\tcall helper',
      '\tnop',
      '\tmov edi, 0',
      '\tmov eax, 60',
      '\tsyscall',
      '',
      'helper:',
      '\tnop',
      '\tret',
      '',
      'segment readable writeable',
      'pi\tdq 3.14159265358979',
      'pair\tdq 1.5, -2.25',
      "text\tdb 'SIMD/x86-64!!!!!',0",
      "msg\tdb 'hello',0",
      '',
    ].join('\n');
    fs.writeFileSync(simdAsmPath, SIMD_PROGRAM_SRC, 'utf8');
    const build = spawnSync('fasm2', ['-i', "include 'listing.inc'", simdAsmPath, simdProgramPath], { cwd: simdDir, timeout: 15000 });
    if (build.status !== 0) throw new Error(`fasm2 build failed:\n${build.stdout}\n${build.stderr}`);
    fs.chmodSync(simdProgramPath, 0o755);

    const proc = spawn(process.execPath, [path.join(__dirname, '..', 'dist', 'adapter.js')], { stdio: ['pipe', 'pipe', 'pipe'] });
    const client = new DapClient(proc);
    const stderrChunks: string[] = [];
    proc.stderr.on('data', (c: Buffer) => stderrChunks.push(c.toString('utf8')));

    try {
      await client.sendRequest('initialize', { adapterID: 'fasm2', linesStartAt1: true, columnsStartAt1: true, pathFormat: 'path' });
      await client.waitForEvent('initialized');
      await client.sendRequest('launch', { program: simdProgramPath, asmFile: simdAsmPath, listingFile: simdListingPath, cwd: simdDir });
      await client.sendRequest('setBreakpoints', { source: { path: simdAsmPath }, breakpoints: [{ line: 20 }] }); // the nop inside helper
      await client.sendRequest('configurationDone');
      await client.waitForEvent('stopped', (b) => (b as { reason?: string }).reason === 'breakpoint');

      const scopes = await client.sendRequest<{ scopes: Array<{ variablesReference: number }> }>('scopes', { frameId: 1 });
      const registersRef = scopes.scopes[0].variablesReference;
      const groups = await client.sendRequest<{ variables: Array<{ name: string; value: string }> }>('variables', { variablesReference: registersRef });
      const groupNames = groups.variables.map((g) => g.name);

      // The vector group is named for the widest extension the *running* process turned out to
      // have, which is only knowable after it started — the register set gdb reports before the
      // first instruction executes has no ymm registers in it at all.
      const vectorLabel = groupNames.find((n) => n.startsWith('Vector'));
      assert.ok(vectorLabel, `expected a Vector group, got: ${groupNames.join(', ')}`);
      for (const expected of ['General Purpose', 'Pointers', 'Stack', 'Flags', 'MXCSR', 'x87 FPU', 'Thread / Syscall', 'Segment']) {
        assert.ok(groupNames.includes(expected), `expected a "${expected}" group, got: ${groupNames.join(', ')}`);
      }

      // The SIMD registers, at whatever width this CPU reports them — a movdqu of a string reads
      // back as that string, which no numeric base would show.
      const vectorRef = await getRegisterGroupRef(client, registersRef, vectorLabel);
      const vectorRows = await client.sendRequest<{ variables: Array<{ name: string; value: string; variablesReference: number }> }>('variables', {
        variablesReference: vectorRef,
      });
      const textReg = vectorRows.variables.find((v) => /^[xyz]mm2$/.test(v.name))!;
      assert.ok(textReg, 'expected a row for the third SIMD register');
      assert.match(textReg.value, /'SIMD\/x86-64!!!!!'/);

      // Expanding one gives every reading of the same bits, none of which cost another round trip.
      const pairReg = vectorRows.variables.find((v) => /^[xyz]mm1$/.test(v.name))!;
      const lanes = await client.sendRequest<{ variables: Array<{ name: string; value: string }> }>('variables', {
        variablesReference: pairReg.variablesReference,
      });
      // The lane *count* depends on how wide this CPU reports the register, so the assertion is on
      // the lanes the program actually loaded — which sit at the low end whatever the width is.
      const doubleLanes = lanes.variables.find((v) => /^\d+ x double$/.test(v.name))!;
      assert.ok(doubleLanes, `expected a packed-double reading, got: ${lanes.variables.map((v) => v.name).join(', ')}`);
      assert.ok(doubleLanes.value.startsWith('1.5, -2.25'), `unexpected double lanes: ${doubleLanes.value}`);

      // Hovering a SIMD register works even though it is 128 bits wide and no unsigned cast names
      // one — the read goes through its 64-bit lanes instead.
      const xmm1Hover = await client.sendRequest<{ result: string }>('evaluate', { expression: 'xmm1', context: 'hover' });
      assert.match(xmm1Hover.result, /^xmm1 {2}\(128-bit vector register\)/);
      assert.match(xmm1Hover.result, /2 x double\s+1\.5, -2\.25/);

      // MXCSR reads as its named bits, the same way EFLAGS does. 0x1f80 (everything masked,
      // nothing raised) is what a freshly started process has.
      const mxcsrGroup = groups.variables.find((g) => g.name === 'MXCSR')!;
      assert.strictEqual(mxcsrGroup.value, '[ IM DM ZM OM UM PM ]');

      // Two flds means TOP has rotated, which is exactly the thing that silently renames every
      // st(n) and is invisible without decoding the status word.
      const x87Group = groups.variables.find((g) => g.name === 'x87 FPU')!;
      assert.match(x87Group.value, /^st0 = R[0-7]/);
      const x87Ref = await getRegisterGroupRef(client, registersRef, 'x87 FPU');
      const x87Rows = await client.sendRequest<{ variables: Array<{ name: string; value: string; variablesReference: number }> }>('variables', {
        variablesReference: x87Ref,
      });
      const st0 = x87Rows.variables.find((v) => v.name === 'st0')!;
      assert.match(st0.value, /^1\b/, `expected fld1 to leave 1 in st0, got ${st0.value}`);
      assert.match(st0.value, /\(valid\)/);
      // The registers nothing was pushed into say so, rather than reading as whatever bits are
      // left in them — the tag word is the only thing that can tell the difference.
      assert.strictEqual(x87Rows.variables.find((v) => v.name === 'st5')!.value, '<empty>');
      assert.match(x87Rows.variables.find((v) => v.name === 'fctrl')!.value, /PC=3/);

      // The 80-bit format's own fields, which is where the states an ordinary decimal hides live.
      const st0Detail = await client.sendRequest<{ variables: Array<{ name: string; value: string }> }>('variables', {
        variablesReference: st0.variablesReference,
      });
      const st0ByName = new Map(st0Detail.variables.map((v) => [v.name, v.value]));
      assert.strictEqual(st0ByName.get('hex'), '0x3fff8000000000000000');
      assert.strictEqual(st0ByName.get('class'), 'normal');
      assert.strictEqual(st0ByName.get('exponent'), '2^0  (biased 0x3fff)');

      // The stack, which is the only place a return address is visible: there is one frame here and
      // nothing to unwind with, so "what called this" has no other answer.
      const stackRef = await getRegisterGroupRef(client, registersRef, 'Stack');
      const stackRows = await client.sendRequest<{ variables: Array<{ name: string; value: string }> }>('variables', {
        variablesReference: stackRef,
      });
      assert.strictEqual(stackRows.variables[0].name, '[rsp+0x0]');
      assert.match(stackRows.variables[0].value, /→ start\+0x[0-9a-f]+/, 'expected the return address the call pushed to resolve to a label');
      assert.match(stackRows.variables[1].value, /→ msg/, 'expected the pushed rsi to resolve to the label it points at');

      // rip says which instruction is about to run, which is the one reading of it that answers the
      // question it is looked at for.
      const rip = await findRegisterValue(client, registersRef, 'rip');
      assert.match(rip ?? '', /→ helper\s+nop$/);

      // A segment selector decoded rather than shown as a number that means nothing.
      const cs = await findRegisterValue(client, registersRef, 'cs');
      assert.strictEqual(cs, '0x33  GDT[6] ring 3');

      // Not in a syscall, said in words — the register holds -1, which as a number reads as
      // 18446744073709551615 and means nothing at all.
      const threadRef = await getRegisterGroupRef(client, registersRef, 'Thread / Syscall');
      const threadRows = await client.sendRequest<{ variables: Array<{ name: string; value: string; type?: string }> }>('variables', {
        variablesReference: threadRef,
      });
      assert.strictEqual(threadRows.variables.find((v) => v.name === 'orig_rax')!.value, 'not in a syscall');

      // ...and named when it does hold a number. Set through gdb rather than by waiting for a real
      // syscall stop, because the kernel resets orig_rax to -1 on a breakpoint trap.
      await client.sendRequest('evaluate', { expression: 'set $orig_rax = 59', context: 'repl' });
      const named = await client.sendRequest<{ variables: Array<{ name: string; value: string; type?: string }> }>('variables', {
        variablesReference: threadRef,
      });
      const origRax = named.variables.find((v) => v.name === 'orig_rax')!;
      assert.strictEqual(origRax.value, '59  execve');
      assert.match(origRax.type!, /the fourth is r10, not rcx/);

      // A SIMD register is writable, lane by lane, since gdb has no whole-register assignment for
      // one — and a write of more than 64 bits has to land in both halves.
      const written = await client.sendRequest<{ value: string }>('setVariable', {
        variablesReference: vectorRef,
        name: vectorRows.variables[3].name,
        value: '0xdeadbeefcafebabe1122334455667788',
      });
      assert.match(written.value, /^0xdeadbeefcafebabe1122334455667788/);

      // An x87 register is written as the float it holds, not as a bit pattern.
      const st0Written = await client.sendRequest<{ value: string }>('setVariable', { variablesReference: x87Ref, name: 'st0', value: '-2.5' });
      assert.match(st0Written.value, /^-2\.5\s+normal\s+sign -/);

      // A name gdb invented rather than one the ISA reserves still resolves in Watch...
      const fsBase = await client.sendRequest<{ result: string }>('evaluate', { expression: 'fs_base', context: 'watch' });
      assert.match(fsBase.result, /^0x[0-9a-f]+/);

      // ...but never ahead of one of this program's own labels, which is the whole reason those
      // names are kept out of the reserved set.
      const msgLabel = await client.sendRequest<{ result: string }>('evaluate', { expression: 'msg', context: 'watch' });
      assert.match(msgLabel.result, /hello/, 'expected a program label to win over any register lookup');

      await client.sendRequest('continue', { threadId: 1 });
      await client.waitForEvent('terminated');
      await client.sendRequest('disconnect');
    } catch (err) {
      throw new Error(`${(err as Error).message}\n--- adapter stderr ---\n${stderrChunks.join('')}`);
    } finally {
      proc.kill();
      await removeTempDir(simdDir);
    }
  });

  it('reconstructs a real nested call stack for a binary with no unwind information at all', async function () {
    // gdb on its own reports exactly one frame here, however deep the program is: a fasmg binary
    // carries no DWARF, no .eh_frame and no symbol table. The frames below come from the listing —
    // every call's own encoding says where it returns to, which makes recognising a return address
    // on the stack exact rather than a guess. See debug/src/unwind.ts.
    this.timeout(30000);

    const callDir = makeTempDir('fasm2-studio-dap-e2e-callstack-');
    const callAsmPath = path.join(callDir, 'callstack.asm');
    const callProgramPath = path.join(callDir, 'callstack');
    const callListingPath = path.join(callDir, 'callstack.lst');
    // Deliberately mixes the two shapes real assembly comes in: `outer` keeps a frame pointer, so
    // the chain walk has something to follow, while `inner` is frameless — which is what most
    // hand-written assembly looks like, and what the scan fallback exists for.
    const CALL_SRC = [
      'format ELF64 executable 3', // 1
      'entry start', // 2
      '', // 3
      'segment readable executable', // 4
      '', // 5
      'start:', // 6
      '\tpush rbp', // 7
      '\tmov rbp, rsp', // 8
      '\tcall outer', // 9
      '\tmov eax, 60', // 10
      '\txor edi, edi', // 11
      '\tsyscall', // 12
      '', // 13
      'outer:', // 14
      '\tpush rbp', // 15
      '\tmov rbp, rsp', // 16
      '\tcall inner', // 17
      '\tpop rbp', // 18
      '\tret', // 19
      '', // 20
      'inner:', // 21
      '\tnop', // 22
      '\tret', // 23
      '', // 24
    ].join('\n');
    fs.writeFileSync(callAsmPath, CALL_SRC, 'utf8');
    const build = spawnSync('fasm2', ['-i', "include 'listing.inc'", callAsmPath, callProgramPath], { cwd: callDir, timeout: 15000 });
    if (build.status !== 0) throw new Error(`fasm2 build failed:\n${build.stdout}\n${build.stderr}`);
    fs.chmodSync(callProgramPath, 0o755);

    const proc = spawn(process.execPath, [path.join(__dirname, '..', 'dist', 'adapter.js')], { stdio: ['pipe', 'pipe', 'pipe'] });
    const client = new DapClient(proc);
    const stderrChunks: string[] = [];
    proc.stderr.on('data', (c: Buffer) => stderrChunks.push(c.toString('utf8')));

    try {
      await client.sendRequest('initialize', { adapterID: 'fasm2', linesStartAt1: true, columnsStartAt1: true, pathFormat: 'path' });
      await client.waitForEvent('initialized');
      await client.sendRequest('launch', { program: callProgramPath, asmFile: callAsmPath, listingFile: callListingPath, cwd: callDir });
      // The `nop` inside the innermost routine — two calls deep from the entry point.
      await client.sendRequest('setBreakpoints', { source: { path: callAsmPath }, breakpoints: [{ line: 22 }] });
      await client.sendRequest('configurationDone');
      await client.waitForEvent('stopped', (b) => (b as { reason?: string }).reason === 'breakpoint');

      const trace = await client.sendRequest<{
        stackFrames: Array<{ id: number; name: string; line: number; instructionPointerReference?: string; presentationHint?: string }>;
        totalFrames: number;
      }>('stackTrace', { threadId: 1 });

      assert.strictEqual(trace.stackFrames.length, 3, `expected start -> outer -> inner, got ${JSON.stringify(trace.stackFrames.map((f) => f.name))}`);
      assert.strictEqual(trace.totalFrames, 3);

      // Innermost first, each named by the label it is executing inside — there is no function
      // symbol to name a frame after, so the label is the answer.
      assert.match(trace.stackFrames[0].name, /^inner/, 'the innermost frame is where the program is stopped');
      assert.match(trace.stackFrames[1].name, /^outer/);
      assert.match(trace.stackFrames[2].name, /^start/);

      // A caller frame resumes at the instruction *after* its call, so it maps to the line after
      // the one that called — line 18 for outer's "call inner" on 17, line 10 for start's on 9.
      assert.strictEqual(trace.stackFrames[0].line, 22, 'the innermost frame is at the breakpoint itself');
      assert.strictEqual(trace.stackFrames[1].line, 18);
      assert.strictEqual(trace.stackFrames[2].line, 10);

      // Every frame is disassemblable, and the callers are marked as the mid-call frames they are.
      for (const frame of trace.stackFrames) assert.match(frame.instructionPointerReference ?? '', /^0x[0-9a-f]+$/);
      assert.strictEqual(trace.stackFrames[0].presentationHint, undefined);
      assert.strictEqual(trace.stackFrames[1].presentationHint, 'subtle');

      // The Stack group reads the same return addresses out of the raw words, and says so — which
      // is what makes the stack legible as a frame rather than a column of numbers.
      const scopes = await client.sendRequest<{ scopes: Array<{ name: string; variablesReference: number }> }>('scopes', { frameId: trace.stackFrames[0].id });
      const registersRef = scopes.scopes.find((s) => s.name === 'Registers')!.variablesReference;
      const groups = await client.sendRequest<{ variables: Array<{ name: string; variablesReference: number }> }>('variables', { variablesReference: registersRef });
      const stackGroup = groups.variables.find((v) => v.name === 'Stack')!;
      const stackRows = await client.sendRequest<{ variables: Array<{ name: string; value: string }> }>('variables', {
        variablesReference: stackGroup.variablesReference,
      });
      // [rsp+0x0] holds the return address inner was called with, since inner pushes nothing.
      assert.match(stackRows.variables[0].name, /^\[rsp\+0x0\]$/);
      assert.match(stackRows.variables[0].value, /return address/, `expected the word at rsp to be flagged: ${stackRows.variables[0].value}`);
      // ...and it resolves to a label, the same way every other address in this UI does.
      assert.match(stackRows.variables[0].value, /→ outer\+0x/);
      // The frame pointer still addresses outer's frame, and the row it points at says so.
      const framePointerRow = stackRows.variables.find((v) => /← rbp/.test(v.value));
      assert.ok(framePointerRow, `expected one row marked as the frame pointer: ${JSON.stringify(stackRows.variables.map((v) => v.value))}`);

      await client.sendRequest('disconnect');
    } catch (err) {
      throw new Error(`${(err as Error).message}\n--- adapter stderr ---\n${stderrChunks.join('')}`);
    } finally {
      proc.kill();
      await removeTempDir(callDir);
    }
  });

});

/**
 * Windows-only: the Disassembly View equivalent of stepping into a real WinAPI call — the case
 * disassembleAround's anchor-fallback (session.ts) exists for. A `call` here doesn't land on a
 * mapped mid-macro address the way the Linux macro test above does; it leaves the user's own
 * program's address range *entirely*, into a system DLL the listing has never heard of and whose
 * address can be nowhere near it. That used to make the *whole* disassembled page come back as
 * placeholder "(unavailable)" rows — confirmed directly against gdb: asking it to disassemble from
 * the program's own low address up through the DLL's (necessarily spanning the unmapped gap between
 * them) fails outright with "Cannot access memory", which is exactly the query the old anchor logic
 * built.
 */
describe('Disassembly View across a step into a real Windows API call (real adapter.js, real gdb, real fasm2 PE binary)', function () {
  let dir: string;
  let asmPath: string;
  let programPath: string;
  let listingPath: string;
  const gdbAvailable = isAvailable('gdb');
  // fasm2's official Windows distribution is a ".cmd" wrapper — spawnSync only resolves that
  // through a shell, unlike gdb.exe, which is a real executable.
  const fasm2Available = os.platform() === 'win32' && !spawnSync('fasm2', ['--version'], { shell: true, timeout: 5000 }).error;

  const PE_SRC = [
    'format PE64 console',
    'entry start',
    // Included directly rather than via fasm2's "-i" flag — see inferiorTerminal.e2e.test.ts's own
    // PE_ECHO_SRC for why that flag is not worth fighting cmd.exe's quoting over in a test.
    "include 'listing.inc'",
    '',
    "include 'win64a.inc'",
    '',
    "section '.text' code readable executable",
    '',
    'start:',
    '\tsub     rsp, 40',
    '\tinvoke  GetStdHandle, STD_OUTPUT_HANDLE',
    '\tinvoke  ExitProcess, 0',
    '',
    // Not left empty: an empty ".data" section produced a PE Windows itself refuses to launch
    // (CreateProcess error 193, "not a valid Win32 application") — fasm2 assembled it without
    // complaint, so this only ever surfaced as the debug session failing to start at all, confirmed
    // directly. One placeholder qword is enough to avoid it.
    "section '.data' data readable writeable",
    '',
    'written dq ?',
    '',
    "section '.idata' import data readable writeable",
    '',
    "library kernel32, 'KERNEL32.DLL'",
    "import kernel32, GetStdHandle, 'GetStdHandle', ExitProcess, 'ExitProcess'",
    '',
  ].join('\n');

  before(function () {
    if (!gdbAvailable || !fasm2Available || os.platform() !== 'win32') {
      this.skip();
      return;
    }
    dir = makeTempDir('fasm2-studio-dap-e2e-disasm-win-');
    asmPath = path.join(dir, 'prog.asm');
    programPath = path.join(dir, 'prog.exe');
    listingPath = path.join(dir, 'prog.lst');
    fs.writeFileSync(asmPath, PE_SRC, 'utf8');

    const build = spawnSync('fasm2', [asmPath, programPath], { cwd: dir, shell: true, timeout: 15000 });
    if (build.status !== 0) throw new Error(`fasm2 build failed:\n${build.stdout}\n${build.stderr}`);
  });

  after(async () => {
    await removeTempDir(dir);
  });

  it('decodes real instructions and names the frame, instead of "(unavailable)" rows and "<unmapped address>", once the PC leaves the program for kernel32', async function () {
    this.timeout(30000);

    const proc = spawn(process.execPath, [path.join(__dirname, '..', 'dist', 'adapter.js')], { stdio: ['pipe', 'pipe', 'pipe'] });
    const client = new DapClient(proc);
    const stderrChunks: string[] = [];
    proc.stderr.on('data', (c: Buffer) => stderrChunks.push(c.toString('utf8')));

    type Insn = { address: string; instruction: string; symbol?: string; presentationHint?: string };

    try {
      await client.sendRequest('initialize', { adapterID: 'fasm2', linesStartAt1: true, columnsStartAt1: true, pathFormat: 'path' });
      await client.waitForEvent('initialized');
      await client.sendRequest('launch', { program: programPath, asmFile: asmPath, listingFile: listingPath, cwd: dir, stopOnEntry: true });
      await client.sendRequest('configurationDone');
      await client.waitForEvent('stopped');

      // "sub rsp,40", then invoke's own expansion, then the call itself — four single-instruction
      // steps from entry reaches inside GetStdHandle every time (confirmed directly against this
      // exact program with real gdb before writing this test, not assumed). waitForEvent's own
      // no-predicate form matches the *first* "stopped" it ever saw on every call — the entry stop
      // above, forever — so each iteration here waits for one it hasn't already counted instead.
      let seenStops = 1;
      for (let i = 0; i < 4; i++) {
        await client.sendRequest('stepIn', { threadId: 1, granularity: 'instruction' });
        seenStops += 1;
        await client.waitForEvent('stopped', () => client.events.filter((e) => e.event === 'stopped').length >= seenStops);
      }

      const trace = await client.sendRequest<{ stackFrames: Array<{ name: string; instructionPointerReference?: string }> }>('stackTrace', {
        threadId: 1,
      });
      const pc = trace.stackFrames[0].instructionPointerReference;
      assert.ok(pc, 'no instructionPointerReference on the frame after stepping into GetStdHandle');
      // The Call Stack view's own version of the same fix: a frame with no FASM-mapped source line
      // used to render as a bare "<unmapped address>" — gdb's own symbol lookup was never asked.
      assert.match(
        trace.stackFrames[0].name,
        /GetStdHandle/i,
        `expected the frame itself to carry gdb's own symbol, not "<unmapped address>": ${JSON.stringify(trace.stackFrames[0])}`,
      );

      // The same shape VS Code's own Disassembly View asks for when it opens on a stop: a page
      // centered on the current instruction, mostly *before* it — negative instructionOffset, the
      // exact path the old anchor logic broke on once target left the mapped program behind.
      const page = await client.sendRequest<{ instructions: Insn[] }>('disassemble', {
        memoryReference: pc,
        instructionOffset: -20,
        instructionCount: 40,
      });
      assert.strictEqual(page.instructions.length, 40);

      const targetIdx = page.instructions.findIndex((insn) => insn.address === pc);
      assert.notStrictEqual(targetIdx, -1, `expected the requested address itself among the decoded instructions: ${JSON.stringify(page.instructions)}`);

      const target = page.instructions[targetIdx];
      assert.notStrictEqual(target.presentationHint, 'invalid', 'the current instruction itself came back as "(unavailable)"');
      assert.match(target.symbol ?? '', /GetStdHandle/i, `expected gdb's own symbol lookup on kernel32 code, got: ${JSON.stringify(target)}`);

      // The actual regression this test exists for: not *every* row in the page is a placeholder.
      // Some rows immediately before target failing to reach far enough back is tolerable (there is
      // no real boundary to anchor on in foreign code) — a wall of nothing but "(unavailable)" is
      // the bug.
      const invalidCount = page.instructions.filter((insn) => insn.presentationHint === 'invalid').length;
      assert.ok(invalidCount < page.instructions.length, `every single row came back "(unavailable)": ${JSON.stringify(page.instructions)}`);

      await client.sendRequest('disconnect');
    } catch (err) {
      throw new Error(`${(err as Error).message}\n--- adapter stderr ---\n${stderrChunks.join('')}`);
    } finally {
      proc.kill();
    }
  });
});
