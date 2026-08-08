// "FASM: Select Compiler". The wording is the point of these tests: its first step asks which of
// the two path settings to write, and phrased loosely that reads as "which dialect is this
// project?" — a question it does not answer and must not appear to.
import * as assert from 'assert';
import * as vscode from 'vscode';
import { compilerChoices, SELECT_COMPILER_PLACEHOLDER } from '../../src/selectCompiler';

describe('select compiler', () => {
  before(async () => {
    const ext = vscode.extensions.getExtension('Lu4nScr1pt1ng.fasm2-studio');
    assert.ok(ext, 'extension not found in the test host');
    await ext.activate();
  });

  it('is still contributed, since it is the only way out of "compiler not found" from the UI', async () => {
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes('fasm2Studio.selectCompiler'));
  });

  it('asks about executables, not about dialects', () => {
    assert.match(SELECT_COMPILER_PLACEHOLDER, /executable/i);
    assert.doesNotMatch(SELECT_COMPILER_PLACEHOLDER, /which dialect/i);
  });

  it('names the setting each choice writes, so the effect is not a guess', () => {
    const choices = compilerChoices({});
    assert.ok(choices.some((c) => c.detail.includes('fasm2CompilerPath')));
    assert.ok(choices.some((c) => c.detail.includes('fasm1CompilerPath')));
  });

  it('points at Select Dialect for the question it does not answer', () => {
    for (const choice of compilerChoices({})) {
      assert.match(choice.detail, /does not change which dialect/i);
      assert.match(choice.detail, /Select Dialect/);
    }
  });

  it('shows what each dialect currently resolves to, which is what makes it about executables', () => {
    const choices = compilerChoices({
      fasm2: { path: '/usr/bin/fasm2', autoDetected: true },
      fasm1: undefined,
    });

    const fasm2 = choices.find((c) => c.dialect === 'fasm2');
    const fasm1 = choices.find((c) => c.dialect === 'fasm1');
    assert.strictEqual(fasm2!.description, '/usr/bin/fasm2 (auto-detected)');
    assert.strictEqual(fasm1!.description, 'not found');
  });

  it('does not mark an explicitly configured path as auto-detected', () => {
    const choices = compilerChoices({ fasm2: { path: '/opt/fasm2/fasm2', autoDetected: false } });
    assert.strictEqual(choices.find((c) => c.dialect === 'fasm2')!.description, '/opt/fasm2/fasm2');
  });
});
