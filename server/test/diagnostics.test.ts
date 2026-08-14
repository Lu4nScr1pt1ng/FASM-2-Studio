import * as assert from 'assert';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Diagnostic, DiagnosticSeverity } from 'vscode-languageserver/node';
import { abandonRunningCompilers, FASM1_FIRST_ERROR_NOTE, noteFirstErrorOnly, parseDiagnostics, runDiagnostics } from '../src/features/diagnostics';
import { bundledListingIncPath } from '../src/features/inlayHints';
import { parseListingFile } from '../src/listing/listingMap';
import { makeTempDir, removeTempDir } from './tempDir';

// This project's fasm/fasm1 output never produces a MarkupContent message — only the LSP type
// allows for one (a 3.18 protocol addition) — so asserting it's a plain string here is safe.
function messageText(d: Diagnostic): string {
  assert.strictEqual(typeof d.message, 'string');
  return d.message as string;
}

describe('parseDiagnostics', () => {
  it('parses a single-error block captured from a real fasm2 run', () => {
    const output = [
      'flat assembler  version g.kp60',
      'bad.asm [2]:',
      '\tmov eax, undefinedsymbol',
      "mov? [3] x86.parse_operand@src [32] (CALM)",
      "Error: symbol 'undefinedsymbol' is undefined or out of scope.",
    ].join('\n');

    const diags = parseDiagnostics(output, '/tmp/bad.asm');
    assert.strictEqual(diags.length, 1);
    assert.strictEqual(diags[0].severity, DiagnosticSeverity.Error);
    assert.strictEqual(diags[0].range.start.line, 1); // 0-based
    assert.match(messageText(diags[0]), /undefinedsymbol/);
  });

  it('parses multiple back-to-back error blocks (as produced by -e N)', () => {
    const output = [
      'flat assembler  version g.kp60',
      'bad2.asm [2]:',
      '\tmov eax, undefinedsymbol1',
      'mov? [3] x86.parse_operand@src [32] (CALM)',
      "Error: symbol 'undefinedsymbol1' is undefined or out of scope.",
      'bad2.asm [3]:',
      '\tmov ebx, undefinedsymbol2',
      'mov? [3] x86.parse_operand@src [32] (CALM)',
      "Error: symbol 'undefinedsymbol2' is undefined or out of scope.",
    ].join('\n');

    const diags = parseDiagnostics(output, '/tmp/bad2.asm');
    assert.strictEqual(diags.length, 2);
    assert.strictEqual(diags[0].range.start.line, 1);
    assert.strictEqual(diags[1].range.start.line, 2);
  });

  it('ignores error blocks reported against a different file (e.g. an include)', () => {
    const output = ['other.inc [5]:', '\tbad line', 'Error: something is wrong.'].join('\n');
    const diags = parseDiagnostics(output, '/tmp/main.asm');
    assert.strictEqual(diags.length, 0);
  });

  it('returns no diagnostics for output with no error/warning markers', () => {
    assert.deepStrictEqual(parseDiagnostics('flat assembler  version g.kp60\n', '/tmp/ok.asm'), []);
  });

  it('maps a "Warning:" line to warning severity, not error', () => {
    const output = ['warn.asm [4]:', '\tsome risky line', 'Warning: this might not do what you expect.'].join('\n');
    const diags = parseDiagnostics(output, '/tmp/warn.asm');
    assert.strictEqual(diags.length, 1);
    assert.strictEqual(diags[0].severity, DiagnosticSeverity.Warning);
    assert.match(messageText(diags[0]), /might not do what you expect/);
  });

  it('maps a "Custom error:" line (from an `err` instruction) to error severity, not dropped', () => {
    const output = [
      'custom.asm [7]:',
      '\tmovzx eax, byte [r12 + r11]',
      'movzx? [30] x86.store_instruction@src [77] x86.require.bits64? [6]',
      'Custom error: bits64 or higher required.',
    ].join('\n');
    const diags = parseDiagnostics(output, '/tmp/custom.asm');
    assert.strictEqual(diags.length, 1);
    assert.strictEqual(diags[0].severity, DiagnosticSeverity.Error);
    assert.match(messageText(diags[0]), /bits64 or higher required/);
  });

  it('handles a mix of error and warning blocks in the same run', () => {
    const output = [
      'mixed.asm [2]:',
      '\tbad line',
      'Error: something is definitely wrong.',
      'mixed.asm [5]:',
      '\trisky line',
      'Warning: something might be off.',
    ].join('\n');
    const diags = parseDiagnostics(output, '/tmp/mixed.asm');
    assert.strictEqual(diags.length, 2);
    assert.strictEqual(diags[0].severity, DiagnosticSeverity.Error);
    assert.strictEqual(diags[1].severity, DiagnosticSeverity.Warning);
  });
});

describe('runDiagnostics (integration, real fasm2 binary)', () => {
  const compilerPath = process.env.FASM2_STUDIO_TEST_COMPILER ?? 'fasm2';

  before(function () {
    const probe = spawnSync(compilerPath, [], { timeout: 5000 });
    if (probe.error) {
      this.skip();
    }
  });

  it('reports a real diagnostic for an undefined symbol', async function () {
    this.timeout(15000);
    const dir = makeTempDir('fasm2-studio-test-');
    const file = path.join(dir, 'bad.asm');
    fs.writeFileSync(file, 'format binary\nmov eax, undefinedsymbol\n');

    try {
      const result = await runDiagnostics({ compilerPath, sourceFsPath: file, cwd: dir });
      assert.strictEqual(result.toolError, undefined);
      assert.strictEqual(result.diagnostics.length, 1);
      assert.strictEqual(result.diagnostics[0].range.start.line, 1);
      assert.match(messageText(result.diagnostics[0]), /undefinedsymbol/);
    } finally {
      await removeTempDir(dir);
    }
  });

  it('compiles an entry file but reports diagnostics against an included fragment via reportForFsPath', async function () {
    this.timeout(15000);
    const dir = makeTempDir('fasm2-studio-test-');
    const entryFile = path.join(dir, 'main.asm');
    const fragmentFile = path.join(dir, 'fragment.inc');
    fs.writeFileSync(entryFile, "format binary\ninclude 'fragment.inc'\n");
    fs.writeFileSync(fragmentFile, 'mov eax, undefinedsymbol\n');

    try {
      const result = await runDiagnostics({ compilerPath, sourceFsPath: entryFile, cwd: dir, reportForFsPath: fragmentFile });
      assert.strictEqual(result.toolError, undefined);
      assert.strictEqual(result.diagnostics.length, 1);
      assert.strictEqual(result.diagnostics[0].range.start.line, 0);
      assert.match(messageText(result.diagnostics[0]), /undefinedsymbol/);
    } finally {
      await removeTempDir(dir);
    }
  });

  it('reports no diagnostics for a valid source file', async function () {
    this.timeout(15000);
    const dir = makeTempDir('fasm2-studio-test-');
    const file = path.join(dir, 'good.asm');
    fs.writeFileSync(file, 'format binary\nstart:\n\tmov eax, 1\n');

    try {
      const result = await runDiagnostics({ compilerPath, sourceFsPath: file, cwd: dir });
      assert.strictEqual(result.toolError, undefined);
      assert.deepStrictEqual(result.diagnostics, []);
    } finally {
      await removeTempDir(dir);
    }
  });

  it('hands back the listing as written as well as parsed, so it can be shown to a human', async function () {
    this.timeout(15000);
    const listingInclude = bundledListingIncPath();
    if (!listingInclude) this.skip();

    const dir = makeTempDir('fasm2-studio-test-');
    const file = path.join(dir, 'listed.asm');
    // `use64` because `format binary` starts out 16-bit, and `syscall` is a 64-bit instruction —
    // without it this assembles to nothing and the listing never gets written.
    fs.writeFileSync(file, 'format binary\nuse64\n\tmov eax, 60\n\tsyscall\n');

    try {
      const result = await runDiagnostics({ compilerPath, sourceFsPath: file, cwd: dir, listingInclude });
      if (result.toolError) this.skip(); // no usable fasm2 on this machine
      assert.ok(result.listingText, 'the raw listing should come back alongside the parsed one');

      // The raw text keeps the columns the parsed form drops — the file-offset column in
      // particular, which is what someone reading a listing is usually there for.
      assert.match(result.listingText!, /mov eax, 60/);
      assert.match(result.listingText!, /^\[[0-9A-F]{16}\] [0-9A-F]{8}: /m);

      // The two views must describe the same build: the text is the very string the entries were
      // parsed out of, not a second compile's output.
      assert.deepStrictEqual(parseListingFile(result.listingText!), result.listing);
    } finally {
      await removeTempDir(dir);
    }
  });

  it('leaves listingText unset when no listing was asked for, so nothing pays for a feature it does not use', async function () {
    this.timeout(15000);
    const dir = makeTempDir('fasm2-studio-test-');
    const file = path.join(dir, 'plain.asm');
    fs.writeFileSync(file, 'format binary\n\tmov eax, 1\n');

    try {
      const result = await runDiagnostics({ compilerPath, sourceFsPath: file, cwd: dir });
      assert.strictEqual(result.listingText, undefined);
      assert.strictEqual(result.listing, undefined);
    } finally {
      await removeTempDir(dir);
    }
  });

  it('resolves a bare `include` outside the source directory via includePath, exactly as fasmg\'s own official examples require', async function () {
    // Mirrors a real, confirmed scenario in fasmg's own example tree: packages/x86/examples/windows
    // uses `include 'win32w.inc'` (win32w.inc lives in a sibling packages/x86/include/ directory,
    // not next to the .asm), and its bundled make.bat does `set include=..\..\include` before
    // building — without an equivalent INCLUDE env var, this fails with "source file not found"
    // even though the project is entirely correct.
    this.timeout(15000);
    const projectDir = makeTempDir('fasm2-studio-test-project-');
    const packageDir = makeTempDir('fasm2-studio-test-package-');
    const entryFile = path.join(projectDir, 'main.asm');
    fs.writeFileSync(entryFile, "format binary\ninclude 'shared.inc'\nstart:\n\tmov eax, 1\n");
    fs.writeFileSync(path.join(packageDir, 'shared.inc'), 'SHARED_CONST = 1\n');

    try {
      const withoutIncludePath = await runDiagnostics({ compilerPath, sourceFsPath: entryFile, cwd: projectDir });
      assert.strictEqual(withoutIncludePath.toolError, undefined);
      assert.ok(withoutIncludePath.diagnostics.length > 0, 'expected a "source file not found"-style error without includePath');

      const withIncludePath = await runDiagnostics({
        compilerPath,
        sourceFsPath: entryFile,
        cwd: projectDir,
        includePath: packageDir,
      });
      assert.strictEqual(withIncludePath.toolError, undefined);
      assert.deepStrictEqual(withIncludePath.diagnostics, []);
    } finally {
      await removeTempDir(projectDir);
      await removeTempDir(packageDir);
    }
  });

  // A project can require a flag to assemble at all, and until fasm2Studio.compilerArgs existed
  // there was no way to give the background compile one — so a project like this reported an error
  // on every edit, on a line that is not wrong, with nothing in the settings able to reach it.
  it('passes compilerArgs through to the compile, which some projects need to assemble at all', async function () {
    this.timeout(15000);
    const dir = makeTempDir('fasm2-studio-compiler-args-');
    const file = path.join(dir, 'gated.asm');
    // `err` inside an `if` is how a fasmg project states a build-time requirement of its own.
    // Nothing below the gate refers to BUILD_MODE: the point is the requirement itself, and a use
    // of the undefined symbol would raise a second error that has nothing to do with it.
    fs.writeFileSync(file, ['format binary', 'if ~ defined BUILD_MODE', "\terr 'BUILD_MODE is not defined'", 'end if', '\tmov eax, 1', ''].join('\n'));

    try {
      const without = await runDiagnostics({ compilerPath, sourceFsPath: file, cwd: dir });
      assert.strictEqual(without.toolError, undefined);
      assert.strictEqual(without.diagnostics.length, 1, 'expected the project to refuse to assemble without its flag');
      assert.match(messageText(without.diagnostics[0]), /BUILD_MODE is not defined/);

      const withArgs = await runDiagnostics({
        compilerPath,
        sourceFsPath: file,
        cwd: dir,
        extraArgs: ['-i', 'define BUILD_MODE 1'],
      });
      assert.strictEqual(withArgs.toolError, undefined);
      assert.deepStrictEqual(withArgs.diagnostics, [], 'the flag should have satisfied the requirement, leaving nothing to report');
    } finally {
      await removeTempDir(dir);
    }
  });

  // The ordering the build task and this compile both rely on, stated as a behaviour rather than
  // as a claim in a comment: user flags go last, and fasmg takes the final occurrence of one.
  it('places compilerArgs where a repeated flag overrides the one this extension sets', async function () {
    this.timeout(15000);
    const dir = makeTempDir('fasm2-studio-compiler-args-order-');
    const file = path.join(dir, 'many.asm');
    fs.writeFileSync(file, 'format binary\nmov eax, undef1\nmov ebx, undef2\nmov ecx, undef3\n');

    try {
      const capped = await runDiagnostics({ compilerPath, sourceFsPath: file, cwd: dir, extraArgs: ['-e', '1'] });
      assert.strictEqual(capped.toolError, undefined);
      assert.strictEqual(capped.diagnostics.length, 1, "a user's own -e must outrank the -e this extension passes");

      const uncapped = await runDiagnostics({ compilerPath, sourceFsPath: file, cwd: dir });
      assert.strictEqual(uncapped.diagnostics.length, 3, 'without an override, all three errors are still reported');
    } finally {
      await removeTempDir(dir);
    }
  });
});

describe('runDiagnostics (reliability, against fake tools — no real fasm2 required)', () => {
  it('reports a toolError instead of throwing when the compiler binary does not exist', async function () {
    this.timeout(10000);
    const dir = makeTempDir('fasm2-studio-test-');
    try {
      const result = await runDiagnostics({
        compilerPath: '/definitely/not/a/real/compiler/anywhere',
        sourceFsPath: path.join(dir, 'whatever.asm'),
        cwd: dir,
      });
      assert.deepStrictEqual(result.diagnostics, []);
      assert.ok(result.toolError, 'expected a toolError describing the spawn failure');
    } finally {
      await removeTempDir(dir);
    }
  });

  it('kills a hanging compiler after the timeout and reports it, rather than waiting forever', async function () {
    if (os.platform() === 'win32') {
      this.skip();
      return;
    }
    this.timeout(10000);
    const dir = makeTempDir('fasm2-studio-hang-test-');
    const fakeCompiler = path.join(dir, 'hangs-forever.sh');
    fs.writeFileSync(fakeCompiler, '#!/bin/sh\nsleep 30\n', 'utf8');
    fs.chmodSync(fakeCompiler, 0o755);

    try {
      const started = Date.now();
      const result = await runDiagnostics({
        compilerPath: fakeCompiler,
        sourceFsPath: path.join(dir, 'whatever.asm'),
        cwd: dir,
        timeoutMs: 300,
      });
      const elapsedMs = Date.now() - started;

      assert.strictEqual(result.toolError, 'Compiler timed out');
      assert.deepStrictEqual(result.diagnostics, []);
      assert.ok(elapsedMs < 5000, `expected the timeout to cut this off well under 5s, took ${elapsedMs}ms`);
    } finally {
      await removeTempDir(dir);
    }
  });

  it('cleans up its temp output file after a timeout, not just on success', async function () {
    if (os.platform() === 'win32') {
      this.skip();
      return;
    }
    this.timeout(10000);
    const dir = makeTempDir('fasm2-studio-hang-cleanup-test-');
    const fakeCompiler = path.join(dir, 'hangs-forever.sh');
    fs.writeFileSync(fakeCompiler, '#!/bin/sh\nsleep 30\n', 'utf8');
    fs.chmodSync(fakeCompiler, 0o755);

    const before = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('fasm2-studio-'));
    try {
      await runDiagnostics({ compilerPath: fakeCompiler, sourceFsPath: path.join(dir, 'whatever.asm'), cwd: dir, timeoutMs: 300 });
      // Give the fire-and-forget unlink() in the `finally` block a moment to actually land.
      await new Promise((resolve) => setTimeout(resolve, 200));
      const after = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('fasm2-studio-'));
      assert.deepStrictEqual(after, before, 'expected no leftover fasm2-studio-*.out temp files after a timed-out run');
    } finally {
      await removeTempDir(dir);
    }
  });

  it('cleans up an artifact the source wrote that this compile never asked for', async function () {
    if (!hasFasm2()) this.skip();
    this.timeout(15000);

    // `virtual as 'lst'` writes a second file beside the output — which is exactly what the bundled
    // listing.inc does, and any project may include it. Deleting only the paths this module names
    // left one such file per compile in the temp directory, and diagnostics recompile on every
    // pause in typing.
    const dir = makeTempDir('fasm2-studio-artifact-');
    const sourceFsPath = path.join(dir, 'emits.asm');
    fs.writeFileSync(sourceFsPath, ["format binary", "db 1", "postpone", "  virtual as 'lst'", "    db 'listing'", '  end virtual', 'end postpone', ''].join('\n'), 'utf8');

    const before = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('fasm2-studio-'));
    try {
      const result = await runDiagnostics({ compilerPath: 'fasm2', sourceFsPath, cwd: dir });
      if (result.toolError) this.skip(); // no usable fasm2 on this machine
      const after = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('fasm2-studio-'));
      assert.deepStrictEqual(after, before, 'the compile left an artifact of its own behind in the temp directory');
    } finally {
      await removeTempDir(dir);
    }
  });
});

describe('abandonRunningCompilers', () => {
  it('kills a compiler that is still running, so it cannot outlive the server process', async function () {
    if (os.platform() === 'win32') {
      this.skip();
      return;
    }
    this.timeout(10000);

    // The compilers are spawned detached, which is what lets a timeout kill a whole process tree
    // and equally what stops them dying with the server: they are in their own process group, and
    // the timer that would eventually have killed them belongs to the process that is leaving. A
    // fasmg macro that never terminates is an ordinary thing to type by accident, so the orphan is
    // not always one that ends on its own.
    const dir = makeTempDir('fasm2-studio-abandon-');
    const pidFile = path.join(dir, 'pid');
    const fakeCompiler = path.join(dir, 'hangs-forever.sh');
    fs.writeFileSync(fakeCompiler, `#!/bin/sh\necho $$ > ${pidFile}\nsleep 30\n`, 'utf8');
    fs.chmodSync(fakeCompiler, 0o755);

    try {
      // Deliberately not awaited: the point is to act while the compile is still in flight.
      const compile = runDiagnostics({ compilerPath: fakeCompiler, sourceFsPath: path.join(dir, 'whatever.asm'), cwd: dir, timeoutMs: 20000 });
      await waitFor(() => fs.existsSync(pidFile));
      const pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
      assert.ok(isAlive(pid), 'the fake compiler should be running before it is abandoned');

      abandonRunningCompilers();

      await waitFor(() => !isAlive(pid));
      assert.ok(!isAlive(pid), 'the compiler was left running after the server abandoned it');
      await compile;
    } finally {
      await removeTempDir(dir);
    }
  });
});

/** Whether a real fasm2 is installed, for the tests that need one to write a file. */
function hasFasm2(): boolean {
  return !spawnSync('fasm2', [], { timeout: 5000 }).error;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Polls until `condition` holds or ~3s have passed, so the test neither races the OS nor waits a
 * fixed pessimistic delay for it. */
async function waitFor(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 150 && !condition(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('parseDiagnostics (header shapes seen in real project builds)', () => {
  it('parses a header with no trailing colon, which fasmg emits when it quotes no source line', () => {
    // Real, from bitRAKE/fasmg_playground's math/oeis/A000055.asm: the error is raised past the
    // end of the file, so there is nothing to quote and the usual ":" is absent. Requiring it made
    // this build look completely clean.
    const output = ['/tmp/A000055.asm [66]', 'Custom error: NO OUTPUT FILE.'].join('\n');
    const diags = parseDiagnostics(output, '/tmp/A000055.asm');

    assert.strictEqual(diags.length, 1);
    assert.strictEqual(diags[0].range.start.line, 65);
    assert.match(messageText(diags[0]), /NO OUTPUT FILE/);
  });

  it('does not mistake a macro call-stack trace for a header, even though it also ends in "[n]"', () => {
    // The trace line between a header and its message ends in "[6]" exactly like a colon-less
    // header does; reading it as one replaced the real location and dropped the diagnostic.
    const output = [
      'custom.asm [7]:',
      '\tmovzx eax, byte [r12 + r11]',
      'movzx? [30] x86.store_instruction@src [77] x86.require.bits64? [6]',
      'Custom error: bits64 or higher required.',
    ].join('\n');
    const diags = parseDiagnostics(output, '/tmp/custom.asm');

    assert.strictEqual(diags.length, 1);
    assert.strictEqual(diags[0].range.start.line, 6, 'expected the location from the real header, not the trace');
  });

  it('does not mistake a single-frame macro trace for a header', () => {
    // Verbatim from `fasm2` (g.kp60). Every instruction-encoding error fasmg's x86 package raises
    // arrives with a one-frame trace like this, and it is shaped exactly like a colon-less header:
    // reading it as one attributed the error to a "file" called "mov?", which exists nowhere, so
    // the document's own errors were replaced by an empty diagnostic list — the whole file went
    // quiet the moment it stopped assembling, and stayed quiet through every later edit.
    const output = ['bad.asm [5]:', '\tmov [msg], ax', 'mov? [38]', 'Custom error: operand sizes do not match.'].join('\n');
    const diags = parseDiagnostics(output, '/tmp/bad.asm');

    assert.strictEqual(diags.length, 1, 'expected the error on the file, not on the macro frame');
    assert.strictEqual(diags[0].range.start.line, 4);
    assert.match(messageText(diags[0]), /operand sizes do not match/);
  });

  it('does not mistake the "?" frame of an unrecognized mnemonic for a header', () => {
    // The trace frame for a mnemonic no macro matches is named "?" alone, so the error landed on a
    // file called "?" — which is what "Build failed in ? line 4: illegal instruction" was.
    const output = ['bad.asm [5]:', '\tmvo rax, 1', '? [4]', 'Processed: mvo rax, 1', 'Error: illegal instruction.'].join('\n');
    const diags = parseDiagnostics(output, '/tmp/bad.asm');

    assert.strictEqual(diags.length, 1);
    assert.strictEqual(diags[0].range.start.line, 4);
  });

  it('does not mistake a macro frame that carries its own source line for a header', () => {
    // A frame can be printed with a trailing colon and a quoted line of the macro's body, making it
    // matchable as an ordinary header too — position, not shape, is what rules it out.
    const output = ['nest.asm [8]:', '\twrap mov [x], ax', 'macro wrap [1]:', '\top', 'Processed: mov [x]', 'Error: missing argument.'].join('\n');
    const diags = parseDiagnostics(output, '/tmp/nest.asm');

    assert.strictEqual(diags.length, 1);
    assert.strictEqual(diags[0].range.start.line, 7);
  });

  it('keeps reporting the blocks after one that ended in a macro trace', () => {
    // The frames must not swallow the headers that follow them: a file with several mistakes gets
    // one block each, back to back, and every one of them ends in a trace.
    const output = [
      'multi.asm [5]:',
      '\tmvo rax, 1',
      '? [4]',
      'Processed: mvo rax, 1',
      'Error: illegal instruction.',
      'multi.asm [7]:',
      '\tmov [q], ax',
      'mov? [38]',
      'Custom error: operand sizes do not match.',
    ].join('\n');
    const diags = parseDiagnostics(output, '/tmp/multi.asm');

    assert.deepStrictEqual(
      diags.map((d) => d.range.start.line),
      [4, 6],
    );
  });

  it('takes the innermost location from an include-chain header', () => {
    // "prog.asm [18] support/win64.inc [14]:" means the error is at win64.inc line 14, reached
    // from prog.asm line 18 — attributing it to prog.asm line 18 would point at the wrong file.
    const output = ["prog.asm [18] support/win64.inc [14]:", "\tINCLUDE 'win64a.inc'", "Error: source file 'win64a.inc' not found."].join('\n');

    assert.strictEqual(parseDiagnostics(output, '/tmp/prog.asm').length, 0, 'the error belongs to the include, not this file');
    assert.strictEqual(parseDiagnostics(output, '/tmp/support/win64.inc').length, 1);
  });
});

describe('a build that fails entirely inside an included file', () => {
  /** A fasm1-family compiler to run for real, or undefined if none is installed. */
  function findFasm1(): string | undefined {
    return [process.env.FASM2_STUDIO_TEST_FASM1, 'fasm1', 'fasm'].find((c) => {
      if (!c) return false;
      const probe = spawnSync(c, [], { timeout: 5000 });
      return !probe.error;
    });
  }

  it('marks the error in the file that actually holds it', async function () {
    // Validating against real projects, this was every remaining case where the compiler and the
    // editor disagreed: the assembler stops on a bad `include` before reaching any line of this
    // document, so filtering to this file's own errors left nothing to show at all. Naming the
    // culprit in a status-bar sentence was the first fix; putting the squiggle on its actual line,
    // in a file the user can click straight to, is the point of foreignDiagnostics.
    const compilerPath = findFasm1();
    if (!compilerPath) this.skip();
    this.timeout(15000);

    const dir = makeTempDir('fasm2-studio-foreign-');
    try {
      const included = path.join(dir, 'base.inc');
      fs.writeFileSync(included, "include 'does/not/exist.inc'\n");
      const file = path.join(dir, 'prog.asm');
      fs.writeFileSync(file, "format binary\ninclude 'base.inc'\n");

      const result = await runDiagnostics({
        compilerPath,
        sourceFsPath: file,
        cwd: dir,
        dialect: 'fasm1',
        workspaceFolders: [dir],
      });

      assert.deepStrictEqual(result.diagnostics, [], 'the error is not on a line of this document');
      const forIncluded = result.foreignDiagnostics?.get(included);
      assert.ok(forIncluded?.length, 'a failing build must never look clean');
      assert.strictEqual(forIncluded[0].range.start.line, 0, 'the include is on the first line of base.inc');
      // Diagnostic.message is typed string | MarkupContent by the LSP types; ours is always plain.
      assert.match(String(forIncluded[0].message), /not found/);
    } finally {
      await removeTempDir(dir);
    }
  });

  it('keeps summarizing an error located outside the workspace, rather than marking up a file the user does not own', async function () {
    // A single mistake reaches the assembler's own library easily, and squiggles appearing in an
    // installed package the user cannot edit are noise. They must still be reported *somehow* —
    // the invariant is that a failing build never looks clean, not that it always has a squiggle.
    const compilerPath = findFasm1();
    if (!compilerPath) this.skip();
    this.timeout(15000);

    const dir = makeTempDir('fasm2-studio-foreign-');
    try {
      fs.writeFileSync(path.join(dir, 'base.inc'), "include 'does/not/exist.inc'\n");
      const file = path.join(dir, 'prog.asm');
      fs.writeFileSync(file, "format binary\ninclude 'base.inc'\n");

      // An unrelated folder: nothing under `dir` counts as part of the workspace.
      const result = await runDiagnostics({
        compilerPath,
        sourceFsPath: file,
        cwd: dir,
        dialect: 'fasm1',
        workspaceFolders: [path.join(os.tmpdir(), 'fasm2-studio-somewhere-else')],
      });

      assert.strictEqual(result.foreignDiagnostics, undefined, 'nothing outside the workspace may be marked up');
      assert.ok(result.toolError, 'a failing build must never look clean');
      assert.match(result.toolError, /base\.inc/, 'expected the failing include to be named');
    } finally {
      await removeTempDir(dir);
    }
  });
});

describe('parseDiagnostics (fasm1 output, which differs from fasmg in case)', () => {
  it('parses a real fasm1 error block, whose keyword is lowercase unlike fasmg\'s', () => {
    // Captured verbatim from flat assembler 1.73.32. The message keyword is "error:", not
    // fasmg's "Error:" — matching only the capitalized form silently produced zero diagnostics
    // for every fasm1 file.
    const output = [
      'flat assembler  version 1.73.32  (16384 kilobytes memory, x64)',
      '/tmp/f1bad.asm [2]:',
      'mov eax, undefinedsymbol',
      'processed: mov eax,undefinedsymbol',
      "error: undefined symbol 'undefinedsymbol'.",
    ].join('\n');

    const diags = parseDiagnostics(output, '/tmp/f1bad.asm');
    assert.strictEqual(diags.length, 1);
    assert.strictEqual(diags[0].severity, DiagnosticSeverity.Error);
    assert.strictEqual(diags[0].range.start.line, 1);
    assert.match(messageText(diags[0]), /undefinedsymbol/);
  });

  it('maps a lowercase fasm1 warning to Warning severity, not Error', () => {
    const output = ['/tmp/w.asm [3]:', '\tdb 300', 'warning: value out of range.'].join('\n');
    const diags = parseDiagnostics(output, '/tmp/w.asm');
    assert.strictEqual(diags.length, 1);
    assert.strictEqual(diags[0].severity, DiagnosticSeverity.Warning);
  });
});

describe('missing instruction set (bare fasmg used where fasm2 is expected)', () => {
  // "fasm2" is only the fasmg binary plus a wrapper preloading the x86 package. Point the
  // extension at a raw fasmg and every mnemonic in the file is rejected, producing up to -e's
  // limit of errors, none of which name the cause.
  function illegalInstructionOutput(lines: number): string {
    const blocks: string[] = ['flat assembler  version g.fake'];
    for (let i = 0; i < lines; i++) {
      blocks.push(`prog.asm [${i + 1}]:`, '\tmov eax, 1', 'Error: illegal instruction.');
    }
    return blocks.join('\n');
  }

  it('parses each illegal-instruction error individually (the raw, ungrouped view)', () => {
    const diags = parseDiagnostics(illegalInstructionOutput(6), '/tmp/prog.asm');
    assert.strictEqual(diags.length, 6);
    assert.ok(diags.every((d) => messageText(d).includes('illegal instruction')));
  });

  it('leaves a single illegal instruction alone — that is an ordinary typo, not a broken toolchain', () => {
    const diags = parseDiagnostics(illegalInstructionOutput(1), '/tmp/prog.asm');
    assert.strictEqual(diags.length, 1);
  });
});

describe('runDiagnostics (integration, real assemblers)', () => {
  // All three tools are the same family but behave differently here, so each is exercised
  // directly. Every case skips itself when its binary is absent, so CI (which installs none of
  // them) stays green.
  function available(command: string): boolean {
    const probe = spawnSync(command, [], { timeout: 5000 });
    return !probe.error;
  }

  const FASM2 = process.env.FASM2_STUDIO_TEST_COMPILER ?? 'fasm2';
  const FASMG = process.env.FASM2_STUDIO_TEST_FASMG ?? 'fasmg';
  /**
   * fasm2's bundled `include` directory, holding the fasm2.inc that turns a bare fasmg into a
   * working x86 assembler. Derived from wherever `fasm2` actually resolves to rather than demanding
   * an environment variable, since the wrapper script sits directly beside that directory in every
   * standard install — so this test runs on its own for anyone who has fasm2 on PATH.
   */
  const FASM2_INCLUDE = process.env.FASM2_STUDIO_TEST_FASM2_INCLUDE ?? locateFasm2Include();

  function locateFasm2Include(): string | undefined {
    const resolved = spawnSync('sh', ['-c', 'command -v fasm2'], { encoding: 'utf8', timeout: 5000 });
    const command = resolved.stdout?.trim();
    if (!command) return undefined;
    const real = fs.existsSync(command) ? fs.realpathSync(command) : undefined;
    if (!real) return undefined;
    const candidate = path.join(path.dirname(real), 'include');
    return fs.existsSync(path.join(candidate, 'fasm2.inc')) ? candidate : undefined;
  }

  const X86_PROGRAM = 'format ELF64 executable\nsegment readable executable\nentry $\n\tmov eax, 60\n\txor edi, edi\n\tsyscall\n';

  function inTempDir<T>(name: string, content: string, run: (file: string, dir: string) => Promise<T>): Promise<T> {
    const dir = makeTempDir('fasm2-studio-isa-diag-');
    const file = path.join(dir, name);
    fs.writeFileSync(file, content);
    return run(file, dir).finally(() => removeTempDir(dir));
  }

  it('accepts a valid x86 program under fasm2', async function () {
    if (!available(FASM2)) this.skip();
    this.timeout(15000);
    await inTempDir('prog.asm', X86_PROGRAM, async (file, dir) => {
      const result = await runDiagnostics({ compilerPath: FASM2, sourceFsPath: file, cwd: dir });
      assert.strictEqual(result.toolError, undefined);
      assert.deepStrictEqual(result.diagnostics, []);
    });
  });

  it('explains the cause once, instead of flooding, when a bare fasmg is used for x86 source', async function () {
    if (!available(FASMG)) this.skip();
    this.timeout(20000);
    await inTempDir('prog.asm', X86_PROGRAM, async (file, dir) => {
      const result = await runDiagnostics({ compilerPath: FASMG, sourceFsPath: file, cwd: dir });
      assert.ok(result.toolError, 'expected the real cause to be reported as a tool error');
      assert.match(result.toolError, /no instruction set/);
      assert.deepStrictEqual(result.diagnostics, [], 'expected the per-line noise to be suppressed');
    });
  });

  it('assembles x86 source under a bare fasmg once a preload is configured', async function () {
    if (!available(FASMG) || !FASM2_INCLUDE) this.skip();
    this.timeout(20000);
    await inTempDir('prog.asm', X86_PROGRAM, async (file, dir) => {
      const result = await runDiagnostics({
        compilerPath: FASMG,
        sourceFsPath: file,
        cwd: dir,
        includePath: FASM2_INCLUDE,
        preload: 'fasm2.inc',
      });
      assert.strictEqual(result.toolError, undefined);
      assert.deepStrictEqual(result.diagnostics, []);
    });
  });

  it('does not blame the toolchain for a genuine non-x86 fasmg project, whose compiler correctly has no x86 preload', async function () {
    if (!available(FASMG)) this.skip();
    this.timeout(20000);
    // A real fasmg project for another target is valid: it brings its own instruction set. The
    // preload advice must never fire here -- that is the case auto-preloading x86 would corrupt.
    const pkg = Array.from({ length: 40 }, (_, i) => `macro zzq${i} a\n\tdb ${i}\nend macro\n`).join('');
    const dir = makeTempDir('fasm2-studio-isa-diag-');
    fs.writeFileSync(path.join(dir, 'myisa.inc'), pkg);
    const file = path.join(dir, 'prog.asm');
    fs.writeFileSync(file, "include 'myisa.inc'\n\tzzq1 0\n\tzzq2 0\n\tzzq3 0\n");

    try {
      const result = await runDiagnostics({ compilerPath: FASMG, sourceFsPath: file, cwd: dir });
      assert.strictEqual(result.toolError, undefined, 'a valid foreign-ISA project must not be blamed on the compiler');
      assert.deepStrictEqual(result.diagnostics, []);
    } finally {
      await removeTempDir(dir);
    }
  });

  it('reports a real error for x86 source under fasm1', async function () {
    const compilerPath = [process.env.FASM2_STUDIO_TEST_FASM1, 'fasm1', 'fasm'].find((c) => c && available(c));
    if (!compilerPath) this.skip();
    this.timeout(15000);
    await inTempDir('bad.asm', 'format binary\nmov eax, undefinedsymbol\n', async (file, dir) => {
      // Passing dialect matters: fasm1 rejects fasmg's -e flag outright, printing its usage banner
      // and assembling nothing, which parsed as zero diagnostics.
      const result = await runDiagnostics({ compilerPath, sourceFsPath: file, cwd: dir, dialect: 'fasm1' });
      assert.strictEqual(result.toolError, undefined);
      assert.strictEqual(result.diagnostics.length, 1);
      assert.match(messageText(result.diagnostics[0]), /undefinedsymbol/);
    });
  });

  it('accepts a valid x86 program under fasm1', async function () {
    const compilerPath = [process.env.FASM2_STUDIO_TEST_FASM1, 'fasm1', 'fasm'].find((c) => c && available(c));
    if (!compilerPath) this.skip();
    this.timeout(15000);
    await inTempDir('ok.asm', 'format binary\nuse32\n\tmov eax, 1\n\tret\n', async (file, dir) => {
      const result = await runDiagnostics({ compilerPath, sourceFsPath: file, cwd: dir, dialect: 'fasm1' });
      assert.strictEqual(result.toolError, undefined);
      assert.deepStrictEqual(result.diagnostics, []);
    });
  });
});

describe('noteFirstErrorOnly', () => {
  const uri = 'file:///project/main.asm';
  const error = (line: number): Diagnostic => ({
    severity: DiagnosticSeverity.Error,
    range: { start: { line, character: 0 }, end: { line, character: 10 } },
    message: 'illegal instruction.',
    source: 'fasm',
  });
  const warning = (line: number): Diagnostic => ({ ...error(line), severity: DiagnosticSeverity.Warning });

  it('explains that a lone fasm1 error is hiding whatever comes after it', () => {
    const diagnostics = [error(4)];
    noteFirstErrorOnly(uri, 'fasm1', diagnostics);
    assert.strictEqual(diagnostics[0].relatedInformation?.length, 1);
    assert.strictEqual(diagnostics[0].relatedInformation?.[0].message, FASM1_FIRST_ERROR_NOTE);
    assert.strictEqual(diagnostics[0].relatedInformation?.[0].location.uri, uri);
  });

  it('says nothing for fasm2, which is run with -e and reports every error at once', () => {
    const diagnostics = [error(4)];
    noteFirstErrorOnly(uri, 'fasm2', diagnostics);
    assert.strictEqual(diagnostics[0].relatedInformation, undefined);
  });

  it('says nothing when several errors came back, since the run plainly did not stop at one', () => {
    const diagnostics = [error(4), error(9)];
    noteFirstErrorOnly(uri, 'fasm1', diagnostics);
    assert.ok(diagnostics.every((d) => d.relatedInformation === undefined));
  });

  it('ignores warnings, which fasm1 carries on past', () => {
    const diagnostics = [warning(2), error(4), warning(6)];
    noteFirstErrorOnly(uri, 'fasm1', diagnostics);
    assert.strictEqual(diagnostics[1].relatedInformation?.length, 1);
    assert.strictEqual(diagnostics[0].relatedInformation, undefined);
  });

  it('does nothing to a clean run', () => {
    const diagnostics: Diagnostic[] = [];
    noteFirstErrorOnly(uri, 'fasm1', diagnostics);
    assert.deepStrictEqual(diagnostics, []);
  });
});
