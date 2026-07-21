import * as path from 'path';
import { Hover, MarkupKind } from 'vscode-languageserver/node';
import { Dialect, SymbolKind } from '../types';
import { pickInScopeSymbol, Workspace } from '../workspace';
import directivesData from '../data/directives.json';
import instructionsData from '../data/instructions.json';
import registersData from '../data/registers.json';
import registerFamiliesData from '../data/registerFamilies.json';
import formatKeywordsData from '../data/formatKeywords.json';
import sizeSpecifiersData from '../data/sizeSpecifiers.json';
import { DirectiveEntry, FormatKeywordEntry, InstructionEntry, RegisterEntry, RegisterFamilyEntry, SizeSpecifierEntry, SymbolDefinition } from '../types';

const directives = directivesData as DirectiveEntry[];
const instructions = instructionsData as InstructionEntry[];
const registers = registersData as RegisterEntry[];
const registerFamilies = registerFamiliesData as RegisterFamilyEntry[];
const formatKeywords = formatKeywordsData as FormatKeywordEntry[];
const sizeSpecifiers = sizeSpecifiersData as SizeSpecifierEntry[];

// Built-in pseudo-variables of the "expression" symbol class — never user-defined, so they have no
// SymbolDefinition anywhere to look up; just a fixed, small set worth documenting directly.
const SPECIAL_SYMBOLS: Record<string, string> = {
  $: 'The current address (position in the output). `NAME = $` is equivalent to placing a label at this exact point.',
  '$$': 'The base address of the current addressing space (the `org`/`section` argument). `$ - $$` gives the current offset from the start of the area.',
  '$@': 'The base address of the current block of uninitialized (reserved) data. Equals `$` when there\'s no such pending block, or `$` minus that block\'s length otherwise.',
  '%': 'Inside `repeat`/`while`/`iterate`, the current repetition number (starting from 1) — substituted as plain text before the line is processed, e.g. `f#%` builds identifiers like `f1`, `f2`, ...',
  '%%': 'Inside `repeat`, the total number of repetitions planned (undefined inside `while`). `db %%-%` produces a descending byte sequence.',
};

// The logical operators used inside "if"/"while"/CALM "check" conditions — a *different*
// expression class from ordinary arithmetic, with its own operators. Only "&" overlaps with
// anything else in the language: on the *last parameter of a macro/struct/calminstruction
// definition* it means something else entirely (see PARAM_MODIFIERS) — real, easy-to-conflate
// ambiguity confirmed against fasmg's own real code, where both usages appear side by side.
const LOGICAL_OPERATORS: Record<string, string> = {
  '~': 'Logical negation, evaluated first (higher precedence than "&"/"|"). `if ~ used name` is true when `name` is *not* used. Only valid inside a logical expression (`if`/`while` condition, CALM `check` argument) — not a general bitwise-NOT for ordinary arithmetic (use the `not` operator there instead).',
  '&': 'Logical conjunction (AND) inside a logical expression (`if`/`while` condition, CALM `check` argument) — evaluated left-to-right with no precedence over `|`. Not the same as the "&" on a macro/struct/calminstruction\'s *last parameter*, which instead means "capture the rest of the line as one value" — and not a general bitwise-AND for ordinary arithmetic either (use the `and` operator there instead).',
  '|': 'Logical alternative (OR) inside a logical expression (`if`/`while` condition, CALM `check` argument) — evaluated left-to-right with no precedence over `&`. Not a general bitwise-OR for ordinary arithmetic (use the `or` operator there instead).',
};

export function getHover(workspace: Workspace, uri: string, dialect: Dialect, word: string, line = 0): Hover | undefined {
  const lower = word.toLowerCase();

  // A bare "?" is one of the most overloaded tokens in fasmg: overwhelmingly, it's the
  // "reserve, uninitialized" value placeholder (e.g. "dd ?", extremely common in every struct
  // and data declaration), but it's *also* literally the name of fasmg's anonymous-macro
  // convention ("macro ? args") — real code confirmed to define one in fasmg's own
  // packages/x86-2/x86-2.inc and packages/x86/include/macro/proc64.inc. A plain name lookup can't
  // tell these apart, and doing one anyway means hovering an ordinary "dd ?" placeholder can
  // surface a completely unrelated file's anonymous-macro definition as if it were relevant —
  // so this is intentionally answered directly instead of falling through to a symbol lookup.
  if (word === '?') {
    return markdown(
      renderTagged(
        '?',
        'Overloaded token',
        'Two unrelated meanings, only distinguishable by context: (1) the "reserve, uninitialized" value placeholder, as in `dd ?` — by far the most common use; (2) the literal name of an anonymous macro (`macro ? args`), a rare, advanced construct that intercepts otherwise-unrecognized lines.',
      ),
    );
  }

  const special = SPECIAL_SYMBOLS[word];
  if (special) return markdown(renderTagged(word, 'Built-in symbol', special));

  const logicalOp = LOGICAL_OPERATORS[word];
  if (logicalOp) return markdown(renderTagged(word, 'Logical operator', logicalOp));

  // An in-scope `local` variable is an unambiguous match tied to exactly this query position —
  // check it before anything context-free like an instruction mnemonic. fasmg's own parser
  // disambiguates a name that's both a mnemonic and a local by syntax position (e.g. "local neg"
  // then later "neg = mode" uses neg as a value, not the NEG instruction, as in fasmg's own
  // packages/x86/include/macro/if.inc), but this lightweight parser doesn't track that context —
  // without this check first, such a local's own hover would be permanently shadowed by the
  // mnemonic's, no matter where you hover it.
  const currentDoc = workspace.getDocument(uri);
  const localHere = currentDoc?.symbols.find(
    (s) => s.name === word && s.localScope && line >= s.localScope.startLine && line <= s.localScope.endLine,
  );
  if (localHere) return markdown(renderSymbol(localHere, uri, false));

  const ins = instructions.filter((i) => i.mnemonic.toLowerCase() === lower);
  if (ins.length > 0) return markdown(renderInstructions(ins));

  const reg = registers.find((r) => r.name.toLowerCase() === lower);
  if (reg) return markdown(renderRegister(reg));

  const size = sizeSpecifiers.find((s) => s.name.toLowerCase() === lower);
  if (size) return markdown(renderSizeSpecifier(size));

  const dir = directives.find((d) => d.name.toLowerCase() === lower && (d.dialect === 'both' || d.dialect === dialect));
  if (dir) return markdown(renderDirective(dir));

  const fmt = formatKeywords.find((f) => f.name.toLowerCase() === lower);
  if (fmt) return markdown(renderTagged(fmt.name, fmt.category, fmt.summary));

  for (const parsed of workspace.walkIncludeGraph(uri, dialect)) {
    const candidates = parsed.symbols.filter((s) => s.name === word);
    const sym = pickInScopeSymbol(candidates, uri, line);
    if (sym) return markdown(renderSymbol(sym, uri, false));
  }

  // Not reachable via this file's own `include` chain — still worth surfacing as a discovery aid
  // (e.g. a macro defined in a sibling file), but flagged so it's clear it won't just compile.
  const elsewhere = workspace.findSymbolAnywhere(word)[0];
  if (elsewhere) return markdown(renderSymbol(elsewhere, uri, true));

  return undefined;
}

function markdown(value: string): Hover {
  return { contents: { kind: MarkupKind.Markdown, value } };
}

/** A fenced ```fasm code block — VS Code tokenizes it with this extension's own "fasm" grammar
 * (the same one used for real editor tabs), so a hover signature reads exactly like the code
 * around it instead of plain unstyled text. */
function fasmCode(...lines: string[]): string {
  return ['```fasm', ...lines, '```'].join('\n');
}

function renderInstructions(entries: InstructionEntry[]): string {
  const blocks = entries.map((i) => {
    const signature = i.operands ? `${i.mnemonic} ${i.operands}` : i.mnemonic;
    return [fasmCode(signature), '', i.summary, '', `*${i.isa ? `${i.isa} instruction` : 'instruction'}*`].join('\n');
  });
  const heading = entries.length > 1 ? [`**${entries.length} forms of \`${entries[0].mnemonic}\`:**`, ''] : [];
  return [...heading, blocks.join('\n\n---\n\n')].join('\n');
}

function renderTagged(name: string, tag: string, summary: string): string {
  return [`**${name}** — *${tag}*`, '', summary].join('\n');
}

const SIZE_KIND_LABELS: Record<SizeSpecifierEntry['kind'], string> = {
  size: 'size specifier',
  addressing: 'addressing qualifier',
};

/**
 * A "size specifier" (dword, qword, ...) and the "d*"/"r*" data directives (dd/rd, dq/rq, ...) of
 * the same width are easy to conflate — they're literally the same byte count — but they're not
 * interchangeable: a size specifier just disambiguates an *existing* operand's width (e.g.
 * "mov dword [rbx], 0"), while a data directive actually declares/reserves memory. Cross-
 * referenced in both directions so hovering either one calls out the distinction.
 */
const SIZE_TO_DATA_DIRECTIVES: Record<string, { declare: string; reserve: string }> = {
  byte: { declare: 'db', reserve: 'rb' },
  word: { declare: 'dw', reserve: 'rw' },
  dword: { declare: 'dd', reserve: 'rd' },
  fword: { declare: 'dp', reserve: 'rp' },
  pword: { declare: 'dp', reserve: 'rp' },
  qword: { declare: 'dq', reserve: 'rq' },
  tbyte: { declare: 'dt', reserve: 'rt' },
  tword: { declare: 'dt', reserve: 'rt' },
  dqword: { declare: 'ddq', reserve: 'rdq' },
  xword: { declare: 'ddq', reserve: 'rdq' },
  qqword: { declare: 'dqq', reserve: 'rqq' },
  yword: { declare: 'dqq', reserve: 'rqq' },
  dqqword: { declare: 'ddqq', reserve: 'rdqq' },
  zword: { declare: 'ddqq', reserve: 'rdqq' },
};

// Written out explicitly (rather than derived from SIZE_TO_DATA_DIRECTIVES) so a directive shared
// by two synonymous sizes (e.g. "dp" backs both "fword" and "pword") points at one specific,
// consistent name instead of whichever happened to be inserted last.
const DATA_DIRECTIVE_TO_SIZE: Record<string, string> = {
  db: 'byte', rb: 'byte',
  dw: 'word', rw: 'word',
  dd: 'dword', rd: 'dword',
  dp: 'fword', rp: 'fword', df: 'fword', rf: 'fword',
  dq: 'qword', rq: 'qword',
  dt: 'tbyte', rt: 'tbyte',
  ddq: 'dqword', rdq: 'dqword',
  dqq: 'qqword', rqq: 'qqword',
  ddqq: 'dqqword', rdqq: 'dqqword',
};

/** A handful of directives are really CALM (the low-level code-emission language used inside a
 * "calminstruction" block) sub-commands rather than ordinary top-level directives — a more
 * specific, more useful tag than "directive" for exactly these. */
const CALM_COMMANDS: ReadonlySet<string> = new Set([
  'match', 'assemble', 'arrange', 'compute', 'check', 'emit',
  'jump', 'jyes', 'jno', 'exit', 'publish', 'transform', 'stringify', 'take', 'taketext', 'call', 'initsym',
]);

/** Converts a completion snippet's tabstop syntax ("${1:name}", "$0") into plain placeholder text
 * readable in a hover — a hover isn't editable, so the tabstop markers themselves are just noise.
 * Also trims now-trailing-blank lines left where a "$0" was the only thing on its line. */
function snippetToExample(snippet: string): string {
  return snippet
    .replace(/\$\{\d+:([^}]*)\}/g, '$1')
    .replace(/\$\{\d+\}/g, '')
    .replace(/\$\d+/g, '')
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''))
    .join('\n');
}

function renderDirective(dir: DirectiveEntry): string {
  const tag = CALM_COMMANDS.has(dir.name) ? 'CALM command' : dir.dialect === 'both' ? 'directive' : `${dir.dialect} directive`;
  const lines = [`**${dir.name}** — *${tag}*`, '', dir.summary];
  if (dir.snippet) lines.push('', fasmCode(snippetToExample(dir.snippet)));

  const relatedSize = DATA_DIRECTIVE_TO_SIZE[dir.name];
  if (relatedSize) lines.push('', `*Not the same as the \`${relatedSize}\` operand-size specifier — this reserves/declares actual memory, not just a size hint.*`);

  return lines.join('\n');
}

function renderSizeSpecifier(size: SizeSpecifierEntry): string {
  const lines = [`**${size.name}** — *${SIZE_KIND_LABELS[size.kind]}*`, '', size.summary];

  const dataDirectives = SIZE_TO_DATA_DIRECTIVES[size.name];
  if (dataDirectives) {
    lines.push('', `*Not the same as the \`${dataDirectives.declare}\`/\`${dataDirectives.reserve}\` data directives (declare/reserve memory of this width) — this just marks an existing operand's size.*`);
  }

  return lines.join('\n');
}

const GROUP_LABELS: Record<string, string> = {
  'general-purpose': 'general-purpose register',
  'instruction-pointer': 'instruction pointer',
  segment: 'segment register',
  control: 'control register',
  debug: 'debug register',
  fpu: 'x87 FPU register',
  mmx: 'MMX register',
  sse: 'SSE register',
  avx: 'AVX register',
  avx512: 'AVX-512 register',
  'avx512-mask': 'AVX-512 mask register',
};

/** One-line explanation per register *group* — shown for every register in that group except
 * general-purpose ones, which get a per-family role instead (see REGISTER_FAMILIES). */
const GROUP_DESCRIPTIONS: Record<string, string> = {
  'instruction-pointer': 'Holds the address of the next instruction to execute; not directly writable except via control-flow instructions (jmp, call, ret, ...).',
  segment: 'Segment selector — largely vestigial in 64-bit long mode, where memory access ignores segment bases except fs/gs.',
  control: 'CPU/paging configuration (privileged; not directly accessible from user-mode code).',
  debug: 'Hardware breakpoint/watchpoint configuration (privileged).',
  fpu: '80-bit extended-precision floating point, addressed as a stack (st0 is always the top).',
  mmx: '64-bit packed-integer SIMD — aliases the x87 FPU registers, so it can\'t be used at the same time as x87 without an `emms`.',
  sse: '128-bit packed/scalar floating-point and integer SIMD.',
  avx: '256-bit packed floating-point/integer SIMD — the lower 128 bits alias the correspondingly-numbered xmm register.',
  avx512: '512-bit packed floating-point/integer SIMD — the lower 256/128 bits alias the correspondingly-numbered ymm/xmm register.',
  'avx512-mask': 'Per-lane predicate register for masked/merged AVX-512 operations.',
};

/** fs/gs specifically are repurposed in 64-bit mode and worth calling out; the rest of the
 * segment group shares the generic GROUP_DESCRIPTIONS text. */
const SEGMENT_NOTES: Record<string, string> = {
  fs: 'Repurposed for thread-local storage (TLS) via a base-address MSR rather than legacy segmentation.',
  gs: 'Repurposed for thread-local storage (TLS) / per-CPU data via a base-address MSR (e.g. the Linux kernel\'s per-CPU GS base) rather than legacy segmentation.',
};

function findRegisterFamily(name: string): { family: RegisterFamilyEntry; width: string } | undefined {
  for (const family of registerFamilies) {
    for (const [width, member] of Object.entries(family.widths)) {
      if (member === name) return { family, width };
    }
    if (family.highByte === name) return { family, width: '8h' };
  }
  return undefined;
}

function renderRegister(reg: RegisterEntry): string {
  const groupLabel = GROUP_LABELS[reg.group] ?? reg.group;
  const lines = [`**${reg.name}** — ${reg.bits}-bit ${groupLabel}`, ''];

  const found = findRegisterFamily(reg.name);
  if (found) {
    lines.push(found.family.role, '');
    const order: Array<'8' | '16' | '32' | '64'> = ['8', '16', '32', '64'];
    const chips = order.map((w) => found.family.widths[w]).filter((n): n is string => n !== undefined);
    const chipsRendered = chips.map((n) => (n === reg.name ? `**\`${n}\`**` : `\`${n}\``)).join(' → ');
    const highByte = found.family.highByte ? `  (high byte: ${found.family.highByte === reg.name ? `**\`${found.family.highByte}\`**` : `\`${found.family.highByte}\``})` : '';
    lines.push(`${chipsRendered}${highByte}`);
  } else {
    const description = reg.group === 'segment' ? (SEGMENT_NOTES[reg.name] ?? GROUP_DESCRIPTIONS.segment) : GROUP_DESCRIPTIONS[reg.group];
    if (description) lines.push(description);
  }

  return lines.join('\n');
}

const SYMBOL_KIND_LABELS: Record<string, string> = {
  [SymbolKind.Label]: 'Label',
  [SymbolKind.LocalLabel]: 'Local label',
  [SymbolKind.Constant]: 'Constant',
  [SymbolKind.Macro]: 'Macro',
  [SymbolKind.Struct]: 'Struct',
  [SymbolKind.Section]: 'Section',
};

// How each constant-definition operator/directive renders its syntax, plus a note on how its
// semantics differ from the plain "=" a reader would otherwise assume — genuinely different
// behaviors (evaluated vs. textual, discarded vs. preserved, once vs. reassignable) that are easy
// to conflate, especially since fasmg's own real code (e.g. proc64.inc) uses several of these side
// by side for exactly that reason.
const DEFINED_VIA_RENDER: Record<NonNullable<SymbolDefinition['definedVia']>, { syntax: (name: string, value: string) => string; note?: string }> = {
  '=': { syntax: (n, v) => `${n} = ${v}` },
  ':=': { syntax: (n, v) => `${n} := ${v}`, note: 'Must be defined exactly once — safe to forward-reference, but reassigning it is an error (unlike "=").' },
  '=:': { syntax: (n, v) => `${n} =: ${v}`, note: 'Preserves the previous value instead of discarding it (unlike "="), restorable later with `restore`.' },
  equ: { syntax: (n, v) => `${n} equ ${v}`, note: 'Textual substitution — re-substituted unevaluated wherever it\'s used, not a stored value.' },
  reequ: { syntax: (n, v) => `${n} reequ ${v}`, note: 'Textual substitution like `equ`, but discards the previous value instead of preserving it.' },
  define: { syntax: (n, v) => `define ${n} ${v}`, note: 'Textual substitution like `equ`, but does not evaluate symbolic variables in the text; preserves the previous value.' },
  redefine: { syntax: (n, v) => `redefine ${n} ${v}`, note: 'Like `define`, but discards the previous value instead of preserving it.' },
  load: { syntax: (n, v) => `load ${n} from ${v}`, note: 'Defines this by reading a string of already-generated bytes back out of an output area (or, addressed via an "::" area label, bytes generated later in that same area).' },
};

/**
 * Explains the parameter modifiers actually present in a macro/struct's raw parameter-list text
 * (e.g. "dest*,src*,imm*", "name:0,flag:11b", "definitions&") — noted once per kind found, not
 * per parameter, matching how the rest of hover keeps this concise rather than exhaustive.
 */
function paramModifierNotes(params: string): string[] {
  const notes: string[] = [];
  if (params.includes('*')) notes.push('`*` — a required argument (an error is raised if the macro is called without it).');
  if (params.includes(':')) notes.push('`:` — followed by a default value, used when that argument is omitted.');
  if (params.endsWith('&')) notes.push('`&` — this last argument captures the entire rest of the line as one value, even if it contains commas (a different "&" from the logical-AND operator inside `if`/`while`/CALM `check`).');
  return notes;
}

function renderSymbol(sym: SymbolDefinition, hoverUri: string, notIncluded: boolean): string {
  const kindLabel = SYMBOL_KIND_LABELS[sym.kind] ?? sym.kind;
  const lines: string[] = [];

  if (sym.kind === SymbolKind.Macro || sym.kind === SymbolKind.Struct) {
    lines.push(fasmCode(sym.params ? `${sym.name} ${sym.params}` : sym.name), '', `*${kindLabel}*`);
    if (sym.isWeak) lines.push('', '*The trailing `?` marks this weak/overridable — it can be redefined later without a "symbol already defined" error (the standard convention for macro packages meant to tolerate being `include`d more than once).*');
    if (sym.isUnconditional) lines.push('', '*The trailing `!` marks this unconditional — evaluated even inside a suspended (false) conditional block or another macro\'s own definition.*');
    if (sym.params) for (const note of paramModifierNotes(sym.params)) lines.push('', `*${note}*`);
  } else if (sym.kind === SymbolKind.Constant && sym.value) {
    const render = DEFINED_VIA_RENDER[sym.definedVia ?? '='];
    lines.push(fasmCode(render.syntax(sym.name, sym.value)), '', `*${kindLabel}*`);
    if (render.note) lines.push('', `*${render.note}*`);
  } else {
    lines.push(`**${sym.name}${sym.isAreaLabel ? '::' : ''}** — *${kindLabel}*`);
    if (sym.parentLabel) lines.push('', `Scoped to \`${sym.parentLabel}\``);
    if (sym.isAreaLabel) {
      lines.push(
        '',
        '*An "area label" (declared with `::` instead of `:`) — its own value isn\'t meant to be used directly. It exists only so `load` can address bytes generated in this area via `' +
          sym.name +
          ':offset`, including bytes generated later in the very same area (unlike plain-address `load`, restricted to bytes already emitted).*',
      );
    }
  }

  if (sym.uri !== hoverUri) lines.push('', `*Defined in \`${path.posix.basename(sym.uri)}\`*`);
  if (notIncluded) lines.push('', '> **Not included** — defined elsewhere in the workspace, so it won\'t resolve when compiling this file.');

  return lines.join('\n');
}
