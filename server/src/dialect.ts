import { Dialect } from './types';

// fasmg (fasm2) introduced the generic macro engine: block-closing "end macro"/"end repeat",
// CALM instruction definitions, "iterate" and "namespace" have no fasm1 equivalent, so their
// presence is an unambiguous fasm2 signal.
//
// There used to be a matching FASM1_MARKERS set ("use16/32/64", "rept", "endp"), but testing
// against fasmg's own real example tree (packages/x86/examples/windows/*, core/source/dos/*,
// packages/x86/examples/longmode/*) showed every one of those is also a legitimate macro name
// defined by fasmg's own official x86 packages (80386.inc/x64.inc define use16/use32/use64;
// win32 example code defines proc/endp the same way fasm1's win32 package does) — so matching
// them was actively misclassifying real fasmg files as fasm1, which then hid fasm2-only hover
// content and directive completions for those files. No replacement marker was found that's
// reliably fasm1-only without the same risk, so an unrecognized file now just falls back to the
// configured default dialect — a wrong guess would misfire highlighting/directive filtering, so
// silence (falling back) is safer than a confident wrong answer.
const FASM2_MARKERS = /\bend\s+macro\b|\bcalminstruction\b|\biterate\b|\bnamespace\b|\birpv?\b|\bend\s+repeat\b/i;

export function detectDialect(text: string, fallback: Dialect): Dialect {
  return FASM2_MARKERS.test(text) ? 'fasm2' : fallback;
}
