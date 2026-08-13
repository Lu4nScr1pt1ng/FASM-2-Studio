// Nearest-name matching for the "did you mean" quick fix.
//
// A misspelled mnemonic is the single most expensive typo in fasm source: the assembler reports
// "illegal instruction", which names the symptom rather than the fix, and the ~1600-entry table
// that holds the right spelling was already in memory the whole time.

/** Below this, a one-character difference is at least as likely to be two genuinely different names
 * ("ax" and "al" are not typos of each other) as a mistake. */
const MIN_WORD_LENGTH = 3;

/** How different a name may be and still be offered. Scaled by length because the same absolute
 * distance means very different things at either end: one substitution in a 3-character mnemonic is
 * most of the word, while two in a 12-character label name is a slip. */
function maxDistanceFor(length: number): number {
  if (length >= 8) return 2;
  return 1;
}

/**
 * Levenshtein distance, abandoned as soon as it is known to exceed `max`.
 *
 * The bound is what makes scanning the whole keyword table per request reasonable: the length
 * pre-check rejects most candidates without any matrix work at all, and the row-minimum check stops
 * the rest early.
 */
export function boundedDistance(a: string, b: string, max: number): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  if (a.length === 0 || b.length === 0) return Math.max(a.length, b.length);

  let previous = new Array<number>(b.length + 1);
  let current = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) previous[j] = j;

  for (let i = 1; i <= a.length; i++) {
    current[0] = i;
    let rowMin = current[0];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + cost);
      if (current[j] < rowMin) rowMin = current[j];
    }
    // No cell in this row is within budget, and distance never decreases as rows are added.
    if (rowMin > max) return max + 1;
    const swap = previous;
    previous = current;
    current = swap;
  }

  return previous[b.length];
}

export interface Suggestion {
  name: string;
  /** 0 for a name that differs only in capitalization. */
  distance: number;
}

/**
 * The closest known names to `word`, best first, or an empty list when nothing is close enough to
 * be worth offering.
 *
 * A pure case difference is ranked ahead of every edit: fasmg is case-sensitive while fasm1 is not,
 * so `MOV` in a fasm2 file is a real and very common mistake with exactly one right answer.
 */
export function closestNames(word: string, candidates: Iterable<string>, limit = 3): Suggestion[] {
  if (word.length < MIN_WORD_LENGTH) return [];
  const lower = word.toLowerCase();
  const max = maxDistanceFor(word.length);

  const found: Suggestion[] = [];
  for (const candidate of candidates) {
    if (candidate === word) return []; // spelled exactly right; there is nothing to suggest
    const candidateLower = candidate.toLowerCase();
    const distance = candidateLower === lower ? 0 : boundedDistance(lower, candidateLower, max);
    if (distance <= max) found.push({ name: candidate, distance });
  }

  found.sort((a, b) => a.distance - b.distance || a.name.localeCompare(b.name));
  // A name that matches but for its capitalization is not a guess among alternatives — it is the
  // answer. Listing edit-distance runners-up beside it (`movd`, `movq` under a mistyped `MOV`)
  // would bury the one fix that is certainly correct.
  const exact = found.filter((s) => s.distance === 0);
  return (exact.length > 0 ? exact : found).slice(0, limit);
}
