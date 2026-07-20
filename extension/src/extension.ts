import * as path from 'path';
import * as vscode from 'vscode';
import { LanguageClient, LanguageClientOptions, ServerOptions, TransportKind } from 'vscode-languageclient/node';
import { invalidateCompilerCache } from './compilerDiscovery';
import { FasmDebugAdapterDescriptorFactory, FasmDebugConfigurationProvider, FASM_DEBUG_TYPE } from './debugAdapter';
import { runOutputBinary } from './runCommand';
import { createStatusBarItem } from './statusBar';
import { buildTask, FASM_TASK_TYPE, FasmTaskDefinition, FasmTaskProvider, getDefaultOutputPath, getListingPath } from './taskProvider';
import { Dialect } from './types';
import { createFasmFileWatcher, indexWorkspace } from './workspaceIndexer';

let client: LanguageClient | undefined;

function activeFasmFile(): string | undefined {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== 'fasm') {
    void vscode.window.showWarningMessage('FASM2 Studio: open a .asm/.inc file first.');
    return undefined;
  }
  return editor.document.uri.fsPath;
}

async function runBuildTask(file: string, debugBuild = false): Promise<number | undefined> {
  const def: FasmTaskDefinition = { type: FASM_TASK_TYPE, file, debugBuild };
  let task: vscode.Task;
  try {
    task = await buildTask(def, debugBuild ? 'Debug build (active file)' : 'Build active file');
  } catch (err) {
    void vscode.window.showErrorMessage((err as Error).message);
    return undefined;
  }

  const execution = await vscode.tasks.executeTask(task);
  return new Promise<number | undefined>((resolve) => {
    const disposable = vscode.tasks.onDidEndTaskProcess((e) => {
      if (e.execution === execution) {
        disposable.dispose();
        resolve(e.exitCode);
      }
    });
  });
}

function registerCommands(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('fasm2Studio.build', async () => {
      const file = activeFasmFile();
      if (file) await runBuildTask(file);
    }),

    vscode.commands.registerCommand('fasm2Studio.buildAndRun', async () => {
      const file = activeFasmFile();
      if (!file) return;
      const exitCode = await runBuildTask(file);
      if (exitCode === 0) {
        await runOutputBinary(getDefaultOutputPath(file));
      }
    }),

    vscode.commands.registerCommand('fasm2Studio.run', async () => {
      const file = activeFasmFile();
      if (!file) return;
      await runOutputBinary(getDefaultOutputPath(file));
    }),

    vscode.commands.registerCommand('fasm2Studio.debug', async () => {
      const file = activeFasmFile();
      if (!file) return;

      const exitCode = await runBuildTask(file, true);
      if (exitCode !== 0) return;

      const program = getDefaultOutputPath(file);
      await vscode.debug.startDebugging(vscode.workspace.getWorkspaceFolder(vscode.Uri.file(file)), {
        type: FASM_DEBUG_TYPE,
        request: 'launch',
        name: 'Debug FASM program',
        asmFile: file,
        program,
        listingFile: getListingPath(program),
        cwd: path.dirname(file),
        stopOnEntry: true,
      });
    }),

    vscode.commands.registerCommand('fasm2Studio.selectCompiler', async () => {
      const dialect = await vscode.window.showQuickPick<{ label: string; dialect: Dialect }>(
        [
          { label: 'fasm2 / fasmg', dialect: 'fasm2' },
          { label: 'fasm1 (classic)', dialect: 'fasm1' },
        ],
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

      const key = dialect.dialect === 'fasm1' ? 'fasm1CompilerPath' : 'fasm2CompilerPath';
      await vscode.workspace.getConfiguration('fasm2Studio').update(key, picked[0].fsPath, vscode.ConfigurationTarget.Global);
      invalidateCompilerCache();
      void vscode.window.showInformationMessage(`FASM2 Studio: ${dialect.label} compiler set to ${picked[0].fsPath}`);
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
      configurationSection: 'fasm2Studio',
      // Forwards create/change/delete events to the server as workspace/didChangeWatchedFiles,
      // keeping the workspace index in sync with files nobody has opened as an editor tab.
      fileEvents: fileWatcher,
    },
  };

  const languageClient = new LanguageClient('fasm2Studio', 'FASM2 Studio Language Server', serverOptions, clientOptions);
  context.subscriptions.push({ dispose: () => void languageClient.stop() });
  return languageClient;
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  registerCommands(context);
  createStatusBarItem(context);
  context.subscriptions.push(vscode.tasks.registerTaskProvider(FASM_TASK_TYPE, new FasmTaskProvider()));

  context.subscriptions.push(
    vscode.debug.registerDebugConfigurationProvider(FASM_DEBUG_TYPE, new FasmDebugConfigurationProvider()),
    vscode.debug.registerDebugAdapterDescriptorFactory(FASM_DEBUG_TYPE, new FasmDebugAdapterDescriptorFactory(context)),
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('fasm2Studio.fasm2CompilerPath') || e.affectsConfiguration('fasm2Studio.fasm1CompilerPath')) {
        invalidateCompilerCache();
      }
    }),
  );

  client = startLanguageClient(context);
  await client.start();
  void indexWorkspace(client).catch((err) => console.error('FASM2 Studio: workspace indexing failed', err));
}

export async function deactivate(): Promise<void> {
  await client?.stop();
}
