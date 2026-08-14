import * as path from 'path';
import * as vscode from 'vscode';
import { LanguageClient, LanguageClientOptions, ServerOptions, TransportKind } from 'vscode-languageclient/node';
import { activeFasmEditor, buildableFsPath, isFasmDocument, NO_ACTIVE_FASM_FILE_MESSAGE } from './activeEditor';
import { getDefaultOutputPath } from './buildPaths';
import { registerCheckAll } from './checkAll';
import { cleanBuildOutputs } from './clean';
import { invalidateCompilerCache } from './compilerDiscovery';
import { CONFIG_SECTION, MESSAGE_PREFIX } from './config';
import { registerDialectSuggestion } from './dialectSuggestion';
import { registerNewFile } from './newFile';
import { registerEntryPointsView } from './entryPointsView';
import { registerOpenBuildOutput } from './openBuildOutput';
import { registerSelectCompiler } from './selectCompiler';
import { registerSelectDebugger } from './selectDebugger';
import { registerSelectDialect } from './selectDialect';
import { registerShowListing } from './showListing';
import { registerCodeLens } from './codeLens';
import { FasmDebugAdapterDescriptorFactory, FasmDebugConfigurationProvider } from './debugAdapter';
import { FasmDynamicDebugConfigurationProvider, FASM_DEBUG_TYPE } from './debugConfigurations';
import { resolveEntryPointFsPath } from './entryPointResolver';
import { invalidateDebuggerCache } from './gdbDiscovery';
import { registerIncludeDrop } from './includeDrop';
import { registerIncludeRename } from './includeRename';
import { disposeInferiorTerminal } from './inferiorTerminal';
import { FasmEvaluatableExpressionProvider } from './evaluatableExpression';
import { FasmInlineValuesProvider } from './inlineValues';
import { registerPickProcess } from './pickProcess';
import { registerReportIssue } from './reportIssue';
import { disposeRunTerminal, runOutputBinary } from './runCommand';
import { activeDiagnosticsIssue, activeIndexingIssue, createStatusBarItem, refreshStatusBar, setDiagnosticsIssue, setIndexingIssue } from './statusBar';
import { registerStatusBarMenu } from './statusBarMenu';
import { FASM_TASK_TYPE, FasmTaskProvider, runBuildTask } from './taskProvider';
import { registerTerminalLinks } from './terminalLinks';
import { COMPILER_PATH_SETTING } from './types';
import { createFasmFileWatcher, indexWorkspace } from './workspaceIndexer';
import { ensureTrusted, isWorkspaceTrusted, onTrustGranted } from './workspaceTrust';

let client: LanguageClient | undefined;

/**
 * The file a build/run/debug command should act on.
 *
 * `resource` is what VS Code hands a command invoked from a menu that has one — the explorer's
 * context menu passes the file that was actually right-clicked, which is frequently *not* the
 * active editor. Honouring it is the difference between "Build" on a file in the explorer building
 * that file and it silently building whatever tab happened to be focused. Palette and editor-title
 * invocations pass nothing, and fall back to the active editor as before.
 */
async function targetFasmFile(resource?: vscode.Uri): Promise<string | undefined> {
  if (resource) return resource.fsPath;
  const editor = activeFasmEditor();
  if (!editor) {
    void vscode.window.showWarningMessage(NO_ACTIVE_FASM_FILE_MESSAGE);
    return undefined;
  }
  return buildableFsPath(editor.document);
}

/**
 * Every file a command invoked from the explorer should act on.
 *
 * VS Code hands an explorer context-menu command two arguments: the item that was right-clicked,
 * and — when the click landed inside a multi-file selection — that whole selection. Reading only
 * the first meant selecting four files and choosing "Clean Build Output" cleaned one of them and
 * said nothing about the other three, which looks like the command half-working rather than like
 * it only ever having been given one file.
 *
 * `selection` is ignored when it doesn't contain `resource`: right-clicking a file *outside* the
 * current selection acts on the file under the cursor, which is what the explorer's own commands do.
 */
async function targetFasmFiles(resource?: vscode.Uri, selection?: vscode.Uri[]): Promise<string[]> {
  if (resource && selection && selection.length > 1 && selection.some((uri) => uri.fsPath === resource.fsPath)) {
    return selection.map((uri) => uri.fsPath);
  }
  const single = await targetFasmFile(resource);
  return single ? [single] : [];
}

/**
 * The active file may be a fragment (no "format" directive of its own, meant only to be
 * `include`d) — resolves to the real entry point that should actually be built/run/debugged,
 * auto-resolving when unambiguous and prompting when a workspace has several independent
 * projects and this fragment's real target genuinely can't be guessed.
 */
async function resolveActiveEntryFile(file: string): Promise<string | undefined> {
  if (!client) {
    void vscode.window.showErrorMessage(`${MESSAGE_PREFIX}the language server is not ready yet — try again in a moment.`);
    return undefined;
  }
  return resolveEntryPointFsPath(client, file);
}

/** Target file → resolved build entry point, or undefined if any step failed (each already shows
 * its own error/warning). Shared preamble for the build/buildAndRun/run commands. `action` names
 * this command in the untrusted-workspace refusal, which comes first because every one of these
 * ends in a spawned process. */
async function resolveBuildTarget(action: string, resource?: vscode.Uri): Promise<string | undefined> {
  if (!(await ensureTrusted(action))) return undefined;
  const file = await targetFasmFile(resource);
  if (!file) return undefined;
  return resolveActiveEntryFile(file);
}

/**
 * The same, for the commands that can sensibly act on a whole explorer selection (Build, Clean).
 *
 * Entry points are de-duplicated: several selected fragments routinely belong to one program, and
 * resolving each of them separately would otherwise assemble — or clean — that program once per
 * fragment.
 */
async function resolveBuildTargets(action: string, resource?: vscode.Uri, selection?: vscode.Uri[]): Promise<string[]> {
  if (!(await ensureTrusted(action))) return [];
  const entries: string[] = [];
  for (const file of await targetFasmFiles(resource, selection)) {
    const entry = await resolveActiveEntryFile(file);
    if (entry && !entries.includes(entry)) entries.push(entry);
  }
  return entries;
}

/**
 * Names the file a single-target command picked out of a multi-file selection.
 *
 * Run and Debug start one program, so unlike Build they have nothing sensible to do with four
 * files. Acting on the right-clicked one is the correct choice; doing it without a word is what
 * would read as the other three having silently failed.
 */
function noteSingleTarget(file: string, resource?: vscode.Uri, selection?: vscode.Uri[]): void {
  if (!resource || !selection || selection.length <= 1) return;
  void vscode.window.showInformationMessage(
    `${MESSAGE_PREFIX}${selection.length} files are selected; acting on ${path.basename(file)}.`,
  );
}

function registerCommands(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    // Builds every selected file (see targetFasmFiles), sequentially — each runs as its own task
    // in the shared terminal panel, and starting the next before the last has finished would
    // interleave two assemblers' output in it. Stops at the first failure rather than burying the
    // error that matters under the builds that came after it.
    vscode.commands.registerCommand('fasm2Studio.build', async (resource?: vscode.Uri, selection?: vscode.Uri[]) => {
      for (const entryFile of await resolveBuildTargets('Building', resource, selection)) {
        if ((await runBuildTask(entryFile)) !== 0) return;
      }
    }),

    vscode.commands.registerCommand('fasm2Studio.buildAndRun', async (resource?: vscode.Uri, selection?: vscode.Uri[]) => {
      const entryFile = await resolveBuildTarget('Building and running', resource);
      if (!entryFile) return;
      noteSingleTarget(entryFile, resource, selection);
      const exitCode = await runBuildTask(entryFile);
      if (exitCode === 0) {
        await runOutputBinary(getDefaultOutputPath(entryFile), path.dirname(entryFile), entryFile);
      }
    }),

    vscode.commands.registerCommand('fasm2Studio.run', async (resource?: vscode.Uri, selection?: vscode.Uri[]) => {
      const entryFile = await resolveBuildTarget('Running', resource);
      if (!entryFile) return;
      noteSingleTarget(entryFile, resource, selection);
      // The source file's directory, not the output's: fasm2Studio.buildOutputPath can send the
      // binary off to a "bin/" of its own, and a program's relative paths are written against
      // where its source lives. This is the same directory a debug launch defaults "cwd" to.
      await runOutputBinary(getDefaultOutputPath(entryFile), path.dirname(entryFile), entryFile);
    }),

    // Resolved through the same entry-point path as Build, so it removes exactly the files that
    // Build wrote — cleaning an included fragment cleans the program it is part of, rather than
    // looking for output next to a file that never produced any.
    vscode.commands.registerCommand('fasm2Studio.clean', async (resource?: vscode.Uri, selection?: vscode.Uri[]) => {
      await cleanBuildOutputs(await resolveBuildTargets('Cleaning', resource, selection));
    }),

    // The language client's own channel, which is where fasm2Studio.trace.server writes. Without a
    // command, reaching it means knowing to open the Output panel and pick the right entry from a
    // dropdown — so the setting that exists for bug reports had no obvious way to be read.
    vscode.commands.registerCommand('fasm2Studio.showOutput', () => {
      if (!client) {
        void vscode.window.showWarningMessage(`${MESSAGE_PREFIX}the language server is not running.`);
        return;
      }
      client.outputChannel.show(true);
    }),

    // The standard escape hatch every LSP-backed extension is expected to have. The server holds
    // a whole-workspace index and a compiler-discovery cache, so the recovery for "it has stopped
    // answering" or "I installed the compiler after opening the folder" was otherwise reloading
    // the entire window.
    vscode.commands.registerCommand('fasm2Studio.restartLanguageServer', async () => {
      if (!client) {
        void vscode.window.showWarningMessage(`${MESSAGE_PREFIX}the language server is not running.`);
        return;
      }
      invalidateCompilerCache();
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: `${MESSAGE_PREFIX}restarting the language server…` },
        async () => {
          await client!.restart();
        },
      );
      // The index lives in the server process, so it goes with it — rebuild rather than leaving
      // cross-file navigation quietly answering from nothing. Outside the progress call above
      // because it reports progress (and any failure) of its own.
      await runWorkspaceIndex(client);
    }),

    vscode.commands.registerCommand('fasm2Studio.debug', async (resource?: vscode.Uri, selection?: vscode.Uri[]) => {
      const file = await targetFasmFile(resource);
      if (!file) return;
      noteSingleTarget(file, resource, selection);

      // Deliberately not resolved/built here: passing the raw active file through with no
      // "program"/"listingFile" leaves FasmDebugConfigurationProvider.resolveDebugConfiguration as
      // the *one* place that resolves the entry point and builds, the same path F5/a launch.json
      // already goes through. Doing either step here too used to mean every "FASM: Debug" run
      // resolved and compiled the program twice.
      await vscode.debug.startDebugging(vscode.workspace.getWorkspaceFolder(vscode.Uri.file(file)), {
        type: FASM_DEBUG_TYPE,
        request: 'launch',
        name: 'Debug FASM program',
        asmFile: file,
        stopOnEntry: true,
      });
    })
  );
}

/**
 * Runs the workspace scan and records whether it actually finished.
 *
 * Every cross-file feature — go-to-definition across files, find-references, rename, symbol search
 * — answers from the index this builds. A scan that fails leaves those answering from a partial
 * one, which looks exactly like the features being unreliable rather than unavailable, so the
 * outcome is put somewhere the user can see it instead of into a console.
 */
async function runWorkspaceIndex(client: LanguageClient | undefined): Promise<void> {
  if (!client) return;
  try {
    const result = await indexWorkspace(client);
    setIndexingIssue(result.issue);
    if (result.issue) {
      client.outputChannel.appendLine(`${MESSAGE_PREFIX}workspace indexing did not finish: ${result.issue}`);
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    setIndexingIssue(reason);
    client.outputChannel.appendLine(`${MESSAGE_PREFIX}workspace indexing failed: ${reason}`);
  }
}

function startLanguageClient(context: vscode.ExtensionContext): LanguageClient {
  const serverModule = context.asAbsolutePath(path.join('dist', 'server.js'));
  const serverOptions: ServerOptions = {
    run: { module: serverModule, transport: TransportKind.ipc },
    debug: { module: serverModule, transport: TransportKind.ipc, options: { execArgv: ['--nolazy', '--inspect=6009'] } },
  };

  const fileWatcher = createFasmFileWatcher();
  context.subscriptions.push(fileWatcher);

  const clientOptions: LanguageClientOptions = {
    documentSelector: [
      { scheme: 'file', language: 'fasm' },
      { scheme: 'untitled', language: 'fasm' },
    ],
    // Live error checking works by compiling, so the server needs the same trust answer the
    // build/run/debug commands gate on — it runs in its own process and cannot read
    // vscode.workspace.isTrusted itself. Sent at initialize and updated by the
    // 'fasm2Studio/workspaceTrust' notification below if trust is granted later in the session.
    initializationOptions: { isTrusted: isWorkspaceTrusted() },
    synchronize: {
      configurationSection: CONFIG_SECTION,
      // Forwards create/change/delete events to the server as workspace/didChangeWatchedFiles,
      // keeping the workspace index in sync with files nobody has opened as an editor tab.
      fileEvents: fileWatcher,
    },
  };

  // Not disposed via context.subscriptions: deactivate() below is the one place that stops it,
  // awaited — VS Code calls deactivate() *and* disposes context.subscriptions on shutdown, so
  // registering a second, fire-and-forget stop() here raced the same client through two shutdowns.
  return new LanguageClient('fasm2Studio', 'FASM2 Studio Language Server', serverOptions, clientOptions);
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  registerCommands(context);
  registerSelectCompiler(context);
  registerSelectDebugger(context);
  registerSelectDialect(context);
  registerNewFile(context);
  registerPickProcess(context);
  registerReportIssue(context);
  registerStatusBarMenu(context, activeDiagnosticsIssue, activeIndexingIssue);
  createStatusBarItem(context);
  registerTerminalLinks(context);
  registerIncludeDrop(context);
  // Registered before the client exists on purpose: it reads `client` through the getter at the
  // moment a rename happens, and a rename during startup is better answered by doing nothing than
  // by a handler that isn't listening yet.
  registerIncludeRename(context, () => client);
  registerOpenBuildOutput(context, () => client);
  registerShowListing(context, () => client);
  registerCheckAll(context, () => client);
  context.subscriptions.push(vscode.tasks.registerTaskProvider(FASM_TASK_TYPE, new FasmTaskProvider(() => client)));

  const codeLens = registerCodeLens(context, () => client);
  const entryPointsView = registerEntryPointsView(context, () => client);

  context.subscriptions.push(
    vscode.debug.registerDebugConfigurationProvider(FASM_DEBUG_TYPE, new FasmDebugConfigurationProvider(context, () => client)),
    // Separately registered, and deliberately a different object — see FasmDynamicDebugConfiguration-
    // Provider. This is what puts FASM entries in the Run and Debug dropdown for a workspace with no
    // launch.json, where the panel otherwise offers only "create a launch.json file".
    vscode.debug.registerDebugConfigurationProvider(
      FASM_DEBUG_TYPE,
      new FasmDynamicDebugConfigurationProvider(),
      vscode.DebugConfigurationProviderTriggerKind.Dynamic,
    ),
    vscode.debug.registerDebugAdapterDescriptorFactory(FASM_DEBUG_TYPE, new FasmDebugAdapterDescriptorFactory(context)),
    vscode.languages.registerInlineValuesProvider({ language: 'fasm' }, new FasmInlineValuesProvider()),
    // Without this, debug hover falls back to the word under the cursor, which in assembly is never
    // the memory operand you were pointing at — see evaluatableExpression.ts.
    vscode.languages.registerEvaluatableExpressionProvider({ language: 'fasm' }, new FasmEvaluatableExpressionProvider()),
    { dispose: disposeInferiorTerminal },
    { dispose: disposeRunTerminal },
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (Object.values(COMPILER_PATH_SETTING).some((key) => e.affectsConfiguration(`${CONFIG_SECTION}.${key}`))) {
        invalidateCompilerCache();
      }
      // Both caches are keyed on a resolved path, so a setting that names a different binary makes
      // the cached answer describe a tool that is no longer the one in use.
      if (e.affectsConfiguration(`${CONFIG_SECTION}.gdbPath`)) invalidateDebuggerCache();
    }),
  );

  client = startLanguageClient(context);
  await client.start();
  // Registered after start(), since onNotification needs a running connection.
  registerDialectSuggestion(context, (method, handler) => client!.onNotification(method, handler));
  context.subscriptions.push(
    // "Live error checking is not actually running for this file, and here is why." Shown in the
    // status bar rather than as a popup: it describes a standing condition (a missing compiler, a
    // compile that times out on a large project), and a notification that came back on every
    // keystroke would be worse than the silence it replaces.
    client.onNotification('fasm2Studio/diagnosticsUnavailable', (params: { uri: string; reason?: string }) => {
      setDiagnosticsIssue(params.reason ? { uri: params.uri, reason: params.reason } : undefined);
    }),
  );
  // Granting trust mid-session has to reach the server too, or live error checking stays off
  // until the window is reloaded — the one state change here that a settings sync can't carry,
  // since trust is not a setting.
  onTrustGranted(context, () => {
    void client?.sendNotification('fasm2Studio/workspaceTrust', { isTrusted: true });
    refreshStatusBar();
  });
  // Whether a file is an entry point is a property of the *saved* include graph the server indexes,
  // so the answer behind the code lenses changes on save rather than on keystroke — adding a
  // `format` directive, or an `include` that pulls a fragment into a program, both land here.
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((document) => {
      if (isFasmDocument(document)) {
        codeLens.refresh();
        // Same trigger, same reason: adding or removing a `format` directive is exactly what moves
        // a file into or out of this list.
        void entryPointsView.refresh();
      }
    }),
  );
  await runWorkspaceIndex(client);
  // The first scan is what populates the entry-point list at all: lenses computed before it
  // finished would have found an empty one and rendered nothing until the next save.
  codeLens.refresh();
  // Awaited, unlike the lenses: this is the call that decides whether the Explorer grows a "FASM
  // Entry Points" section, and leaving activation to finish without it means a window that opened
  // on a folder rather than on a file shows nothing until something else happens to refresh.
  await entryPointsView.refresh();
}

export async function deactivate(): Promise<void> {
  await client?.stop();
}
