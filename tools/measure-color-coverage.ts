// Measures how much of a real .asm file actually ends up coloured, by resolving every character
// through the same two layers VS Code does: the TextMate grammar, then the semantic tokens layered
// over it. A grammar can look complete and still leave half a file at the editor's default
// foreground -- that share is the number this reports, and it is the only honest way to tell
// whether a scope change improved anything or just moved names around.
//
// Not a CI test: it reads real fasmg/fasm2/KolibriOS trees that live outside this repo.
//
//   npx tsx tools/measure-color-coverage.ts \
//     --theme <theme.json> [--theme ...] \
//     --files <a.asm> [b.asm ...] \
//     [--include-path <dir>] [--preload <file.inc>] [--semantic=off] [--json]

import * as fs from 'fs';
import * as path from 'path';
import * as oniguruma from 'vscode-oniguruma';
import * as vsctm from 'vscode-textmate';
import { URI } from 'vscode-uri';
import { getSemanticTokens, SEMANTIC_TOKENS_LEGEND } from '../server/src/features/semanticTokens';
import { Workspace } from '../server/src/workspace';

const REPO = path.join(__dirname, '..');
const GRAMMAR_PATH = path.join(REPO, 'extension', 'syntaxes', 'fasm.tmLanguage.json');
const MANIFEST_PATH = path.join(REPO, 'extension', 'package.json');

/** Two colours closer than this in plain RGB distance read as the same colour on screen. Dark+
 * paints `entity.name.label` #C8C8C8 against a #D4D4D4 default foreground -- a distance of 20.8,
 * which an equality test scores as "coloured" and an actual reader scores as "white". */
const INDISTINGUISHABLE = 24;

// ---------------------------------------------------------------------------------------------
// Themes

interface ThemeRule {
  scope: string;
  foreground: string;
  /** Position in the flattened rule list; later wins ties, as in VS Code. */
  order: number;
}

interface Theme {
  name: string;
  defaultForeground: string;
  rules: ThemeRule[];
  /** The theme's own semanticTokenColors, which take precedence over any probe scope. */
  semanticTokenColors: Record<string, string>;
  semanticHighlighting: boolean;
}

/** Themes ship as JSONC. Strips line comments and trailing commas, leaving strings alone. */
function parseJsonc(text: string): unknown {
  let out = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      out += c;
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      continue;
    }
    if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i++;
      continue;
    }
    out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

interface RawTheme {
  include?: string;
  colors?: Record<string, string>;
  semanticHighlighting?: boolean;
  semanticTokenColors?: Record<string, string | { foreground?: string }>;
  tokenColors?: Array<{ scope?: string | string[]; settings?: { foreground?: string } }>;
}

function loadTheme(themePath: string): Theme {
  // `include` chains outward (dark_modern -> dark_plus -> dark_vs); the outermost file's rules must
  // come last so they win ties against the ones they inherit.
  const chain: RawTheme[] = [];
  let current: string | undefined = themePath;
  while (current) {
    const raw = parseJsonc(fs.readFileSync(current, 'utf8')) as RawTheme;
    chain.unshift(raw);
    current = raw.include ? path.join(path.dirname(current), raw.include) : undefined;
  }

  const rules: ThemeRule[] = [];
  const semanticTokenColors: Record<string, string> = {};
  let defaultForeground = '#000000';
  let semanticHighlighting = false;

  for (const raw of chain) {
    if (raw.colors?.['editor.foreground']) defaultForeground = raw.colors['editor.foreground'];
    if (raw.semanticHighlighting) semanticHighlighting = true;
    for (const [selector, value] of Object.entries(raw.semanticTokenColors ?? {})) {
      const fg = typeof value === 'string' ? value : value.foreground;
      if (fg) semanticTokenColors[selector] = fg;
    }
    for (const rule of raw.tokenColors ?? []) {
      const fg = rule.settings?.foreground;
      if (!fg || rule.scope === undefined) continue;
      const scopes = Array.isArray(rule.scope) ? rule.scope : rule.scope.split(',');
      for (const scope of scopes) {
        const trimmed = scope.trim();
        // Descendant selectors ("string meta.image.inline.markdown") need the whole scope path to
        // evaluate; they are a rounding error here and are skipped rather than approximated.
        if (!trimmed || trimmed.includes(' ')) continue;
        rules.push({ scope: trimmed, foreground: fg, order: rules.length });
      }
    }
  }

  return { name: path.basename(themePath, '.json'), defaultForeground, rules, semanticTokenColors, semanticHighlighting };
}

/** True when `rule` is `scope` or one of its dot-separated ancestors. */
function scopeMatches(rule: string, scope: string): boolean {
  return scope === rule || scope.startsWith(rule + '.');
}

function segmentCount(scope: string): number {
  return scope.split('.').length;
}

/** The colour one TextMate scope alone would get, or undefined if the theme says nothing about it. */
function colourForScope(theme: Theme, scope: string): string | undefined {
  let best: ThemeRule | undefined;
  for (const rule of theme.rules) {
    if (!scopeMatches(rule.scope, scope)) continue;
    if (!best || segmentCount(rule.scope) > segmentCount(best.scope) || (segmentCount(rule.scope) === segmentCount(best.scope) && rule.order > best.order)) {
      best = rule;
    }
  }
  return best?.foreground;
}

/** VS Code resolves a token's colour from the innermost scope the theme has anything to say about,
 * not from the outermost -- `source.fasm` would otherwise answer for every token in the file. */
function colourForScopeStack(theme: Theme, scopes: string[]): string | undefined {
  for (let i = scopes.length - 1; i >= 0; i--) {
    const colour = colourForScope(theme, scopes[i]);
    if (colour) return colour;
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// Colours

function parseHex(colour: string): [number, number, number] {
  const hex = colour.replace('#', '');
  return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];
}

function distance(a: string, b: string): number {
  const [r1, g1, b1] = parseHex(a);
  const [r2, g2, b2] = parseHex(b);
  return Math.sqrt((r1 - r2) ** 2 + (g1 - g2) ** 2 + (b1 - b2) ** 2);
}

// ---------------------------------------------------------------------------------------------
// Semantic tokens

/** VS Code's own defaults, from its tokenClassificationRegistry -- the probe scopes a semantic
 * token falls back to when neither the theme nor an extension says anything more specific. Only
 * the entries reachable from this extension's legend are listed. */
const BUILTIN_PROBES: Record<string, string[]> = {
  keyword: ['keyword.control'],
  variable: ['variable.other.readwrite', 'entity.name.variable'],
  macro: ['entity.name.function.preprocessor'],
  function: ['entity.name.function', 'support.function'],
  property: ['variable.other.property'],
  struct: ['entity.name.type.struct'],
  'variable.readonly': ['variable.other.constant'],
  'variable.defaultLibrary': ['support.variable', 'support.other.variable'],
  'function.defaultLibrary': ['support.function'],
};

interface ManifestProbes {
  [selector: string]: string[];
}

function loadManifestProbes(): ManifestProbes {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  const out: ManifestProbes = {};
  for (const entry of manifest.contributes?.semanticTokenScopes ?? []) {
    if (entry.language !== 'fasm') continue;
    Object.assign(out, entry.scopes ?? {});
  }
  return out;
}

/** Every selector a token with this type and these modifiers can match, most specific first. */
function selectorsFor(type: string, modifiers: string[]): string[] {
  const out = modifiers.map((m) => `${type}.${m}`);
  out.push(type);
  return out;
}

function semanticColour(theme: Theme, probes: ManifestProbes, type: string, modifiers: string[]): string | undefined {
  for (const selector of selectorsFor(type, modifiers)) {
    // The theme's own semanticTokenColors outrank any probe scope.
    if (theme.semanticTokenColors[selector]) return theme.semanticTokenColors[selector];
  }
  for (const selector of selectorsFor(type, modifiers)) {
    const list = probes[selector] ?? BUILTIN_PROBES[selector];
    if (!list) continue;
    // resolveScopes returns on the first probe the theme styles at all.
    for (const scope of list) {
      const colour = colourForScope(theme, scope);
      if (colour) return colour;
    }
  }
  return undefined;
}

interface SemanticToken {
  line: number;
  startChar: number;
  length: number;
  type: string;
  modifiers: string[];
}

function decodeSemanticTokens(data: number[]): SemanticToken[] {
  const out: SemanticToken[] = [];
  let line = 0;
  let char = 0;
  for (let i = 0; i < data.length; i += 5) {
    line += data[i];
    char = data[i] === 0 ? char + data[i + 1] : data[i + 1];
    const modifiers = SEMANTIC_TOKENS_LEGEND.tokenModifiers.filter((_, bit) => (data[i + 4] & (1 << bit)) !== 0);
    out.push({ line, startChar: char, length: data[i + 2], type: SEMANTIC_TOKENS_LEGEND.tokenTypes[data[i + 3]], modifiers });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Measurement

interface FileResult {
  file: string;
  nonWhitespace: number;
  atDefault: number;
  indistinguishable: number;
  /** Characters left uncoloured, by the scope that owned them. */
  buckets: Map<string, number>;
}

async function loadGrammar(): Promise<vsctm.IGrammar> {
  const wasm = fs.readFileSync(path.join(REPO, 'node_modules', 'vscode-oniguruma', 'release', 'onig.wasm'));
  await oniguruma.loadWASM(wasm.buffer as ArrayBuffer);
  const registry = new vsctm.Registry({
    onigLib: Promise.resolve({
      createOnigScanner: (patterns: string[]) => new oniguruma.OnigScanner(patterns),
      createOnigString: (s: string) => new oniguruma.OnigString(s),
    }),
    loadGrammar: async (scopeName: string) => (scopeName === 'source.fasm' ? vsctm.parseRawGrammar(fs.readFileSync(GRAMMAR_PATH, 'utf8'), GRAMMAR_PATH) : null),
  });
  const grammar = await registry.loadGrammar('source.fasm');
  if (!grammar) throw new Error('failed to load source.fasm');
  return grammar;
}

interface Options {
  themes: string[];
  files: string[];
  includePaths: string[];
  preload: string;
  semantic: boolean;
  json: boolean;
}

function measure(grammar: vsctm.IGrammar, theme: Theme, probes: ManifestProbes, file: string, opts: Options): FileResult {
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split(/\r?\n/);

  // Layer 1: the grammar. One colour slot per character, plus the scope that produced it so an
  // uncoloured character can be attributed to a rule rather than just counted.
  const colours: Array<string | undefined> = [];
  const owners: string[] = [];
  const offsets: number[] = [];
  let offset = 0;
  let ruleStack: vsctm.StateStack = vsctm.INITIAL;

  for (const line of lines) {
    offsets.push(offset);
    const result = grammar.tokenizeLine(line, ruleStack);
    ruleStack = result.ruleStack;
    for (const token of result.tokens) {
      const colour = colourForScopeStack(theme, token.scopes);
      const owner = token.scopes[token.scopes.length - 1];
      for (let i = token.startIndex; i < token.endIndex; i++) {
        colours[offset + i] = colour;
        owners[offset + i] = owner;
      }
    }
    offset += line.length + 1;
  }

  // Layer 2: semantic tokens, which the editor paints over the grammar's output.
  if (opts.semantic) {
    const uri = URI.file(path.resolve(file)).toString();
    const ws = new Workspace();
    if (opts.includePaths.length) ws.setIncludeSearchPaths(opts.includePaths);
    if (opts.preload) ws.setPreloadInclude(opts.preload);
    ws.updateDocument(uri, 1, text, 'fasm2');
    for (const token of decodeSemanticTokens(getSemanticTokens(ws, uri, 'fasm2', text).data)) {
      const colour = semanticColour(theme, probes, token.type, token.modifiers);
      if (!colour) continue;
      const start = offsets[token.line] + token.startChar;
      for (let i = start; i < start + token.length; i++) {
        colours[i] = colour;
        owners[i] = `semantic:${[token.type, ...token.modifiers].join('.')}`;
      }
    }
  }

  const buckets = new Map<string, number>();
  let nonWhitespace = 0;
  let atDefault = 0;
  let indistinguishable = 0;

  for (let i = 0; i < text.length; i++) {
    if (/\s/.test(text[i])) continue;
    nonWhitespace++;
    const colour = colours[i];
    const isDefault = colour === undefined || colour.toLowerCase().slice(0, 7) === theme.defaultForeground.toLowerCase().slice(0, 7);
    if (isDefault) {
      atDefault++;
      const owner = owners[i] ?? 'source.fasm';
      buckets.set(owner, (buckets.get(owner) ?? 0) + 1);
    }
    if (isDefault || distance(colour!, theme.defaultForeground) < INDISTINGUISHABLE) indistinguishable++;
  }

  return { file: path.basename(file), nonWhitespace, atDefault, indistinguishable, buckets };
}

function parseArgs(argv: string[]): Options {
  const opts: Options = { themes: [], files: [], includePaths: [], preload: '', semantic: true, json: false };
  let mode: 'files' | 'include' | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--theme') {
      opts.themes.push(argv[++i]);
      mode = undefined;
    } else if (arg === '--files') mode = 'files';
    else if (arg === '--include-path') mode = 'include';
    else if (arg === '--preload') {
      opts.preload = argv[++i];
      mode = undefined;
    } else if (arg === '--semantic=off') opts.semantic = false;
    else if (arg === '--json') opts.json = true;
    else if (arg.startsWith('--')) throw new Error(`unknown flag ${arg}`);
    else if (mode === 'files') opts.files.push(arg);
    else if (mode === 'include') opts.includePaths.push(arg);
    else throw new Error(`unexpected argument ${arg}`);
  }
  if (!opts.themes.length || !opts.files.length) throw new Error('need at least one --theme and one --files entry');
  return opts;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const grammar = await loadGrammar();
  const probes = loadManifestProbes();
  const report: Record<string, Record<string, { atDefault: number; indistinguishable: number }>> = {};

  for (const themePath of opts.themes) {
    const theme = loadTheme(themePath);
    report[theme.name] = {};
    console.log(`\n=== ${theme.name}  (default fg ${theme.defaultForeground}, semanticHighlighting: ${theme.semanticHighlighting}, semantic layer: ${opts.semantic ? 'on' : 'off'})`);
    console.log('  file'.padEnd(34) + 'chars'.padStart(9) + 'at default'.padStart(13) + 'indistinct'.padStart(13));

    const totals = new Map<string, number>();
    for (const file of opts.files) {
      const r = measure(grammar, theme, probes, file, opts);
      report[theme.name][r.file] = {
        atDefault: +((100 * r.atDefault) / r.nonWhitespace).toFixed(1),
        indistinguishable: +((100 * r.indistinguishable) / r.nonWhitespace).toFixed(1),
      };
      const pct = (n: number) => `${((100 * n) / r.nonWhitespace).toFixed(1)} %`;
      console.log(`  ${r.file.padEnd(32)}${String(r.nonWhitespace).padStart(9)}${pct(r.atDefault).padStart(13)}${pct(r.indistinguishable).padStart(13)}`);
      for (const [scope, n] of r.buckets) totals.set(scope, (totals.get(scope) ?? 0) + n);
    }

    const top = [...totals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
    console.log('  uncoloured by scope:');
    for (const [scope, n] of top) console.log(`    ${String(n).padStart(7)}  ${scope}`);
  }

  if (opts.json) console.log('\n' + JSON.stringify(report, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
