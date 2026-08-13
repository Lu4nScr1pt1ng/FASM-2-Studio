import * as assert from 'assert';
import { boundedDistance, closestNames } from '../src/features/spelling';

describe('boundedDistance', () => {
  it('is zero for identical strings', () => {
    assert.strictEqual(boundedDistance('mov', 'mov', 2), 0);
  });

  it('counts substitutions, insertions and deletions alike', () => {
    assert.strictEqual(boundedDistance('mov', 'mow', 2), 1);
    assert.strictEqual(boundedDistance('mov', 'movx', 2), 1);
    assert.strictEqual(boundedDistance('movx', 'mov', 2), 1);
    assert.strictEqual(boundedDistance('kernel', 'kernl', 2), 1);
  });

  it('reports over-budget rather than the true distance once the bound is exceeded', () => {
    // Only the fact that it is too far matters to the caller, so the exact value is not promised —
    // but it must be strictly greater than the bound.
    assert.ok(boundedDistance('mov', 'syscall', 2) > 2);
  });

  it('rejects a length difference bigger than the bound without doing the matrix work', () => {
    assert.ok(boundedDistance('a', 'abcdefgh', 2) > 2);
  });

  it('handles an empty string on either side', () => {
    assert.strictEqual(boundedDistance('', '', 2), 0);
    assert.ok(boundedDistance('', 'mov', 2) >= 3);
  });
});

describe('closestNames', () => {
  const KEYWORDS = ['mov', 'movd', 'movq', 'push', 'pop', 'syscall', 'segment', 'executable'];

  it('finds the nearest names, closest first', () => {
    // "mov", "movd" and "movq" are all one edit from "movv", so all three are genuinely plausible
    // and all three are offered — alphabetically, since nothing separates them.
    assert.deepStrictEqual(closestNames('movv', KEYWORDS).map((s) => s.name), ['mov', 'movd', 'movq']);
  });

  it('puts a closer name ahead of a further one', () => {
    assert.strictEqual(closestNames('sgment', KEYWORDS)[0].name, 'segment');
  });

  it('ranks a case-only match as certain and drops the runners-up', () => {
    assert.deepStrictEqual(closestNames('MOV', KEYWORDS), [{ name: 'mov', distance: 0 }]);
  });

  it('says nothing when the word is already one of the candidates', () => {
    assert.deepStrictEqual(closestNames('push', KEYWORDS), []);
  });

  it('says nothing for a word shorter than three characters', () => {
    assert.deepStrictEqual(closestNames('mo', KEYWORDS), []);
  });

  it('allows two edits only once a name is long enough for that to still be a slip', () => {
    // "executabl" is one edit away; "exectable" is two, and only tolerated at this length.
    assert.deepStrictEqual(closestNames('exectable', KEYWORDS).map((s) => s.name), ['executable']);
    // "sycall" is two edits from "syscall" but only six characters long — below the threshold, so
    // one edit is the most that is accepted and nothing matches.
    assert.deepStrictEqual(closestNames('sycal', KEYWORDS), []);
  });

  it('honours the limit', () => {
    assert.strictEqual(closestNames('mox', KEYWORDS, 2).length <= 2, true);
  });
});
