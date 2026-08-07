// Decides whether a document's instruction set is x86 or something else entirely.
//
// fasmg is a CPU-agnostic macro engine: it has no built-in instruction set at all. Every mnemonic
// a program uses is an ordinary `macro`/`calminstruction` pulled in by `include` — x86 comes from
// packages/x86 (or, under the fasm2 wrapper, from fasm2.inc preloaded via -i), aarch64 from
// packages/aarch64/iset, and a private in-house ISA from wherever its author put it. So "which
// instructions exist here" is a property of the file's own include graph, not of the assembler.
//
// This matters because this extension ships a large hardcoded x86 instruction/register table.
// Applied to an aarch64 file, that table is not merely unhelpful, it is wrong: it answers `mov`
// with x86's "Copy a value between registers, memory and immediates" instead of the aarch64 macro
// actually in scope, and offers `rax`/`eax`/`xmm0` in completion for a CPU that has no such
// registers. Detecting a foreign ISA lets those two tables be switched off, at which point the
// include-graph lookups that already exist produce the right answer on their own.
//
// Deliberately NOT a list of known ISA package filenames. fasmg's whole design point is that
// anyone can define an instruction set, so such a list would be permanently incomplete and would
// classify every private or third-party package as x86 by default -- exactly the wrong-answer case
// this exists to prevent. Instead the graph is asked what it actually defines.

import instructionsData from './data/instructions.json';
import { Dialect, InstructionEntry, ParsedDocument, SymbolKind } from './types';

export type Isa = 'x86' | 'foreign';

const x86Mnemonics: ReadonlySet<string> = new Set((instructionsData as InstructionEntry[]).map((i) => i.mnemonic.toLowerCase()));

/**
 * Minimum number of macro definitions before the include graph is considered to be supplying an
 * instruction set at all. Below this, the file is a plain fasm2 source relying on the wrapper's
 * implicit fasm2.inc preload (which the language server never sees, since it is injected on the
 * command line rather than written in the source) -- the historical, overwhelmingly common case,
 * which must keep resolving as x86.
 */
const MIN_ISA_SIZE = 32;

/**
 * How many distinct x86 mnemonics a graph must define to count as carrying the x86 instruction
 * set. This is an absolute count rather than a share of the graph, because a share does not
 * actually separate the cases: fasmg's own core/examples/8051 scores 19/49 = 0.39 while fasm2's
 * bundled include tree scores 0.42 -- a 0.03 margin, far too fine to rely on. 8051 is a classic
 * CISC that spells 19 of its 49 instructions exactly as x86 does (mov, add, inc, dec, mul, div,
 * nop, call, ret, push, pop, jz, jnz, jc, jb, ...), so a high share means "this ISA resembles x86",
 * not "this is x86".
 *
 * Absolute coverage separates them with a wide margin instead, because x86 has ~1400 mnemonics and
 * any real x86 package defines nearly all of them, while another ISA can only coincide on the
 * handful of names it happens to share. Measured across every instruction set fasmg ships:
 * packages/x86 reaches 1303 and fasm2's include tree 1324, against aarch64 25, avr 26, 8051 19,
 * jvm 9 and webassembly 1 -- a fiftyfold gap either side of this threshold.
 */
const MIN_X86_COVERAGE = 64;

/**
 * Fallback for a graph too small to clear MIN_X86_COVERAGE but so overwhelmingly x86 that it can
 * only be an x86 package -- e.g. a project vendoring a trimmed-down subset of the instruction set.
 * Set high enough that no real non-x86 ISA comes close: the highest measured is 8051 at 0.39.
 */
const DOMINANT_X86_SHARE = 0.75;

/**
 * Fewest distinct x86 mnemonics a document must execute, without its graph defining them, before
 * that counts as evidence. Two guards against a single identifier that merely collides with a
 * mnemonic spelling, while staying low enough for small programs: KolibriOS's hello.asm executes
 * only four (call, mov, je, jmp).
 *
 * Chosen by measurement, not taste. Against 749 hand-labelled real files (KolibriOS, fasm2's and
 * fasmg's examples, and fasmg's aarch64/8051/avr/jvm/webassembly plus a third-party z80 port),
 * this rule classifies 743 correctly; a threshold of 6 misclassifies 17, and every variant that
 * weighed x86 usage against foreign-macro usage did worse still, because helper macros are invoked
 * in instruction position exactly like instructions are.
 *
 * The remaining 6 are genuinely undecidable from the source alone, and split both ways: four are
 * tiny KolibriOS files that execute no x86 instruction directly (pure `invoke`/`mcall` glue), and
 * two are z80 files whose package leaves call/inc/or/ret looking undefined. Both directions cost
 * only the accuracy of hover and completion, never correctness of the build.
 */
const MIN_X86_STATEMENT_EVIDENCE = 2;

/**
 * Classifies an already-collected include graph together with the document being judged. Split out
 * from detectIsa so it can be tested directly against fixture documents without a Workspace.
 *
 * `subject` is the document whose ISA is in question; its own instruction usage is the deciding
 * evidence when the graph is ambiguous.
 */
export function classifyIsa(docs: Iterable<ParsedDocument>, subject?: ParsedDocument): Isa {
  const macros = new Set<string>();
  let x86Hits = 0;

  for (const doc of docs) {
    for (const sym of doc.symbols) {
      if (sym.kind !== SymbolKind.Macro) continue;
      const name = sym.name.toLowerCase();
      if (macros.has(name)) continue;
      macros.add(name);
      if (x86Mnemonics.has(name)) x86Hits++;
    }
  }

  // A reachable x86 package settles it outright.
  if (x86Hits >= MIN_X86_COVERAGE) return 'x86';

  // Otherwise, look at what the document actually executes. An x86 mnemonic standing in
  // instruction position that the graph does *not* define can only have come from an instruction
  // set loaded outside the source — which is precisely what fasm2 and fasm1 do — so its presence
  // settles the question regardless of what else the graph contains.
  //
  // This is what separates a foreign instruction set from an ordinary helper-macro library, which
  // the graph alone cannot do: KolibriOS's macros.inc defines 73 macros of which only 5 spell x86
  // mnemonics, statistically indistinguishable from a small ISA package, yet every file using it
  // is plain x86 assembly whose lines begin mov/push/call. Counting graph-defined macros used as
  // statements does *not* work as the opposing signal, because helper macros are invoked in
  // exactly that position too — `mcall`/`stdcall`/`iglobal` outnumber the real instructions in
  // much of KolibriOS. A genuine foreign-ISA file, by contrast, gets all of its mnemonics from its
  // package, so this count is essentially zero there.
  const statements = subject?.statementWords ?? [];
  const x86Evidence = statements.filter((w) => x86Mnemonics.has(w) && !macros.has(w)).length;
  if (x86Evidence >= MIN_X86_STATEMENT_EVIDENCE) return 'x86';

  if (macros.size < MIN_ISA_SIZE) return 'x86';
  return x86Hits / macros.size >= DOMINANT_X86_SHARE ? 'x86' : 'foreign';
}

/** The minimal slice of Workspace this module needs, so that importing it here can't create a
 * runtime import cycle with workspace.ts (which calls invalidateIsaCache). */
interface IncludeGraphSource {
  walkIncludeGraph(uri: string, dialect: Dialect): Generator<ParsedDocument>;
  getDocument(uri: string): ParsedDocument | undefined;
}

const cache = new Map<string, Isa>();

export function detectIsa(workspace: IncludeGraphSource, uri: string, dialect: Dialect): Isa {
  // fasm1 is a fixed x86 assembler with no package mechanism at all -- there is no such thing as
  // a foreign-ISA fasm1 file, so this never needs to walk anything.
  if (dialect === 'fasm1') return 'x86';

  const cached = cache.get(uri);
  if (cached !== undefined) return cached;

  const isa = classifyIsa(workspace.walkIncludeGraph(uri, dialect), workspace.getDocument(uri));
  cache.set(uri, isa);
  return isa;
}

/** Called from Workspace whenever document state changes, since the answer is derived from the
 * include graph and any edit can add or remove an `include` edge. */
export function invalidateIsaCache(): void {
  cache.clear();
}
