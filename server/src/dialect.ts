import { Dialect } from './types';

// fasmg (fasm2) introduced the generic macro engine: block-closing "end macro"/"end repeat",
// CALM instruction definitions, "iterate" and "namespace" have no fasm1 equivalent. Classic
// fasm1 code instead relies on "use16/32/64" mode switches and the "rept" spelling. Neither set
// is exhaustive, so an unrecognized file falls back to the configured default dialect rather than
// guessing further — a wrong guess would misfire highlighting/directive filtering, so silence
// (falling back) is safer than a confident wrong answer.
const FASM2_MARKERS = /\bend\s+macro\b|\bcalminstruction\b|\biterate\b|\bnamespace\b|\birpv?\b|\bend\s+repeat\b/i;
const FASM1_MARKERS = /\buse(16|32|64)\b|\brept\b|\bendp\b/i;

export function detectDialect(text: string, fallback: Dialect): Dialect {
  const isFasm2 = FASM2_MARKERS.test(text);
  const isFasm1 = FASM1_MARKERS.test(text);
  if (isFasm2 && !isFasm1) return 'fasm2';
  if (isFasm1 && !isFasm2) return 'fasm1';
  return fallback;
}
