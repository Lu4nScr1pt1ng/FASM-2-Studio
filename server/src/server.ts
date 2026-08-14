import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  CallHierarchyIncomingCall,
  CallHierarchyIncomingCallsParams,
  CallHierarchyItem,
  CallHierarchyOutgoingCall,
  CallHierarchyOutgoingCallsParams,
  CallHierarchyPrepareParams,
  CodeAction,
  CodeActionKind,
  CodeActionParams,
  CompletionItem,
  CompletionParams,
  createConnection,
  DefinitionParams,
  Diagnostic,
  DidChangeConfigurationParams,
  DocumentFormattingParams,
  DocumentHighlight,
  DocumentHighlightParams,
  DocumentLink,
  DocumentLinkParams,
  DocumentOnTypeFormattingParams,
  DocumentRangeFormattingParams,
  DocumentSymbolParams,
  FileChangeType,
  FoldingRange,
  FoldingRangeParams,
  FormattingOptions,
  Hover,
  HoverParams,
  InitializeParams,
  InitializeResult,
  InlayHint,
  InlayHintParams,
  Location,
  Position,
  PrepareRenameParams,
  ProposedFeatures,
  Range,
  ReferenceParams,
  RenameParams,
  SelectionRange,
  SelectionRangeParams,
  SemanticTokens,
  SemanticTokensParams,
  SignatureHelp,
  SignatureHelpParams,
  SymbolInformation,
  TextDocumentChangeEvent,
  TextDocumentSyncKind,
  TextDocuments,
  TextEdit,
  WorkspaceEdit,
  WorkspaceSymbolParams,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { URI } from 'vscode-uri';
import { invalidateCompilerCache, resolveCompilerOnPath } from './compilerDiscovery';
import { detectDialect } from './dialect';
import { incomingCalls, outgoingCalls, prepareCallHierarchy } from './features/callHierarchy';
import { getCodeActions } from './features/codeActions';
import { getCompletions, resolveCompletionItem } from './features/completion';
import { getDefinitions } from './features/definition';
import { getDocumentHighlights } from './features/documentHighlight';
import { getDocumentLinks } from './features/documentLink';
import { getDocumentSymbols } from './features/documentSymbols';
import { abandonRunningCompilers, noteFirstErrorOnly, runDiagnostics } from './features/diagnostics';
import { detectEol, FormatOptions, formatLines } from './features/format';
import { getFoldingRanges } from './features/foldingRange';
import { bundledListingIncPath, getInlayHints, ListingMapStore, uriToFsPath } from './features/inlayHints';
import { getHover } from './features/hover';
import { getIncludePathCompletions, includePathContext, stringContext } from './features/includePathCompletion';
import { FileRename, includeRenameEdits, IncludeRenameEdits } from './features/includeRename';
import { detectIsa } from './isa';
import { buildLiveShadowRoot } from './features/liveShadow';
import { getReferences } from './features/references';
import { getRenameEdit, isRenameable } from './features/rename';
import { getSelectionRanges } from './features/selectionRange';
import { getSemanticTokens, SEMANTIC_TOKENS_LEGEND } from './features/semanticTokens';
import { getSignatureHelp } from './features/signatureHelp';
import { getWorkspaceSymbols } from './features/workspaceSymbols';
import { buildCandidateSequence, correlateListing } from './listing/listingMap';
import { FasmSettings, SettingsStore, splitIncludePath } from './settings';
import { Dialect } from './types';
import { Workspace } from './workspace';

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);
const workspace = new Workspace();

// Empty compiler path settings mean "auto-detect on PATH", resolved lazily via
// resolveCompilerOnPath — see the comment at its call site in runDiagnosticsFor.
const settingsStore = new SettingsStore(connection);
const dialectCache = new Map<string, Dialect>();
const diagnosticTimers = new Map<string, ReturnType<typeof setTimeout>>();
const diagnosticGenerations = new Map<string, number>();

/** Resolves once the workspace scan kicked off by 'fasm2Studio/indexWorkspaceFiles' finishes;
 * undefined when no scan is currently running. See its use in runDiagnosticsFor. */
let indexingInFlight: Promise<void> | undefined;

/** How long a fragment's diagnostics wait for an in-flight workspace scan to reach its includer(s)
 * before giving up and compiling it standalone anyway — bounds the wait so a stalled or unusually
 * large scan can't hang a single file's diagnostics indefinitely. */
const INDEX_WAIT_TIMEOUT_MS = 5000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function logHandlerError(context: string, err: unknown): void {
  const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
  connection.console.error(`fasm2-studio: ${context} failed: ${detail}`);
}

function resolveDialect(uri: string, text: string): Dialect {
  const dialect = detectDialect(text, settingsStore.get(uri).defaultDialect);
  dialectCache.set(uri, dialect);
  return dialect;
}

function currentDialect(uri: string): Dialect {
  return dialectCache.get(uri) ?? settingsStore.get(uri).defaultDialect;
}

/** Pushes the settings store's current view of include paths / preload into the workspace index.
 * Called after anything that can change either — a pushed config change, or a folder's pulled
 * values landing. */
function syncWorkspaceIndexSettings(): void {
  workspace.setIncludeSearchPaths(settingsStore.allIncludeSearchPaths());
  workspace.setPreloadInclude(settingsStore.indexPreloadInclude());
}

/**
 * Whether the client reported this workspace as trusted. Diagnostics are the one feature here that
 * runs a program — compiling the workspace's own source with a macro assembler that can read and
 * write files — so they stay off until it is. Everything else the server answers is pure analysis
 * of text and runs regardless.
 *
 * Defaults to trusted so a client that sends no initializationOptions at all (any non-VS Code LSP
 * client, and the unit tests) behaves exactly as it did before this existed.
 */
let workspaceTrusted = true;

connection.onInitialize((params: InitializeParams): InitializeResult => {
  const initOptions = params.initializationOptions as { isTrusted?: boolean } | undefined;
  if (typeof initOptions?.isTrusted === 'boolean') workspaceTrusted = initOptions.isTrusted;

  settingsStore.setPullSupported(params.capabilities.workspace?.configuration === true);
  settingsStore.setWorkspaceFolders(
    params.workspaceFolders?.map((f) => f.uri) ?? (params.rootUri ? [params.rootUri] : []),
  );

  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      // resolveProvider: the ~1600-entry static tables ship without their documentation strings
      // and have them filled in per highlighted row instead — see features/completion.ts.
      // The quote/separator triggers are for paths inside `include '...'` (see
      // features/includePathCompletion.ts); onCompletion returns nothing for them anywhere else,
      // so typing a string or a division never pops an unwanted list.
      completionProvider: { resolveProvider: true, triggerCharacters: ['.', '#', "'", '"', '/', '\\'] },
      hoverProvider: true,
      definitionProvider: true,
      documentSymbolProvider: true,
      documentHighlightProvider: true,
      documentLinkProvider: { resolveProvider: false },
      foldingRangeProvider: true,
      // RefactorRewrite alongside QuickFix: the numeric-base conversions are rewrites of code that
      // is already correct, and a client that filters by kind (VS Code's own "Refactor…" command
      // does) only ever offers what is advertised here.
      codeActionProvider: { codeActionKinds: [CodeActionKind.QuickFix, CodeActionKind.RefactorRewrite] },
      documentFormattingProvider: true,
      documentRangeFormattingProvider: true,
      // Newline only — see onDocumentOnTypeFormatting. Aligning a line the moment Enter completes
      // it is the one trigger that never moves text the user is still in the middle of typing.
      documentOnTypeFormattingProvider: { firstTriggerCharacter: '\n' },
      referencesProvider: true,
      renameProvider: { prepareProvider: true },
      workspaceSymbolProvider: true,
      selectionRangeProvider: true,
      callHierarchyProvider: true,
      signatureHelpProvider: { triggerCharacters: [' ', ','] },
      // Full-document only: these are cheap to recompute (one tokenizer pass plus a set lookup per
      // identifier) and a delta protocol would add real bookkeeping for no measurable gain.
      semanticTokensProvider: { legend: SEMANTIC_TOKENS_LEGEND, full: true },
      // resolveProvider: the whole hint is one short string built from data already in hand, so
      // there is nothing worth deferring to a second round trip. Advertised unconditionally even
      // though the feature defaults to off — the setting is resource-scoped, so one folder in a
      // workspace can enable it while another does not, and a capability cannot be per-folder.
      inlayHintProvider: { resolveProvider: false },
      workspace: {
        // Needed for per-folder settings to mean anything: without folder awareness every
        // resource-scoped setting collapses back to one window-wide value (see settings.ts).
        workspaceFolders: { supported: true, changeNotifications: true },
      },
    },
  };
});

connection.onInitialized(() => {
  // Resolving every folder up front is what lets the *synchronous* settings path (dialect
  // detection on a keystroke) be accurate rather than serving window-wide values until some
  // async caller happens to warm the cache.
  void settingsStore
    .warmAll()
    .then(() => {
      syncWorkspaceIndexSettings();
      for (const doc of documents.all()) scheduleDiagnostics(doc.uri);
    })
    .catch((err) => logHandlerError('initial settings resolution', err));

  connection.workspace.onDidChangeWorkspaceFolders((event) => {
    const current = new Set(settingsStore.workspaceFolders());
    for (const removed of event.removed) current.delete(removed.uri);
    for (const added of event.added) current.add(added.uri);
    settingsStore.setWorkspaceFolders([...current]);
    void settingsStore
      .warmAll()
      .then(() => syncWorkspaceIndexSettings())
      .catch((err) => logHandlerError('workspace folder change', err));
  });
});

/**
 * Client-driven workspace indexing protocol (two custom notifications, "fasm2Studio/..."). The
 * client resolves the file list via vscode.workspace.findFiles — VS Code's own optimized,
 * excludes-aware search — rather than this server re-walking the filesystem itself, since
 * duplicating that traversal well is real scope for no benefit. Indexing then runs here,
 * batched/yielded (see Workspace.indexWorkspace), off the interactive request path.
 */
/** Trust granted after initialize (the user clicked "Trust" on the open folder). Diagnostics were
 * suppressed for every open document until now, so they all need a first run — nothing else would
 * trigger one until each file is next edited. */
connection.onNotification('fasm2Studio/workspaceTrust', (params: { isTrusted: boolean }) => {
  if (workspaceTrusted === params.isTrusted) return;
  workspaceTrusted = params.isTrusted;
  if (!workspaceTrusted) return;
  for (const doc of documents.all()) {
    reportDiagnosticsAvailability(doc.uri, undefined);
    scheduleDiagnostics(doc.uri);
  }
});

connection.onNotification('fasm2Studio/indexWorkspaceFiles', (params: { uris: string[] }) => {
  const scan = workspace
    .indexWorkspace(params.uris ?? [], resolveDialect)
    .then(({ indexed, skipped }) => {
      connection.console.info(`fasm2-studio: indexed ${indexed} workspace file(s), skipped ${skipped}.`);
      // The client is waiting on this to close its progress indicator: the notification that
      // started the scan returns the moment it is sent, so completion is the only thing that can
      // tell the client how long cross-file navigation was actually still warming up for.
      void connection.sendNotification('fasm2Studio/workspaceIndexed', { indexed, skipped });
      // A document already open (and diagnosed) before indexing finished may have compiled
      // standalone instead of via its real entry point (findEntryFile needs the index to walk
      // the include graph) — now that the index is populated, redo it for every open document.
      for (const doc of documents.all()) {
        scheduleDiagnostics(doc.uri);
      }
    })
    .catch((err) => {
      logHandlerError('indexWorkspaceFiles', err);
      // Reported rather than swallowed: a failed scan leaves go-to-definition and rename quietly
      // answering from a partial index, which looks like the feature being wrong rather than
      // absent.
      void connection.sendNotification('fasm2Studio/workspaceIndexed', {
        indexed: 0,
        skipped: 0,
        error: err instanceof Error ? err.message : String(err),
      });
    })
    .finally(() => {
      if (indexingInFlight === scan) indexingInFlight = undefined;
    });
  indexingInFlight = scan;
});

/**
 * Lets the client resolve which real entry point (a file with its own top-level `format`
 * directive) a given file's build/run/debug should actually target — the same resolution
 * findEntryFile already does for diagnostics, exposed here so Build/Run/Debug can compile the
 * entry point instead of a fragment that can't be compiled standalone.
 */
connection.onRequest(
  'fasm2Studio/resolveEntryPoint',
  (params: { uri: string }): { entryUri?: string; ambiguousEntryUris?: string[] } => {
    const candidates = workspace.findReachableEntryPoints(params.uri);
    if (candidates.length === 1) return { entryUri: candidates[0] };
    if (candidates.length === 0) return {};
    return { ambiguousEntryUris: candidates };
  },
);

/**
 * Every known entry point in the workspace, for when resolveEntryPoint comes back empty (an
 * orphaned fragment, or one reachable from more than one unrelated project) — the client can
 * offer this list and let the user pick instead of guessing which project they meant.
 */
connection.onRequest('fasm2Studio/listEntryPoints', (): { entryUris: string[] } => {
  return { entryUris: workspace.listEntryPoints() };
});

/**
 * The include-path edits a set of file renames requires (see features/includeRename.ts). Asked by
 * the client from vscode.workspace.onWillRenameFiles, i.e. while the include graph still describes
 * where every file currently is — which is the only moment this question has a reliable answer.
 */
connection.onRequest(
  'fasm2Studio/includeRenameEdits',
  (params: { renames: FileRename[] }): IncludeRenameEdits => includeRenameEdits(workspace, params.renames ?? []),
);

// Standard LSP file-watcher notification, forwarded automatically by vscode-languageclient from
// the client's vscode.workspace.createFileSystemWatcher (see clientOptions.synchronize.fileEvents
// in extension.ts) — keeps the index in sync with files nobody has opened as an editor tab.
connection.onDidChangeWatchedFiles((params) => {
  for (const change of params.changes) {
    try {
      if (change.type === FileChangeType.Deleted) {
        workspace.removeIndexedFile(change.uri);
      } else {
        void workspace.reindexFile(change.uri, resolveDialect).catch((err) => logHandlerError('reindexFile', err));
      }
    } catch (err) {
      logHandlerError('onDidChangeWatchedFiles', err);
    }
  }
});

connection.onDidChangeConfiguration((change: DidChangeConfigurationParams) => {
  try {
    settingsStore.applyPushedSettings(change.settings?.fasm2Studio as Partial<FasmSettings> | undefined);
    invalidateCompilerCache();
    // Settings changed, so whatever prompted the earlier dialect hint may no longer hold — allow
    // it to be raised again rather than staying silent for the rest of the session.
    dialectSuggested = false;
    // applyPushedSettings dropped every cached per-folder pull, so re-resolve them before feeding
    // the index: doing it from the pushed window-wide value alone would undo the folder scoping
    // on every settings edit. Dialect defaults are re-resolved lazily on the next parse.
    void settingsStore
      .warmAll()
      .then(() => {
        syncWorkspaceIndexSettings();
        for (const doc of documents.all()) scheduleDiagnostics(doc.uri);
      })
      .catch((err) => logHandlerError('settings re-resolution', err));
  } catch (err) {
    logHandlerError('onDidChangeConfiguration', err);
  }
});

// "%", "~", "&", "|" aren't part of the static parser's own identifier charset (tokenizer.ts's
// IDENT_START) — they're only ever built-ins (the "%"/"%%" repetition-count pseudo-variables, and
// the "~"/"&"/"|" logical-expression operators — see hover.ts's SPECIAL_SYMBOLS/LOGICAL_OPERATORS),
// never real cross-file symbols worth indexing — but they still need to be word characters here so
// hovering them resolves to anything. "#" (identifier concatenation) is deliberately NOT included:
// unlike these, it's routinely used *inside* a real multi-part identifier (e.g. "v#instr#pd"), so
// treating it as a word character would merge otherwise-separately-hoverable identifier pieces
// into one, breaking hover on any of them.
const WORD_CHAR = /[A-Za-z0-9_.@$?%~&|]/;

function getWordRangeAtPosition(doc: TextDocument, position: { line: number; character: number }): Range | undefined {
  const text = doc.getText({ start: { line: position.line, character: 0 }, end: { line: position.line + 1, character: 0 } });
  const idx = position.character;
  let start = idx;
  let end = idx;
  while (start > 0 && WORD_CHAR.test(text[start - 1])) start--;
  while (end < text.length && WORD_CHAR.test(text[end])) end++;
  if (start === end) return undefined;
  return Range.create(Position.create(position.line, start), Position.create(position.line, end));
}

function getWordAtPosition(doc: TextDocument, position: { line: number; character: number }): string | undefined {
  const range = getWordRangeAtPosition(doc, position);
  if (!range) return undefined;
  const line = doc.getText({ start: { line: position.line, character: 0 }, end: { line: position.line + 1, character: 0 } });
  return line.slice(range.start.character, range.end.character);
}

function reparse(doc: TextDocument): void {
  const dialect = resolveDialect(doc.uri, doc.getText());
  workspace.updateDocument(doc.uri, doc.version, doc.getText(), dialect);
}

function scheduleDiagnostics(uri: string): void {
  // A shutdown request is the client saying it will send nothing further and wants the process
  // gone. Arming another debounce timer here would start a compile nobody is waiting for, in a
  // process that is leaving — and the client's stop() gives the whole exchange a two-second budget.
  if (shuttingDown) return;
  if (!workspaceTrusted) {
    reportDiagnosticsAvailability(uri, 'the workspace is not trusted, so the assembler is not run');
    return;
  }

  const settings = settingsStore.get(uri);
  if (!settings.diagnosticsEnabled) return;

  const existing = diagnosticTimers.get(uri);
  if (existing) clearTimeout(existing);

  const generation = (diagnosticGenerations.get(uri) ?? 0) + 1;
  diagnosticGenerations.set(uri, generation);

  const timer = setTimeout(() => {
    diagnosticTimers.delete(uri);
    runDiagnosticsFor(uri, generation).catch((err) => logHandlerError('runDiagnosticsFor', err));
  }, settings.diagnosticsDebounceMs);
  diagnosticTimers.set(uri, timer);
}

/**
 * Whether the wrong-dialect hint has already been raised. A misconfigured `defaultDialect` is a
 * property of the project, not of one file, so saying it once is help and repeating it is nagging.
 */
let dialectSuggested = false;

/**
 * When a file fails to assemble, checks whether the *other* assembler compiles it cleanly, and if
 * so tells the client the dialect is probably misconfigured.
 *
 * Nothing here guesses from syntax. The dialect auto-detection deliberately only recognizes
 * fasm2-only markers (see dialect.ts, which explains why a fasm1 marker set was removed), so a
 * project written in the other dialect without those markers silently falls back to
 * `defaultDialect` — and a whole fasm1 codebase then reports errors on code that is entirely
 * correct. Real fasm1 sources make this common rather than theoretical: none of KolibriOS carries a
 * fasm2 marker, and of 120 of its files, 84 assemble under fasm1 while only 9 do under fasm2.
 *
 * Using the compiler itself as the oracle keeps this free of heuristics: the hint is only raised
 * when one assembler has actually rejected the file and the other has actually accepted it. The
 * extra compile costs one run, once per session, and only for a file that is already failing.
 */
async function suggestDialectIfMisconfigured(
  uri: string,
  dialect: Dialect,
  opts: { sourceFsPath: string; cwd: string; reportForFsPath?: string },
): Promise<void> {
  if (dialectSuggested) return;

  const settings = await settingsStore.resolve(uri);
  const other: Dialect = dialect === 'fasm1' ? 'fasm2' : 'fasm1';
  const configured = other === 'fasm1' ? settings.fasm1CompilerPath : settings.fasm2CompilerPath;
  const otherPath = configured || (await resolveCompilerOnPath(other));
  if (!otherPath) return;

  const asOther = await runDiagnostics({
    compilerPath: otherPath,
    sourceFsPath: opts.sourceFsPath,
    cwd: opts.cwd,
    reportForFsPath: opts.reportForFsPath,
    includePath: settings.includePath || undefined,
    preload: (other === 'fasm2' && settings.fasm2Preload) || undefined,
    // Deliberately without fasm2Studio.compilerArgs, which the real compile above does pass. Those
    // flags were written for the dialect the project actually is, and the two assemblers share
    // almost no option set — handing fasmg's `-e 200` to fasm1 makes it print its usage banner and
    // exit, which parses as zero diagnostics and reads here as "it assembles cleanly as fasm1".
    // That is this function's entire evidence for suggesting a dialect, so passing them could turn
    // a correct fasm2 project into a prompt to switch it to fasm1. A project whose build needs
    // flags simply gets no unsolicited suggestion, which is the harmless direction to be wrong in.
    dialect: other,
  });
  if (asOther.toolError || asOther.diagnostics.length > 0) return;

  dialectSuggested = true;
  connection.sendNotification('fasm2Studio/suggestDialect', { uri, dialect: other });
}

/**
 * Last reason reported to the client for each document via 'fasm2Studio/diagnosticsUnavailable'
 * (undefined = "diagnostics are working"). Kept so an unchanged state is not re-sent on every
 * keystroke — the notification is meant to describe a standing condition, not to fire repeatedly.
 */
const diagnosticsUnavailableReason = new Map<string, string | undefined>();

/** Correlated listings, per entry point — the data behind the inlay hints. Populated as a
 * by-product of the diagnostics compile below; see features/inlayHints.ts. */
const listingMaps = new ListingMapStore();

/**
 * Tells the client whether live error checking is actually running for `uri`.
 *
 * Without this, every failure to *run* the compiler — a spawn failure, a timeout on a large
 * project, a path pointing at something that isn't an assembler — cleared the document's
 * diagnostics and said nothing, which on screen is indistinguishable from "your code is fine".
 * The client renders this in the status bar rather than as a popup: it is a standing condition,
 * and a notification that reappears on every edit would be intolerable.
 */
function reportDiagnosticsAvailability(uri: string, reason: string | undefined): void {
  if (diagnosticsUnavailableReason.get(uri) === reason) return;
  diagnosticsUnavailableReason.set(uri, reason);
  connection.sendNotification('fasm2Studio/diagnosticsUnavailable', { uri, reason });
}

/**
 * Which *other* files each document's last compile reported errors in, so a fixed error can be
 * cleared from a file nothing is going to recompile on its own.
 *
 * Diagnostics are published per URI and stay until replaced, so a file that is not open has no
 * event of its own that would ever retract them — this is the only record that they were put there
 * and by whom. Keyed by the document whose compile produced them, because several open files in one
 * project legitimately report the same broken include, and the last one to be fixed must not erase
 * the marks the others still stand behind.
 */
const foreignDiagnosticOwners = new Map<string, Set<string>>();

/** The open workspace folders as filesystem paths, for deciding which files may carry diagnostics
 * of their own (see placeForeignErrors). Non-`file:` folders have no path and are skipped. */
function workspaceFolderPaths(): string[] {
  const paths: string[] = [];
  for (const folderUri of settingsStore.workspaceFolders()) {
    try {
      const parsed = URI.parse(folderUri);
      if (parsed.scheme === 'file') paths.push(parsed.fsPath);
    } catch {
      // A folder URI we can't parse simply doesn't contribute one.
    }
  }
  return paths;
}

/**
 * Publishes `uri`'s compile errors that landed in other files, and retracts the ones it previously
 * put there that are now gone.
 *
 * Open documents are deliberately skipped: each one compiles the whole project itself and publishes
 * its own, better-filtered result, so writing over it here would mean two compiles racing to own
 * one file's squiggles.
 */
function publishForeignDiagnostics(ownerUri: string, foreign: Map<string, Diagnostic[]> | undefined): void {
  const published = new Set<string>();
  for (const [fsPath, diagnostics] of foreign ?? []) {
    const foreignUri = URI.file(fsPath).toString();
    if (foreignUri === ownerUri || documents.get(foreignUri)) continue;
    connection.sendDiagnostics({ uri: foreignUri, diagnostics });
    published.add(foreignUri);
  }

  for (const staleUri of foreignDiagnosticOwners.get(ownerUri) ?? []) {
    if (published.has(staleUri)) continue;
    const claimedElsewhere = [...foreignDiagnosticOwners].some(
      ([owner, uris]) => owner !== ownerUri && uris.has(staleUri),
    );
    if (!claimedElsewhere && !documents.get(staleUri)) {
      connection.sendDiagnostics({ uri: staleUri, diagnostics: [] });
    }
  }

  if (published.size > 0) foreignDiagnosticOwners.set(ownerUri, published);
  else foreignDiagnosticOwners.delete(ownerUri);
}

async function runDiagnosticsFor(uri: string, generation: number): Promise<void> {
  const doc = documents.get(uri);
  if (!doc) return;

  const settings = await settingsStore.resolve(uri);
  const dialect = currentDialect(uri);
  const configuredPath = dialect === 'fasm1' ? settings.fasm1CompilerPath : settings.fasm2CompilerPath;
  const compilerPath = configuredPath || (await resolveCompilerOnPath(dialect));

  if (!compilerPath) {
    const reason = `no ${dialect} compiler found on PATH (set fasm2Studio.${dialect === 'fasm1' ? 'fasm1CompilerPath' : 'fasm2CompilerPath'} or install it)`;
    connection.console.warn(`fasm2-studio: diagnostics unavailable for ${uri}: ${reason}.`);
    connection.sendDiagnostics({ uri, diagnostics: [] });
    // Nothing was compiled, so any marks left in other files by an earlier run are now unfounded.
    publishForeignDiagnostics(uri, undefined);
    reportDiagnosticsAvailability(uri, reason);
    return;
  }

  let parsedUri: URI;
  try {
    parsedUri = URI.parse(uri);
  } catch {
    return;
  }

  // Unsaved buffers (untitled:, and any other non-file scheme) have no real filesystem path —
  // URI.parse(...).fsPath on those returns a bogus value that would make every compile attempt
  // fail with ENOENT. Compile a temp-file snapshot instead so diagnostics still work pre-save;
  // the only cost is that any "include" in the buffer resolves relative to the temp dir rather
  // than the file's eventual real location.
  const isRealFile = parsedUri.scheme === 'file';
  const fsPath = isRealFile ? parsedUri.fsPath : undefined;
  let tempDir: string | undefined;
  let shadowCleanup: (() => Promise<void>) | undefined;
  let compileFsPath = fsPath;
  let cwd = fsPath ? path.dirname(fsPath) : undefined;
  let reportForFsPath: string | undefined;
  let toRealPath: ((p: string) => string | undefined) | undefined;
  /** The real (non-shadow) path of the program actually being compiled — the key the listing map
   * is stored under, since a listing describes an entry point rather than any one of its files. */
  let entryFsPath: string | undefined;

  // This file may be a fragment with no `format` of its own (an .inc/.asm meant only to be
  // `include`d into a real program) — compiling it standalone is meaningless and its real errors
  // would be missed. Compile the actual entry point instead, and filter the result back down to
  // this file.
  if (isRealFile) {
    let targetFsPath = fsPath!;
    let entryUri = workspace.findEntryFile(uri);
    if (!entryUri && indexingInFlight) {
      // The initial workspace scan may not have reached this file's includer(s) yet — a fragment
      // opened this early (e.g. stepping into it moments into a debug session started right after
      // VS Code launched, before the async scan catches up) would otherwise get compiled standalone
      // here and report bogus "symbol undefined"/"bits64 or higher required" errors that vanish
      // again as soon as indexing finishes and re-diagnoses it anyway. Wait for it — bounded, so a
      // stalled or unusually large scan can't hang this file's diagnostics indefinitely — then
      // re-check before falling back to standalone compilation.
      await Promise.race([indexingInFlight, delay(INDEX_WAIT_TIMEOUT_MS)]);
      if (diagnosticGenerations.get(uri) !== generation) return;
      entryUri = workspace.findEntryFile(uri);
    }
    if (entryUri && entryUri !== uri) {
      try {
        targetFsPath = URI.parse(entryUri).fsPath;
        compileFsPath = targetFsPath;
        cwd = path.dirname(targetFsPath);
      } catch {
        // Fall back to compiling the file itself.
      }
    }
    reportForFsPath = fsPath;
    entryFsPath = targetFsPath;

    // Compile the live buffer, not whatever's last saved to disk: build a shadow directory shaped
    // like the target's, with every sibling symlinked back to the real file except this document's
    // own position, which gets its current text instead — see liveShadow.ts.
    const shadow = await buildLiveShadowRoot(targetFsPath, fsPath!, doc.getText()).catch(() => undefined);
    if (shadow) {
      compileFsPath = shadow.compileFsPath;
      cwd = shadow.cwd;
      shadowCleanup = shadow.cleanup;
      toRealPath = shadow.toRealPath;
    }
  }

  if (!isRealFile) {
    try {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fasm2-studio-'));
      compileFsPath = path.join(tempDir, 'untitled.asm');
      await fs.writeFile(compileFsPath, doc.getText(), 'utf8');
      cwd = tempDir;
    } catch (err) {
      logHandlerError('runDiagnosticsFor (temp snapshot)', err);
      return;
    }
  }

  // Only when hints are actually switched on, and only for fasm2: the macro is fasmg source, and
  // fasm1 would reject both it and the -i flag carrying it. Costs one extra flag on a compile that
  // is happening regardless, so a workspace with hints off pays nothing at all for this feature.
  const wantsListing = settings.inlayHints !== 'off' && dialect === 'fasm2' && entryFsPath !== undefined;
  const listingInclude = wantsListing ? bundledListingIncPath() : undefined;

  try {
    const result = await runDiagnostics({
      compilerPath,
      sourceFsPath: compileFsPath!,
      cwd: cwd!,
      reportForFsPath,
      includePath: settings.includePath || undefined,
      // fasm1 has its own built-in instruction set and no -i flag, so a preload is meaningless
      // (and would be rejected) there.
      preload: (dialect === 'fasm2' && settings.fasm2Preload) || undefined,
      extraArgs: settings.compilerArgs,
      listingInclude,
      dialect,
      toRealPath,
      workspaceFolders: workspaceFolderPaths(),
    });

    // A newer edit (or diagnostics being disabled) arrived while the compiler was running; drop
    // this stale result instead of overwriting fresher-but-not-yet-ready diagnostics with old ones.
    if (diagnosticGenerations.get(uri) !== generation) return;
    if (!documents.get(uri)) return;

    // Correlated against the tree that was actually compiled (the shadow, when there is one), with
    // every candidate translated back to its real path so the map is keyed by paths the editor
    // knows. Done here rather than inside runDiagnostics because it needs the source walk, which
    // is the language server's side of the job, not the compiler runner's.
    if (result.listing && entryFsPath) {
      const candidates = buildCandidateSequence(compileFsPath!, undefined, toRealPath);
      listingMaps.set(entryFsPath, correlateListing(result.listing, candidates));
      // The hints the client is currently showing were built from the previous compile, so it has
      // to be told to ask again — nothing else would prompt it.
      void connection.languages.inlayHint.refresh().catch(() => undefined);
    }

    // Published before the toolError branch below returns: a build that failed entirely inside an
    // include still located that error precisely, and that is the case this exists for.
    publishForeignDiagnostics(uri, result.foreignDiagnostics);

    if (result.toolError) {
      connection.console.warn(`fasm2-studio: diagnostics unavailable for ${uri}: ${result.toolError}`);
      connection.sendDiagnostics({ uri, diagnostics: [] });
      reportDiagnosticsAvailability(uri, result.toolError);
      return;
    }

    noteFirstErrorOnly(uri, dialect, result.diagnostics);
    connection.sendDiagnostics({ uri, diagnostics: result.diagnostics });
    reportDiagnosticsAvailability(uri, undefined);

    if (result.diagnostics.length > 0) {
      await suggestDialectIfMisconfigured(uri, dialect, {
        sourceFsPath: compileFsPath!,
        cwd: cwd!,
        reportForFsPath,
      });
    }
  } finally {
    if (tempDir) void fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    if (shadowCleanup) void shadowCleanup();
  }
}

documents.onDidOpen((e: TextDocumentChangeEvent<TextDocument>) => {
  try {
    reparse(e.document);
    scheduleDiagnostics(e.document.uri);
  } catch (err) {
    logHandlerError('onDidOpen', err);
  }
});

documents.onDidChangeContent((e: TextDocumentChangeEvent<TextDocument>) => {
  try {
    reparse(e.document);
    scheduleDiagnostics(e.document.uri);
  } catch (err) {
    logHandlerError('onDidChangeContent', err);
  }
});

documents.onDidSave((e: TextDocumentChangeEvent<TextDocument>) => {
  try {
    scheduleDiagnostics(e.document.uri);
  } catch (err) {
    logHandlerError('onDidSave', err);
  }
});

documents.onDidClose((e: TextDocumentChangeEvent<TextDocument>) => {
  try {
    const uri = e.document.uri;
    workspace.removeDocument(uri);
    // indexWorkspace skips a uri that's already open, trusting the live buffer as the
    // authoritative copy instead of also keeping a disk-read one in indexedDocuments — so closing
    // a document that was open during the initial scan would otherwise erase its parsed state
    // (its symbols, and any include edge into it) from the workspace entirely until something
    // edits it or the file watcher fires. reindexFile is a no-op if something reopened it in the
    // meantime (it re-checks openDocuments itself), so this is safe to fire unconditionally.
    void workspace.reindexFile(uri, resolveDialect).catch((err) => logHandlerError('reindexFile (onDidClose)', err));
    dialectCache.delete(uri);
    diagnosticGenerations.delete(uri);
    diagnosticsUnavailableReason.delete(uri);
    // This document is no longer compiling anything, so it can no longer vouch for the errors it
    // reported in other files — retract them unless another open document reports them too.
    publishForeignDiagnostics(uri, undefined);
    const timer = diagnosticTimers.get(uri);
    if (timer) clearTimeout(timer);
    diagnosticTimers.delete(uri);
    connection.sendDiagnostics({ uri, diagnostics: [] });
  } catch (err) {
    logHandlerError('onDidClose', err);
  }
});

/** The trigger characters that exist only for path completion. Typed anywhere else they must
 * produce nothing at all — a quote in `db 'text'` or a division in `mov eax, 4/2` is not a request
 * for the identifier list. */
const PATH_TRIGGER_CHARACTERS = new Set(["'", '"', '/', '\\']);

connection.onCompletion((params: CompletionParams): CompletionItem[] => {
  try {
    const doc = documents.get(params.textDocument.uri);
    // The text before the cursor on its own line is all the context ranking needs: it decides
    // whether a mnemonic or an operand is being typed. See features/completion.ts.
    const linePrefix = doc
      ? doc.getText({ start: { line: params.position.line, character: 0 }, end: params.position })
      : '';

    const includeCtx = includePathContext(linePrefix);
    if (includeCtx) {
      return getIncludePathCompletions(
        includeCtx,
        params.position,
        uriToFsPath(params.textDocument.uri),
        splitIncludePath(settingsStore.get(params.textDocument.uri).includePath),
      );
    }
    // Inside any other string literal there is nothing to offer: a mnemonic is not a plausible
    // completion for the contents of `db 'hello'`, and the list appearing there was noise.
    if (stringContext(linePrefix)) return [];
    if (params.context?.triggerCharacter && PATH_TRIGGER_CHARACTERS.has(params.context.triggerCharacter)) return [];

    return getCompletions(workspace, params.textDocument.uri, currentDialect(params.textDocument.uri), linePrefix);
  } catch (err) {
    logHandlerError('onCompletion', err);
    return [];
  }
});

/** Fills in the documentation the completion list deliberately omitted — see
 * features/completion.ts's note on why the static tables ship without it. */
connection.onCompletionResolve((item: CompletionItem): CompletionItem => {
  try {
    const uri = (item.data as { uri?: string } | undefined)?.uri;
    const dialect = uri ? currentDialect(uri) : 'fasm2';
    return resolveCompletionItem(item, dialect, uri ? detectIsa(workspace, uri, dialect) : 'x86');
  } catch (err) {
    logHandlerError('onCompletionResolve', err);
    return item;
  }
});

connection.onHover((params: HoverParams): Hover | undefined => {
  try {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) return undefined;
    const word = getWordAtPosition(doc, params.position);
    if (!word) return undefined;
    return getHover(workspace, params.textDocument.uri, currentDialect(params.textDocument.uri), word, params.position.line);
  } catch (err) {
    logHandlerError('onHover', err);
    return undefined;
  }
});

connection.onDefinition((params: DefinitionParams): Location[] | undefined => {
  try {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) return undefined;
    const word = getWordAtPosition(doc, params.position);
    if (!word) return undefined;
    return getDefinitions(workspace, params.textDocument.uri, currentDialect(params.textDocument.uri), word, params.position);
  } catch (err) {
    logHandlerError('onDefinition', err);
    return undefined;
  }
});

connection.onDocumentSymbol((params: DocumentSymbolParams) => {
  try {
    const doc = workspace.getDocument(params.textDocument.uri);
    if (!doc) return [];
    return getDocumentSymbols(doc);
  } catch (err) {
    logHandlerError('onDocumentSymbol', err);
    return [];
  }
});

connection.onReferences((params: ReferenceParams): Location[] => {
  try {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) return [];
    const word = getWordAtPosition(doc, params.position);
    if (!word) return [];
    return getReferences(workspace, params.textDocument.uri, params.position.line, word, params.context?.includeDeclaration ?? false);
  } catch (err) {
    logHandlerError('onReferences', err);
    return [];
  }
});

connection.onPrepareRename((params: PrepareRenameParams): Range | undefined => {
  try {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) return undefined;
    const word = getWordAtPosition(doc, params.position);
    if (!word || !isRenameable(workspace, params.textDocument.uri, params.position.line, word)) return undefined;
    return getWordRangeAtPosition(doc, params.position);
  } catch (err) {
    logHandlerError('onPrepareRename', err);
    return undefined;
  }
});

connection.onRenameRequest((params: RenameParams): WorkspaceEdit | undefined => {
  try {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) return undefined;
    const word = getWordAtPosition(doc, params.position);
    if (!word) return undefined;
    return getRenameEdit(workspace, params.textDocument.uri, params.position.line, word, params.newName);
  } catch (err) {
    logHandlerError('onRenameRequest', err);
    return undefined;
  }
});

connection.onWorkspaceSymbol((params: WorkspaceSymbolParams): SymbolInformation[] => {
  try {
    return getWorkspaceSymbols(workspace, params.query);
  } catch (err) {
    logHandlerError('onWorkspaceSymbol', err);
    return [];
  }
});

connection.onSignatureHelp((params: SignatureHelpParams): SignatureHelp | undefined => {
  try {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) return undefined;
    const lineBeforeCursor = doc.getText({
      start: { line: params.position.line, character: 0 },
      end: params.position,
    });
    return getSignatureHelp(workspace, params.textDocument.uri, currentDialect(params.textDocument.uri), lineBeforeCursor);
  } catch (err) {
    logHandlerError('onSignatureHelp', err);
    return undefined;
  }
});

connection.onDocumentHighlight((params: DocumentHighlightParams): DocumentHighlight[] => {
  try {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) return [];
    const word = getWordAtPosition(doc, params.position);
    if (!word) return [];
    return getDocumentHighlights(workspace, params.textDocument.uri, params.position.line, word);
  } catch (err) {
    logHandlerError('onDocumentHighlight', err);
    return [];
  }
});

connection.onDocumentLinks((params: DocumentLinkParams): DocumentLink[] => {
  try {
    return getDocumentLinks(workspace, params.textDocument.uri);
  } catch (err) {
    logHandlerError('onDocumentLinks', err);
    return [];
  }
});

connection.languages.callHierarchy.onPrepare((params: CallHierarchyPrepareParams): CallHierarchyItem[] => {
  try {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) return [];
    const word = getWordAtPosition(doc, params.position);
    if (!word) return [];
    return prepareCallHierarchy(workspace, params.textDocument.uri, currentDialect(params.textDocument.uri), word);
  } catch (err) {
    logHandlerError('onPrepareCallHierarchy', err);
    return [];
  }
});

connection.languages.callHierarchy.onIncomingCalls((params: CallHierarchyIncomingCallsParams): CallHierarchyIncomingCall[] => {
  try {
    return incomingCalls(workspace, params.item);
  } catch (err) {
    logHandlerError('onIncomingCalls', err);
    return [];
  }
});

connection.languages.callHierarchy.onOutgoingCalls((params: CallHierarchyOutgoingCallsParams): CallHierarchyOutgoingCall[] => {
  try {
    return outgoingCalls(workspace, currentDialect(params.item.uri), params.item);
  } catch (err) {
    logHandlerError('onOutgoingCalls', err);
    return [];
  }
});

connection.onSelectionRanges((params: SelectionRangeParams): SelectionRange[] => {
  try {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) return [];
    return getSelectionRanges(doc.getText(), params.positions);
  } catch (err) {
    logHandlerError('onSelectionRanges', err);
    return [];
  }
});

connection.onFoldingRanges((params: FoldingRangeParams): FoldingRange[] => {
  try {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) return [];
    return getFoldingRanges(doc.getText());
  } catch (err) {
    logHandlerError('onFoldingRanges', err);
    return [];
  }
});

connection.onCodeAction((params: CodeActionParams): CodeAction[] => {
  try {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) return [];
    const word = getWordAtPosition(doc, params.range.start);
    if (!word) return [];
    return getCodeActions(
      workspace,
      params.textDocument.uri,
      currentDialect(params.textDocument.uri),
      word,
      getWordRangeAtPosition(doc, params.range.start),
      doc.getText(),
    );
  } catch (err) {
    logHandlerError('onCodeAction', err);
    return [];
  }
});

/** Turns the client's own FormattingOptions plus this extension's column settings into one
 * FormatOptions. The client owns indentation style (it is a per-editor preference every language
 * shares); the columns are fasm-specific and come from settings. */
function formatOptionsFor(uri: string, options: FormattingOptions): FormatOptions {
  const settings = settingsStore.get(uri);
  return {
    mnemonicColumn: settings.formatMnemonicColumn,
    operandColumn: settings.formatOperandColumn,
    commentColumn: settings.formatCommentColumn,
    useTabs: !options.insertSpaces,
    tabSize: options.tabSize > 0 ? options.tabSize : 4,
  };
}

connection.onDocumentFormatting((params: DocumentFormattingParams): TextEdit[] => {
  try {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) return [];
    const text = doc.getText();
    const eol = detectEol(text);
    const formatted = formatLines(text, formatOptionsFor(params.textDocument.uri, params.options)).join(eol);
    if (formatted === text) return [];
    return [
      {
        range: { start: { line: 0, character: 0 }, end: doc.positionAt(text.length) },
        newText: formatted,
      },
    ];
  } catch (err) {
    logHandlerError('onDocumentFormatting', err);
    return [];
  }
});

/**
 * Aligns the line Enter just finished, so the columns the formatter maintains appear as the file is
 * written rather than only when Format Document is run over it afterwards.
 *
 * The line *above* the cursor is the one formatted, never the new empty one the cursor is now on:
 * the only line whose content is known to be complete is the one that was just left. Formatting the
 * line being typed is what makes on-type formatting hostile in other languages — text moves under
 * the cursor mid-word — and it is avoidable here because assembly is line-oriented.
 *
 * Gated behind the client's own `editor.formatOnType`, which is off by default, so this is opt-in.
 */
connection.onDocumentOnTypeFormatting((params: DocumentOnTypeFormattingParams): TextEdit[] => {
  try {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) return [];
    const line = params.position.line - 1;
    if (line < 0) return [];

    const text = doc.getText();
    const original = text.split(/\r\n|\r|\n/);
    if (line >= original.length) return [];

    // The whole document, for the same reason range formatting does it: a line's indent depth is
    // decided by every block opened above it, which the line alone does not carry.
    const formatted = formatLines(text, formatOptionsFor(params.textDocument.uri, params.options));
    if (formatted[line] === original[line]) return [];

    return [
      {
        range: { start: { line, character: 0 }, end: { line, character: original[line].length } },
        newText: formatted[line],
      },
    ];
  } catch (err) {
    logHandlerError('onDocumentOnTypeFormatting', err);
    return [];
  }
});

/**
 * Range formatting re-formats the whole document and then returns only the lines inside the
 * requested range. Formatting the selected text alone would get its indentation wrong: the depth
 * of a line depends on every block opened above it, which a selection starting mid-file does not
 * contain.
 */
connection.onDocumentRangeFormatting((params: DocumentRangeFormattingParams): TextEdit[] => {
  try {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) return [];
    const text = doc.getText();
    const formatted = formatLines(text, formatOptionsFor(params.textDocument.uri, params.options));
    const original = text.split(/\r\n|\r|\n/);

    const first = params.range.start.line;
    // A range ending at character 0 does not actually include that line.
    const last = Math.min(formatted.length - 1, params.range.end.character === 0 ? params.range.end.line - 1 : params.range.end.line);
    if (last < first) return [];

    const edits: TextEdit[] = [];
    for (let line = first; line <= last; line++) {
      if (formatted[line] === original[line]) continue;
      // One edit per line, replacing the line's content but not its terminator — so the
      // document's existing line endings are never touched.
      edits.push({
        range: { start: { line, character: 0 }, end: { line, character: original[line].length } },
        newText: formatted[line],
      });
    }
    return edits;
  } catch (err) {
    logHandlerError('onDocumentRangeFormatting', err);
    return [];
  }
});

connection.languages.semanticTokens.on((params: SemanticTokensParams): SemanticTokens => {
  try {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) return { data: [] };
    return getSemanticTokens(workspace, params.textDocument.uri, currentDialect(params.textDocument.uri), doc.getText());
  } catch (err) {
    logHandlerError('onSemanticTokens', err);
    // An empty set leaves the TextMate grammar's own colouring in place, which is the right
    // fallback: worse than ISA-aware highlighting, but never worse than having no highlighting.
    return { data: [] };
  }
});

connection.languages.inlayHint.on((params: InlayHintParams): InlayHint[] => {
  try {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) return [];
    // The synchronous read, not resolve(): this is an interactive, per-viewport request that
    // re-fires on every scroll, and the folder's own value is already warm by the time any listing
    // exists to serve from (a compile had to run first, and that path resolves settings).
    const mode = settingsStore.get(params.textDocument.uri).inlayHints;
    if (mode === 'off') return [];

    const fsPath = uriToFsPath(params.textDocument.uri);
    if (!fsPath) return [];
    return getInlayHints(doc, params.range, listingMaps.get(fsPath), mode);
  } catch (err) {
    logHandlerError('onInlayHint', err);
    return [];
  }
});

/**
 * Set once the client has asked the server to shut down, so nothing new is started afterwards.
 *
 * Not the same as the process being gone: `shutdown` is a request that must be answered, and the
 * `exit` notification that actually ends the process arrives separately (and may never arrive, if
 * the client gives up waiting and kills the process instead).
 */
let shuttingDown = false;

/**
 * Drops everything this server has running: pending debounce timers, the compilers themselves, and
 * the temp files those compiles were writing.
 *
 * The compilers are the part that matters. They are spawned detached so the timeout can kill a
 * whole process tree, which equally means nothing in the process group dies with the server — and
 * the timer that would have killed a runaway one goes with it. Left alone, a compile that had not
 * finished when the editor closed keeps running with no one to stop it and no one to read its
 * answer.
 */
function stopBackgroundWork(): void {
  for (const timer of diagnosticTimers.values()) clearTimeout(timer);
  diagnosticTimers.clear();
  abandonRunningCompilers();
}

connection.onShutdown(() => {
  shuttingDown = true;
  stopBackgroundWork();
});

// The shutdown request is the polite path and not the only one: the client kills the server process
// outright when its stop() times out, the process exits by itself when the editor that spawned it
// disappears, and `exit` calls process.exit as soon as its handler returns. Each of those is a way
// for the process to end with compilers still running, so each gets the same cleanup. 'exit'
// handlers run synchronously, which is why stopBackgroundWork does no asynchronous work.
process.on('exit', stopBackgroundWork);
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
  // Registering a handler at all is what replaces Node's default of dying immediately without ever
  // emitting 'exit', so the exit has to be re-issued here.
  process.on(signal, () => {
    stopBackgroundWork();
    process.exit(0);
  });
}

documents.listen(connection);
connection.listen();
