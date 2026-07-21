import { Dialect } from './types';

// Mirrors server/src/dialect.ts (see its doc comment for the full rationale). Kept as a small
// standalone copy rather than a shared package: the two workspaces stay independently
// buildable/publishable, and the heuristic is ~5 lines.
//
// There used to be a FASM1_MARKERS set too ("use16/32/64", "rept", "endp"), but testing against
// fasmg's own real example tree showed every one of those is also a legitimate macro name defined
// by fasmg's own official x86 packages — so matching them actively misclassified real fasmg files
// (e.g. any Windows example using "endp") as fasm1, which then picked the wrong compiler/dialect
// for Build/Run/Debug. No replacement marker was found that's reliably fasm1-only, so an
// unrecognized file now just falls back to the configured default dialect.
const FASM2_MARKERS = /\bend\s+macro\b|\bcalminstruction\b|\biterate\b|\bnamespace\b|\birpv?\b|\bend\s+repeat\b/i;

export function detectDialect(text: string, fallback: Dialect): Dialect {
  return FASM2_MARKERS.test(text) ? 'fasm2' : fallback;
}
