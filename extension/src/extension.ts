import * as path from 'path';
import * as vscode from 'vscode';
import { LanguageClient, LanguageClientOptions, ServerOptions, TransportKind } from 'vscode-languageclient/node';
import { activeFasmEditor, NO_ACTIVE_FASM_FILE_MESSAGE } from './activeEditor';
import { getDefaultOutputPath } from './buildPaths';
import { invalidateCompilerCache } from './compilerDiscovery';
import { CONFIG_SECTION, fasmConfig, MESSAGE_PREFIX } from './config';
import { registerDialectSuggestion } from './dialectSuggestion';
import { registerSelectDialect } from './selectDialect';
import { FasmDebugAdapterDescriptorFactory, FasmDebugConfigurationProvider, FASM_DEBUG_TYPE } from './debugAdapter';
import { resolveEntryPointFsPath } from './entryPointResolver';
import { FasmInlineValuesProvider } from './inlineValues';
import { runOutputBinary } from './runCommand';
import { createStatusBarItem } from './statusBar';
import { FASM_TASK_TYPE, FasmTaskProvider, runBuildTask } from './taskProvider';
import { COMPILER_PATH_SETTING, Dialect, DIALECT_LABEL } from './types';
import { createFasmFileWatcher, indexWorkspace } from './workspaceIndexer';

let client: LanguageClient | undefined;

function activeFasmFile(): string | undefined {
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

/** Active file → resolved build entry point, or undefined if either step failed (each already
 * shows its own error/warning). Shared preamble for the build/buildAndRun/run commands. */
async function resolveBuildTarget(): Promise<string | undefined> {
  const file = activeFasmFile();
  if (!file) return undefined;
  return resolveActiveEntryFile(file);
}

function registerCommands(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('fasm2Studio.build', async () => {
      const entryFile = await resolveBuildTarget();
      if (entryFile) await runBuildTask(entryFile);
    }),

    vscode.commands.registerCommand('fasm2Studio.buildAndRun', async () => {
      const entryFile = await resolveBuildTarget();
      if (!entryFile) return;
      const exitCode = await runBuildTask(entryFile);
      if (exitCode === 0) {
        await runOutputBinary(getDefaultOutputPath(entryFile));
      }
    }),

    vscode.commands.registerCommand('fasm2Studio.run', async () => {
      const entryFile = await resolveBuildTarget();
      if (!entryFile) return;
      await runOutputBinary(getDefaultOutputPath(entryFile));
    }),

    vscode.commands.registerCommand('fasm2Studio.debug', async () => {
      const file = activeFasmFile();
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
    }),

    vscode.commands.registerCommand('fasm2Studio.selectCompiler', async () => {
      const dialect = await vscode.window.showQuickPick<{ label: string; dialect: Dialect }>(
        (Object.keys(DIALECT_LABEL) as Dialect[]).map((d) => ({ label: DIALECT_LABEL[d], dialect: d })),
        { placeHolder: 'Which dialect are you configuring a compiler path for?' },
      );
      if (!dialect) return;

      const picked = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        title: `Select the ${dialect.label} executable`,
      });
      if (!picked || picked.length === 0) return;

      const key = COMPILER_PATH_SETTING[dialect.dialect];
      await fasmConfig().update(key, picked[0].fsPath, vscode.ConfigurationTarget.Global);
      invalidateCompilerCache();
      void vscode.window.showInformationMessage(`${MESSAGE_PREFIX}${dialect.label} compiler set to ${picked[0].fsPath}`);
    }),
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
  registerSelectDialect(context);
  createStatusBarItem(context);
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
  void indexWorkspace(client).catch((err) => console.error(`${MESSAGE_PREFIX}workspace indexing failed`, err));
}

export async function deactivate(): Promise<void> {
  await client?.stop();
}
