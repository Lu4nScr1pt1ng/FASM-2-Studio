import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  CompletionItem,
  createConnection,
  DefinitionParams,
  DidChangeConfigurationParams,
  DocumentSymbolParams,
  FileChangeType,
  Hover,
  HoverParams,
  InitializeParams,
  InitializeResult,
  Location,
  Position,
  PrepareRenameParams,
  ProposedFeatures,
  Range,
  ReferenceParams,
  RenameParams,
  SignatureHelp,
  SignatureHelpParams,
  SymbolInformation,
  TextDocumentChangeEvent,
  TextDocumentPositionParams,
  TextDocumentSyncKind,
  TextDocuments,
  WorkspaceEdit,
  WorkspaceSymbolParams,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { URI } from 'vscode-uri';
import { invalidateCompilerCache, resolveCompilerOnPath } from './compilerDiscovery';
import { detectDialect } from './dialect';
import { getCompletions } from './features/completion';
import { getDefinitions } from './features/definition';
import { getDocumentSymbols } from './features/documentSymbols';
import { runDiagnostics } from './features/diagnostics';
import { getHover } from './features/hover';
import { buildLiveShadowRoot } from './features/liveShadow';
import { getReferences } from './features/references';
import { getRenameEdit, isRenameable } from './features/rename';
import { getSignatureHelp } from './features/signatureHelp';
import { getWorkspaceSymbols } from './features/workspaceSymbols';
import { Dialect } from './types';
import { Workspace } from './workspace';

interface FasmSettings {
  defaultDialect: Dialect;
  fasm2CompilerPath: string;
  fasm1CompilerPath: string;
  diagnosticsEnabled: boolean;
  diagnosticsDebounceMs: number;
}

// Empty compiler path settings mean "auto-detect on PATH", resolved lazily via
// resolveCompilerOnPath — see the comment at its call site in runDiagnosticsFor.
const DEFAULT_SETTINGS: FasmSettings = {
  defaultDialect: 'fasm2',
  fasm2CompilerPath: '',
  fasm1CompilerPath: '',
  diagnosticsEnabled: true,
  diagnosticsDebounceMs: 400,
};

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);
const workspace = new Workspace();

let settings: FasmSettings = DEFAULT_SETTINGS;
const dialectCache = new Map<string, Dialect>();
const diagnosticTimers = new Map<string, ReturnType<typeof setTimeout>>();
const diagnosticGenerations = new Map<string, number>();

function logHandlerError(context: string, err: unknown): void {
  const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
  connection.console.error(`fasm2-studio: ${context} failed: ${detail}`);
}

function resolveDialect(uri: string, text: string): Dialect {
  const dialect = detectDialect(text, settings.defaultDialect);
  dialectCache.set(uri, dialect);
  return dialect;
}

function currentDialect(uri: string): Dialect {
  return dialectCache.get(uri) ?? settings.defaultDialect;
}

connection.onInitialize((_params: InitializeParams): InitializeResult => {
  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      completionProvider: { resolveProvider: false, triggerCharacters: ['.', '#'] },
      hoverProvider: true,
      definitionProvider: true,
      documentSymbolProvider: true,
      referencesProvider: true,
      renameProvider: { prepareProvider: true },
      workspaceSymbolProvider: true,
      signatureHelpProvider: { triggerCharacters: [' ', ','] },
    },
  };
});

/**
 * Client-driven workspace indexing protocol (two custom notifications, "fasm2Studio/..."). The
 * client resolves the file list via vscode.workspace.findFiles — VS Code's own optimized,
 * excludes-aware search — rather than this server re-walking the filesystem itself, since
 * duplicating that traversal well is real scope for no benefit. Indexing then runs here,
 * batched/yielded (see Workspace.indexWorkspace), off the interactive request path.
 */
connection.onNotification('fasm2Studio/indexWorkspaceFiles', (params: { uris: string[] }) => {
  workspace
    .indexWorkspace(params.uris ?? [], resolveDialect)
    .then(({ indexed, skipped }) => {
      connection.console.info(`fasm2-studio: indexed ${indexed} workspace file(s), skipped ${skipped}.`);
    })
    .catch((err) => logHandlerError('indexWorkspaceFiles', err));
});

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
    const incoming = (change.settings?.fasm2Studio ?? {}) as Partial<FasmSettings>;
    settings = { ...DEFAULT_SETTINGS, ...incoming };
    invalidateCompilerCache();
    // Dialect defaults may have changed; re-resolved lazily on next parse rather than eagerly here.
  } catch (err) {
    logHandlerError('onDidChangeConfiguration', err);
  }
});

const WORD_CHAR = /[A-Za-z0-9_.@$?]/;

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

async function runDiagnosticsFor(uri: string, generation: number): Promise<void> {
  const doc = documents.get(uri);
  if (!doc) return;

  const dialect = currentDialect(uri);
  const configuredPath = dialect === 'fasm1' ? settings.fasm1CompilerPath : settings.fasm2CompilerPath;
  const compilerPath = configuredPath || (await resolveCompilerOnPath(dialect));

  if (!compilerPath) {
    connection.sendDiagnostics({ uri, diagnostics: [] });
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

  // This file may be a fragment with no `format` of its own (an .inc/.asm meant only to be
  // `include`d into a real program) — compiling it standalone is meaningless and its real errors
  // would be missed. Compile the actual entry point instead, and filter the result back down to
  // this file.
  if (isRealFile) {
    let targetFsPath = fsPath!;
    const entryUri = workspace.findEntryFile(uri);
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

    // Compile the live buffer, not whatever's last saved to disk: build a shadow directory shaped
    // like the target's, with every sibling symlinked back to the real file except this document's
    // own position, which gets its current text instead — see liveShadow.ts.
    const shadow = await buildLiveShadowRoot(targetFsPath, fsPath!, doc.getText()).catch(() => undefined);
    if (shadow) {
      compileFsPath = shadow.compileFsPath;
      cwd = shadow.cwd;
      shadowCleanup = shadow.cleanup;
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

  try {
    const result = await runDiagnostics({
      compilerPath,
      sourceFsPath: compileFsPath!,
      cwd: cwd!,
      reportForFsPath,
    });

    // A newer edit (or diagnostics being disabled) arrived while the compiler was running; drop
    // this stale result instead of overwriting fresher-but-not-yet-ready diagnostics with old ones.
    if (diagnosticGenerations.get(uri) !== generation) return;
    if (!documents.get(uri)) return;

    if (result.toolError) {
      connection.console.warn(`fasm2-studio: diagnostics unavailable for ${uri}: ${result.toolError}`);
      connection.sendDiagnostics({ uri, diagnostics: [] });
      return;
    }

    connection.sendDiagnostics({ uri, diagnostics: result.diagnostics });
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
    dialectCache.delete(uri);
    diagnosticGenerations.delete(uri);
    const timer = diagnosticTimers.get(uri);
    if (timer) clearTimeout(timer);
    diagnosticTimers.delete(uri);
    connection.sendDiagnostics({ uri, diagnostics: [] });
  } catch (err) {
    logHandlerError('onDidClose', err);
  }
});

connection.onCompletion((params: TextDocumentPositionParams): CompletionItem[] => {
  try {
    return getCompletions(workspace, params.textDocument.uri, currentDialect(params.textDocument.uri));
  } catch (err) {
    logHandlerError('onCompletion', err);
    return [];
  }
});

connection.onHover((params: HoverParams): Hover | undefined => {
  try {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) return undefined;
    const word = getWordAtPosition(doc, params.position);
    if (!word) return undefined;
    return getHover(workspace, params.textDocument.uri, currentDialect(params.textDocument.uri), word);
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
    return getReferences(workspace, word, params.context?.includeDeclaration ?? false);
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
    if (!word || !isRenameable(workspace, word)) return undefined;
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
    return getRenameEdit(workspace, word, params.newName);
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

documents.listen(connection);
connection.listen();
