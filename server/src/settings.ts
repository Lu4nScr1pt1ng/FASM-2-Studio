// Per-folder settings resolution.
//
// Every setting this extension contributes is `resource`- or `machine-overridable`-scoped, which
// means VS Code resolves it against the workspace folder a given file belongs to. The server has
// to honour that or the scoping is a lie: a workspace holding a fasm1 project and a fasm2 project
// side by side would compile both with whichever folder's `defaultDialect` happened to win, and
// report a screenful of errors on the one that lost.
//
// The cache is keyed by *workspace folder*, not by file, because that is the granularity VS Code
// actually resolves at — one `workspace/configuration` round-trip per folder answers for every
// file inside it, instead of one per file across a 20k-file index.
//
// The push model (`workspace/didChangeConfiguration` carrying the whole section) is kept as the
// fallback for two real cases: a client that does not advertise `workspace.configuration`, and the
// window before the first pull for a folder has resolved. Both degrade to "the window-wide value",
// which is exactly the behaviour this module replaces — never worse than it.

import { Connection } from 'vscode-languageserver/node';
import { InlayHintMode } from './features/inlayHints';
import { Dialect } from './types';

export interface FasmSettings {
  defaultDialect: Dialect;
  fasm2CompilerPath: string;
  fasm1CompilerPath: string;
  diagnosticsEnabled: boolean;
  diagnosticsDebounceMs: number;
  includePath: string;
  fasm2Preload: string;
  /** See features/inlayHints.ts. Typed as the plain string union the client sends; anything
   * unrecognized is treated as "off" at the point of use rather than validated here. */
  inlayHints: InlayHintMode;
  formatMnemonicColumn: number;
  formatOperandColumn: number;
  formatCommentColumn: number;
}

export const DEFAULT_SETTINGS: FasmSettings = {
  defaultDialect: 'fasm2',
  fasm2CompilerPath: '',
  fasm1CompilerPath: '',
  diagnosticsEnabled: true,
  diagnosticsDebounceMs: 400,
  includePath: '',
  fasm2Preload: '',
  inlayHints: 'off',
  formatMnemonicColumn: 8,
  formatOperandColumn: 16,
  formatCommentColumn: 0,
};

/**
 * The nested `fasm2Studio.format.*` settings arrive from the client as a nested object
 * (`{ format: { mnemonicColumn: 8 } }`), not as flat `format.mnemonicColumn` keys — so they need
 * lifting onto FasmSettings rather than spreading straight in.
 */
export function flattenIncoming(incoming: Partial<FasmSettings> & { format?: Record<string, unknown> }): Partial<FasmSettings> {
  const { format, ...rest } = incoming;
  if (!format) return rest;
  const number = (value: unknown, fallback: number): number => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback);
  return {
    ...rest,
    formatMnemonicColumn: number(format.mnemonicColumn, DEFAULT_SETTINGS.formatMnemonicColumn),
    formatOperandColumn: number(format.operandColumn, DEFAULT_SETTINGS.formatOperandColumn),
    formatCommentColumn: number(format.commentColumn, DEFAULT_SETTINGS.formatCommentColumn),
  };
}

export const CONFIG_SECTION = 'fasm2Studio';

/** Splits a `fasm2Studio.includePath` value into its individual directories. */
export function splitIncludePath(value: string): string[] {
  return value
    .split(';')
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

/**
 * Longest-prefix match of `uri` against the known workspace folder URIs. Longest wins so a folder
 * nested inside another one (a legitimate multi-root layout) resolves to the inner folder's own
 * settings rather than its parent's.
 */
export function folderForUri(uri: string, folderUris: readonly string[]): string | undefined {
  let best: string | undefined;
  for (const folder of folderUris) {
    const prefix = folder.endsWith('/') ? folder : `${folder}/`;
    if ((uri === folder || uri.startsWith(prefix)) && (best === undefined || folder.length > best.length)) {
      best = folder;
    }
  }
  return best;
}

export class SettingsStore {
  /** The push-model value: the window-wide resolution of the section, and the fallback for any
   * folder whose own pull has not landed yet (or whose client cannot do pulls at all). */
  private windowSettings: FasmSettings = DEFAULT_SETTINGS;
  /** folder uri (or '' for "no folder / window scope") -> that folder's resolved settings. */
  private readonly byFolder = new Map<string, FasmSettings>();
  private readonly inFlight = new Map<string, Promise<FasmSettings>>();
  private folderUris: string[] = [];
  private pullSupported = false;

  constructor(private readonly connection: Connection) {}

  setPullSupported(supported: boolean): void {
    this.pullSupported = supported;
  }

  setWorkspaceFolders(uris: string[]): void {
    this.folderUris = uris;
    // A folder that just left the workspace should not keep answering for files under its path.
    for (const key of [...this.byFolder.keys()]) {
      if (key !== '' && !uris.includes(key)) this.byFolder.delete(key);
    }
  }

  workspaceFolders(): readonly string[] {
    return this.folderUris;
  }

  /** Applies a push-model `didChangeConfiguration` payload and drops every cached pull, so the
   * next read of any folder re-resolves. */
  applyPushedSettings(incoming: (Partial<FasmSettings> & { format?: Record<string, unknown> }) | undefined): void {
    this.windowSettings = { ...DEFAULT_SETTINGS, ...flattenIncoming(incoming ?? {}) };
    this.byFolder.clear();
    this.inFlight.clear();
  }

  /**
   * The settings for `uri`, synchronously. Returns the folder's resolved values once its pull has
   * landed, and the window-wide values until then — never blocks an interactive request (hover,
   * completion, a keystroke-triggered reparse) on a client round-trip.
   */
  get(uri: string): FasmSettings {
    const folder = folderForUri(uri, this.folderUris) ?? '';
    return this.byFolder.get(folder) ?? this.windowSettings;
  }

  /**
   * The settings for `uri`, resolving the folder's own values first if they are not cached yet.
   * Used by the paths that are already asynchronous and where precision matters most — deciding
   * which compiler binary actually runs against a file.
   */
  async resolve(uri: string): Promise<FasmSettings> {
    const folder = folderForUri(uri, this.folderUris) ?? '';
    const cached = this.byFolder.get(folder);
    if (cached) return cached;
    if (!this.pullSupported) return this.windowSettings;

    const existing = this.inFlight.get(folder);
    if (existing) return existing;

    const promise = this.pull(folder).finally(() => this.inFlight.delete(folder));
    this.inFlight.set(folder, promise);
    return promise;
  }

  private async pull(folder: string): Promise<FasmSettings> {
    try {
      const result = (await this.connection.workspace.getConfiguration({
        scopeUri: folder === '' ? undefined : folder,
        section: CONFIG_SECTION,
      })) as (Partial<FasmSettings> & { format?: Record<string, unknown> }) | null;
      const resolved: FasmSettings = { ...DEFAULT_SETTINGS, ...flattenIncoming(result ?? {}) };
      this.byFolder.set(folder, resolved);
      return resolved;
    } catch {
      // A client that advertises the capability but fails the request still has to get *some*
      // answer; the window-wide value is the same one the push model would have given.
      return this.windowSettings;
    }
  }

  /**
   * Every folder's `includePath` directories, unioned, plus the window-wide value.
   *
   * The workspace *index* (unlike a compile) has no single file it is acting on behalf of — it
   * answers cross-file queries over every folder at once — so it takes the union rather than any
   * one folder's value. That is strictly more correct than the previous single window-wide value:
   * the worst case is that an `include` resolves through a sibling project's directory, which
   * costs nothing (it only ever adds symbols to a lookup), whereas missing a directory blanks out
   * the include graph for that whole project.
   */
  allIncludeSearchPaths(): string[] {
    const all = new Set<string>(splitIncludePath(this.windowSettings.includePath));
    for (const settings of this.byFolder.values()) {
      for (const dir of splitIncludePath(settings.includePath)) all.add(dir);
    }
    return [...all];
  }

  /** The preload include to use for index-wide analysis. Folder values win over the window-wide
   * one when any folder sets it, since a project that needs a preload is unusable without it. */
  indexPreloadInclude(): string {
    for (const settings of this.byFolder.values()) {
      const value = settings.fasm2Preload.trim();
      if (value) return value;
    }
    return this.windowSettings.fasm2Preload.trim();
  }

  /** Pre-resolves every known folder, so the synchronous `get` path is accurate from the start
   * rather than serving window-wide values until something happens to await `resolve`. */
  async warmAll(): Promise<void> {
    if (!this.pullSupported) return;
    await Promise.all(this.folderUris.map((folder) => this.resolve(folder).catch(() => undefined)));
    if (this.folderUris.length === 0) await this.resolve('').catch(() => undefined);
  }
}
