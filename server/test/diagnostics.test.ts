import * as assert from 'assert';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DiagnosticSeverity } from 'vscode-languageserver/node';
import { parseDiagnostics, runDiagnostics } from '../src/features/diagnostics';

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
    assert.match(diags[0].message, /undefinedsymbol/);
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
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fasm2-studio-test-'));
    const file = path.join(dir, 'bad.asm');
    fs.writeFileSync(file, 'format binary\nmov eax, undefinedsymbol\n');

    try {
      const result = await runDiagnostics({ compilerPath, sourceFsPath: file, cwd: dir });
      assert.strictEqual(result.toolError, undefined);
      assert.strictEqual(result.diagnostics.length, 1);
      assert.strictEqual(result.diagnostics[0].range.start.line, 1);
      assert.match(result.diagnostics[0].message, /undefinedsymbol/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports no diagnostics for a valid source file', async function () {
    this.timeout(15000);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fasm2-studio-test-'));
    const file = path.join(dir, 'good.asm');
    fs.writeFileSync(file, 'format binary\nstart:\n\tmov eax, 1\n');

    try {
      const result = await runDiagnostics({ compilerPath, sourceFsPath: file, cwd: dir });
      assert.strictEqual(result.toolError, undefined);
      assert.deepStrictEqual(result.diagnostics, []);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
