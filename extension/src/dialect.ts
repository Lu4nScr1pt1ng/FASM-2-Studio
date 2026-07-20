import { Dialect } from './types';

// Mirrors server/src/dialect.ts. Kept as a small standalone copy rather than a shared package:
// the two workspaces stay independently buildable/publishable, and the heuristic is ~10 lines.
const FASM2_MARKERS = /\bend\s+macro\b|\bcalminstruction\b|\biterate\b|\bnamespace\b|\birp[sv]?\b|\bend\s+repeat\b/i;
const FASM1_MARKERS = /\buse(16|32|64)\b|\brept\b|\bendp\b/i;

export function detectDialect(text: string, fallback: Dialect): Dialect {
  const isFasm2 = FASM2_MARKERS.test(text);
  const isFasm1 = FASM1_MARKERS.test(text);
  if (isFasm2 && !isFasm1) return 'fasm2';
  if (isFasm1 && !isFasm2) return 'fasm1';
  return fallback;
}
