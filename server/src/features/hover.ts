import { Hover, MarkupKind } from 'vscode-languageserver/node';
import { Dialect } from '../types';
import { Workspace } from '../workspace';
import directivesData from '../data/directives.json';
import instructionsData from '../data/instructions.json';
import registersData from '../data/registers.json';
import { DirectiveEntry, InstructionEntry, RegisterEntry } from '../types';

const directives = directivesData as DirectiveEntry[];
const instructions = instructionsData as InstructionEntry[];
const registers = registersData as RegisterEntry[];

export function getHover(workspace: Workspace, uri: string, dialect: Dialect, word: string): Hover | undefined {
  const lower = word.toLowerCase();

  const ins = instructions.filter((i) => i.mnemonic.toLowerCase() === lower);
  if (ins.length > 0) {
    const body = ins
      .map((i) => `**${i.mnemonic}**${i.operands ? ` \`${i.operands}\`` : ''}  \n${i.summary}${i.isa ? ` _(${i.isa})_` : ''}`)
      .join('\n\n---\n\n');
    return { contents: { kind: MarkupKind.Markdown, value: body } };
  }

  const reg = registers.find((r) => r.name.toLowerCase() === lower);
  if (reg) {
    return {
      contents: { kind: MarkupKind.Markdown, value: `**${reg.name}** — ${reg.group} register, ${reg.bits}-bit` },
    };
  }

  const dir = directives.find((d) => d.name.toLowerCase() === lower && (d.dialect === 'both' || d.dialect === dialect));
  if (dir) {
    return { contents: { kind: MarkupKind.Markdown, value: `**${dir.name}** _(directive)_  \n${dir.summary}` } };
  }

  for (const parsed of workspace.walkIncludeGraph(uri, dialect)) {
    const sym = parsed.symbols.find((s) => s.name === word);
    if (sym) return hoverForSymbol(sym, false);
  }

  // Not reachable via this file's own `include` chain — still worth surfacing as a discovery aid
  // (e.g. a macro defined in a sibling file), but flagged so it's clear it won't just compile.
  const elsewhere = workspace.findSymbolAnywhere(word)[0];
  if (elsewhere) return hoverForSymbol(elsewhere, true);

  return undefined;
}

function hoverForSymbol(sym: { name: string; kind: string; params?: string; value?: string; parentLabel?: string }, notIncluded: boolean): Hover {
  const lines = [`**${sym.name}** _(${sym.kind})_`];
  if (sym.params) lines.push(`params: \`${sym.params}\``);
  if (sym.value) lines.push(`value: \`${sym.value}\``);
  if (sym.parentLabel) lines.push(`scoped to: \`${sym.parentLabel}\``);
  if (notIncluded) lines.push('_defined elsewhere in the workspace — not included in this file_');
  return { contents: { kind: MarkupKind.Markdown, value: lines.join('  \n') } };
}
