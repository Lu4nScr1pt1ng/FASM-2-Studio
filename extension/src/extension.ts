import * as path from 'path';
import * as vscode from 'vscode';
import { LanguageClient, LanguageClientOptions, ServerOptions, TransportKind } from 'vscode-languageclient/node';
import { activeFasmEditor, NO_ACTIVE_FASM_FILE_MESSAGE } from './activeEditor';
import { getDefaultOutputPath } from './buildPaths';
import { cleanBuildOutput } from './clean';
import { invalidateCompilerCache } from './compilerDiscovery';
import { CONFIG_SECTION, MESSAGE_PREFIX } from './config';
import { registerDialectSuggestion } from './dialectSuggestion';
import { registerNewFile } from './newFile';
import { registerSelectCompiler } from './selectCompiler';
import { registerSelectDialect } from './selectDialect';
import { FasmDebugAdapterDescriptorFactory, FasmDebugConfigurationProvider, FASM_DEBUG_TYPE } from './debugAdapter';
import { resolveEntryPointFsPath } from './entryPointResolver';
import { FasmInlineValuesProvider } from './inlineValues';
import { registerPickProcess } from './pickProcess';
import { runOutputBinary } from './runCommand';
import { activeDiagnosticsIssue, createStatusBarItem, refreshStatusBar, setDiagnosticsIssue } from './statusBar';
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
function targetFasmFile(resource?: vscode.Uri): string | undefined {
  if (resource) return resource.fsPath;
  const editor = activeFasmEditor();
  if (!editor) {
    void vscode.window.showWarningMessage(NO_ACTIVE_FASM_FILE_MESSAGE);
    return undefined;
  }
  return editor.document.uri.fsPath;
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
  const file = targetFasmFile(resource);
  if (!file) return undefined;
  return resolveActiveEntryFile(file);
}

function registerCommands(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('fasm2Studio.build', async (resource?: vscode.Uri) => {
      const entryFile = await resolveBuildTarget('Building', resource);
      if (entryFile) await runBuildTask(entryFile);
    }),

    vscode.commands.registerCommand('fasm2Studio.buildAndRun', async (resource?: vscode.Uri) => {
      const entryFile = await resolveBuildTarget('Building and running', resource);
      if (!entryFile) return;
      const exitCode = await runBuildTask(entryFile);
      if (exitCode === 0) {
        await runOutputBinary(getDefaultOutputPath(entryFile));
      }
    }),

    vscode.commands.registerCommand('fasm2Studio.run', async (resource?: vscode.Uri) => {
      const entryFile = await resolveBuildTarget('Running', resource);
      if (!entryFile) return;
      await runOutputBinary(getDefaultOutputPath(entryFile));
    }),

    // Resolved through the same entry-point path as Build, so it removes exactly the files that
    // Build wrote — cleaning an included fragment cleans the program it is part of, rather than
    // looking for output next to a file that never produced any.
    vscode.commands.registerCommand('fasm2Studio.clean', async (resource?: vscode.Uri) => {
      const entryFile = await resolveBuildTarget('Cleaning', resource);
      if (entryFile) await cleanBuildOutput(entryFile);
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
          // The index lives in the server process, so it goes with it — rebuild rather than
          // leaving cross-file navigation quietly answering from nothing.
          await indexWorkspace(client!);
        },
      );
    }),

    vscode.commands.registerCommand('fasm2Studio.debug', async (resource?: vscode.Uri) => {
      const file = targetFasmFile(resource);
      if (!file) return;

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
  registerSelectDialect(context);
  registerNewFile(context);
  registerPickProcess(context);
  registerStatusBarMenu(context, activeDiagnosticsIssue);
  createStatusBarItem(context);
  registerTerminalLinks(context);
  context.subscriptions.push(vscode.tasks.registerTaskProvider(FASM_TASK_TYPE, new FasmTaskProvider()));

  context.subscriptions.push(
    vscode.debug.registerDebugConfigurationProvider(FASM_DEBUG_TYPE, new FasmDebugConfigurationProvider(() => client)),
    vscode.debug.registerDebugAdapterDescriptorFactory(FASM_DEBUG_TYPE, new FasmDebugAdapterDescriptorFactory(context)),
    vscode.languages.registerInlineValuesProvider({ language: 'fasm' }, new FasmInlineValuesProvider()),
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (Object.values(COMPILER_PATH_SETTING).some((key) => e.affectsConfiguration(`${CONFIG_SECTION}.${key}`))) {
        invalidateCompilerCache();
      }
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
  void indexWorkspace(client).catch((err) => console.error(`${MESSAGE_PREFIX}workspace indexing failed`, err));
}

export async function deactivate(): Promise<void> {
  await client?.stop();
}
