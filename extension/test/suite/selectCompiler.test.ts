// "FASM: Select Compiler". The wording is the point of these tests: its first step asks which of
// the two path settings to write, and phrased loosely that reads as "which dialect is this
// project?" — a question it does not answer and must not appear to.
//
// The ordering is the other half. This command is what the status bar's "compiler not found" leads
// to, so the state it is most often reached in is the one where every browse entry is useless —
// there is no assembler on the machine to browse to.
import * as assert from 'assert';
import * as vscode from 'vscode';
import {
  CompilerChoice,
  compilerChoices,
  NO_COMPILER_PLACEHOLDER,
  SELECT_COMPILER_PLACEHOLDER,
  selectCompilerPlaceholder,
} from '../../src/selectCompiler';
import { Dialect } from '../../src/types';

/** The entry that browses for `dialect`'s executable. */
function browseFor(choices: CompilerChoice[], dialect: Dialect): CompilerChoice | undefined {
  return choices.find((c) => c.action.kind === 'browse' && c.action.dialect === dialect);
}

const INSTALLED = { fasm2: { path: '/usr/bin/fasm2', autoDetected: true }, fasm1: undefined };

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
    assert.ok(browseFor(choices, 'fasm2')!.detail.includes('fasm2CompilerPath'));
    assert.ok(browseFor(choices, 'fasm1')!.detail.includes('fasm1CompilerPath'));
  });

  it('points at Select Dialect for the question it does not answer', () => {
    for (const choice of compilerChoices({}).filter((c) => c.action.kind === 'browse')) {
      assert.match(choice.detail, /does not change which dialect/i);
      assert.match(choice.detail, /Select Dialect/);
    }
  });

  it('shows what each dialect currently resolves to, which is what makes it about executables', () => {
    const choices = compilerChoices(INSTALLED);

    assert.strictEqual(browseFor(choices, 'fasm2')!.description, '/usr/bin/fasm2 (auto-detected)');
    assert.strictEqual(browseFor(choices, 'fasm1')!.description, 'not found');
  });

  it('does not mark an explicitly configured path as auto-detected', () => {
    const choices = compilerChoices({ fasm2: { path: '/opt/fasm2/fasm2', autoDetected: false } });
    assert.strictEqual(browseFor(choices, 'fasm2')!.description, '/opt/fasm2/fasm2');
  });

  describe('when nothing is installed at all', () => {
    // The dead end this whole ordering exists to remove: every entry used to open a file dialog,
    // so the one user guaranteed to arrive here — status bar says "compiler not found" because
    // they have never installed an assembler — was sent to browse a filesystem with nothing on it.
    it('leads with where to get one, not with browsing for a file that does not exist', () => {
      assert.strictEqual(compilerChoices({})[0].action.kind, 'walkthrough');
      assert.strictEqual(compilerChoices({})[1].action.kind, 'rescan');
    });

    it('admits it found nothing in the prompt, instead of asking which executable to point at', () => {
      assert.strictEqual(selectCompilerPlaceholder({}), NO_COMPILER_PLACEHOLDER);
      assert.match(NO_COMPILER_PLACEHOLDER, /no assembler found/i);
    });

    // Installing an assembler in another window and coming back is the ordinary way out of this
    // state, and detection is cached for the whole session — so the entry that clears that cache
    // has to be reachable from here rather than only from a language server restart.
    it('offers a re-detect, since the cached "not found" outlives the install that fixes it', () => {
      assert.ok(compilerChoices({}).some((c) => c.action.kind === 'rescan'));
    });
  });

  describe('when an assembler is already installed', () => {
    it('leads with the executables, keeping the install and re-detect entries out of the way', () => {
      const choices = compilerChoices(INSTALLED);
      assert.strictEqual(choices[0].action.kind, 'browse');
      assert.strictEqual(selectCompilerPlaceholder(INSTALLED), SELECT_COMPILER_PLACEHOLDER);
    });

    // The status bar menu holds the same invariant for the same reason: an entry that appears only
    // in some states is one nobody learns is there.
    it('still offers every entry', () => {
      const kinds = compilerChoices(INSTALLED).map((c) => c.action.kind);
      for (const kind of ['browse', 'walkthrough', 'rescan']) {
        assert.ok(kinds.includes(kind as never), `${kind} is missing`);
      }
    });
  });
});
