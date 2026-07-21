import * as path from 'path';
import { Hover, MarkupKind } from 'vscode-languageserver/node';
import { Dialect, SymbolKind } from '../types';
import { Workspace } from '../workspace';
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

export function getHover(workspace: Workspace, uri: string, dialect: Dialect, word: string): Hover | undefined {
  const lower = word.toLowerCase();

  const ins = instructions.filter((i) => i.mnemonic.toLowerCase() === lower);
  if (ins.length > 0) return markdown(renderInstructions(ins));

  const reg = registers.find((r) => r.name.toLowerCase() === lower);
  if (reg) return markdown(renderRegister(reg));

  const size = sizeSpecifiers.find((s) => s.name.toLowerCase() === lower);
  if (size) return markdown(renderTagged(size.name, SIZE_KIND_LABELS[size.kind], size.summary));

  const dir = directives.find((d) => d.name.toLowerCase() === lower && (d.dialect === 'both' || d.dialect === dialect));
  if (dir) return markdown(renderDirective(dir));

  const fmt = formatKeywords.find((f) => f.name.toLowerCase() === lower);
  if (fmt) return markdown(renderTagged(fmt.name, fmt.category, fmt.summary));

  for (const parsed of workspace.walkIncludeGraph(uri, dialect)) {
    const sym = parsed.symbols.find((s) => s.name === word);
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

/** A handful of directives are really CALM (the low-level code-emission language used inside a
 * "calminstruction" block) sub-commands rather than ordinary top-level directives — a more
 * specific, more useful tag than "directive" for exactly these. */
const CALM_COMMANDS: ReadonlySet<string> = new Set(['match', 'assemble', 'arrange', 'compute', 'check', 'emit']);

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

function renderSymbol(sym: SymbolDefinition, hoverUri: string, notIncluded: boolean): string {
  const kindLabel = SYMBOL_KIND_LABELS[sym.kind] ?? sym.kind;
  const lines: string[] = [];

  if (sym.kind === SymbolKind.Macro || sym.kind === SymbolKind.Struct) {
    lines.push(fasmCode(sym.params ? `${sym.name} ${sym.params}` : sym.name), '', `*${kindLabel}*`);
  } else if (sym.kind === SymbolKind.Constant && sym.value) {
    lines.push(fasmCode(`${sym.name} = ${sym.value}`), '', `*${kindLabel}*`);
  } else {
    lines.push(`**${sym.name}** — *${kindLabel}*`);
    if (sym.parentLabel) lines.push('', `Scoped to \`${sym.parentLabel}\``);
  }

  if (sym.uri !== hoverUri) lines.push('', `*Defined in \`${path.posix.basename(sym.uri)}\`*`);
  if (notIncluded) lines.push('', '> **Not included** — defined elsewhere in the workspace, so it won\'t resolve when compiling this file.');

  return lines.join('\n');
}
