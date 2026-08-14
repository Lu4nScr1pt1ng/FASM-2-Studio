// The one sentence a whole-project check leaves behind. It is the entire visible result of a
// command that can run for a minute, so the distinctions it draws — found nothing / stopped early /
// could not run at all — are worth pinning down rather than re-deriving from the wording.
import * as assert from 'assert';
import { CheckAllSummary, summaryMessage } from '../../src/checkAllSummary';

const CLEAN: CheckAllSummary = { checked: 3, skipped: 0, filesWithErrors: 0, errors: 0, failures: [], cancelled: false };

describe('check-all summary', () => {
  it('says so explicitly when everything assembled, since a silent pass reads as nothing happening', () => {
    assert.strictEqual(summaryMessage(CLEAN), 'checked 3 entry points — no errors');
  });

  it('counts errors and the files holding them', () => {
    assert.strictEqual(
      summaryMessage({ ...CLEAN, errors: 5, filesWithErrors: 2 }),
      'checked 3 entry points — 5 errors in 2 files',
    );
  });

  it('keeps singulars singular, because "1 errors in 1 files" is the tell of a generated string', () => {
    assert.strictEqual(
      summaryMessage({ ...CLEAN, checked: 1, errors: 1, filesWithErrors: 1 }),
      'checked 1 entry point — 1 error in 1 file',
    );
  });

  it('never claims a cancelled run found no errors — it stopped, which is not a verdict', () => {
    const message = summaryMessage({ ...CLEAN, cancelled: true });
    assert.strictEqual(message, 'stopped after 3 entry points');
    assert.ok(!message.includes('no errors'));
  });

  it('still reports what a cancelled run did find before it was stopped', () => {
    assert.strictEqual(
      summaryMessage({ ...CLEAN, cancelled: true, errors: 2, filesWithErrors: 1 }),
      'stopped after 3 entry points — 2 errors in 1 file',
    );
  });

  it('accounts for skipped entry points, which explain a count lower than the view shows', () => {
    assert.strictEqual(
      summaryMessage({ ...CLEAN, skipped: 2 }),
      'checked 3 entry points — no errors — 2 already open or unreadable',
    );
  });

  it('reports the standing condition instead of a result when nothing could be assembled at all', () => {
    // "checked 0 entry points — no errors" would be a clean bill of health for a workspace nothing
    // even looked at, which is the one wrong answer this command must never give.
    assert.strictEqual(
      summaryMessage({ ...CLEAN, checked: 0, skipped: 3, unavailable: 'no fasm2 compiler found on PATH' }),
      'nothing could be checked: no fasm2 compiler found on PATH',
    );
  });

  it('still reports the programs it did check when only some were unavailable', () => {
    // One unreadable file does not invalidate the other two compiles, so the result stands and the
    // shortfall shows up in the skipped count.
    assert.strictEqual(
      summaryMessage({ ...CLEAN, checked: 2, skipped: 1, unavailable: 'could not be read (ENOENT)' }),
      'checked 2 entry points — no errors — 1 already open or unreadable',
    );
  });
});
