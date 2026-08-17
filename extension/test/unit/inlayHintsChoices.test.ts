// The inline-annotations picker: that it offers every mode the setting accepts, and that the
// "why is this showing nothing" explanation names the right precondition. Both are pure, so they
// are asserted here rather than against a running editor.
import * as assert from 'assert';
import packageJson from '../../package.json';
import {
  INLAY_HINTS_MODES,
  inlayHintsChoices,
  inlayHintsSummary,
  InlayHintsMode,
  unmetPrerequisite,
} from '../../src/inlayHintsChoices';

const SETTING_VALUES = packageJson.contributes.configuration.properties['fasm2Studio.inlayHints'].enum as InlayHintsMode[];

describe('inline annotation modes', () => {
  // A mode added to the setting but not here would be unreachable from the picker, and a mode here
  // that the setting does not accept would be written and then rejected by VS Code.
  it('offers exactly the modes the setting accepts', () => {
    assert.deepStrictEqual([...INLAY_HINTS_MODES].sort(), [...SETTING_VALUES].sort());
  });

  it('marks the mode already in effect, so the list says where you are starting from', () => {
    const choices = inlayHintsChoices('bytes');
    assert.deepStrictEqual(
      choices.filter((c) => c.description === 'current').map((c) => c.mode),
      ['bytes'],
    );
  });

  // Off is the one answer that removes something, and the picker is opened from an entry that
  // already says what the current mode is — so it should not be sitting under the cursor.
  it('does not lead with off', () => {
    assert.notStrictEqual(inlayHintsChoices('off')[0].mode, 'off');
  });

  it('shows each mode as what it renders rather than as a description of it', () => {
    const detailFor = (mode: InlayHintsMode) => inlayHintsChoices('off').find((c) => c.mode === mode)!.detail;
    assert.match(detailFor('bytes'), /B8 3C 00 00 00/);
    assert.match(detailFor('address'), /0x00401000/);
    assert.match(detailFor('addressAndSize'), /0x00401000 · 5 bytes/);
  });

  it('summarises every mode for the status bar menu', () => {
    for (const mode of INLAY_HINTS_MODES) {
      assert.ok(inlayHintsSummary(mode).trim().length > 0, `${mode} has no summary`);
    }
    assert.strictEqual(inlayHintsSummary('off'), 'off');
  });
});

describe('why the annotations would show nothing', () => {
  const OK = { trusted: true, diagnosticsEnabled: true, dialect: 'fasm2' as const };

  it('says nothing when all three preconditions hold', () => {
    assert.strictEqual(unmetPrerequisite(OK), undefined);
  });

  it('names each missing precondition', () => {
    assert.match(unmetPrerequisite({ ...OK, trusted: false })!, /not trusted/);
    assert.match(unmetPrerequisite({ ...OK, diagnosticsEnabled: false })!, /live error checking/);
    assert.match(unmetPrerequisite({ ...OK, dialect: 'fasm1' })!, /fasm1/);
  });

  // An untrusted workspace runs no compiler at all, so reporting the diagnostics switch there
  // would send someone to flip a setting that changes nothing until the folder is trusted.
  it('reports the untrusted workspace ahead of the switch it makes irrelevant', () => {
    assert.match(unmetPrerequisite({ trusted: false, diagnosticsEnabled: false, dialect: 'fasm1' })!, /not trusted/);
  });
});
