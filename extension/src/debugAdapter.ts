import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { LanguageClient } from 'vscode-languageclient/node';
import { activeFasmEditor, NO_ACTIVE_FASM_FILE_MESSAGE } from './activeEditor';
import { dialectFor, getDefaultOutputPath, getListingPath } from './buildPaths';
import { fasmConfig, MESSAGE_PREFIX } from './config';
import { resolveEntryPointFsPath } from './entryPointResolver';
import { runBuildTask } from './taskProvider';
import { ensureTrusted } from './workspaceTrust';

export const FASM_DEBUG_TYPE = 'fasm';

/**
 * Waits for a file to appear, briefly. `vscode.tasks.onDidEndTaskProcess` firing (a build task
 * reporting exit code 0) doesn't strictly guarantee the file it just wrote is visible to this
 * process's very next `fs` call yet — observed as a rare race where the debug adapter's launch
 * request fails with ENOENT on a listing file the build just successfully produced.
 */
async function waitForFile(filePath: string, timeoutMs = 2000): Promise<boolean> {
  const start = Date.now();
  while (!fs.existsSync(filePath)) {
    if (Date.now() - start >= timeoutMs) return false;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return true;
}

export class FasmDebugAdapterDescriptorFactory implements vscode.DebugAdapterDescriptorFactory {
  constructor(private readonly context: vscode.ExtensionContext) {}

  createDebugAdapterDescriptor(): vscode.DebugAdapterDescriptor {
    const adapterPath = this.context.asAbsolutePath(path.join('dist', 'adapter.js'));
    return new vscode.DebugAdapterExecutable(process.execPath, [adapterPath]);
  }
}

export class FasmDebugConfigurationProvider implements vscode.DebugConfigurationProvider {
  /** A getter, not the client itself: the language client isn't started yet when this provider
   * is constructed during activation, so the current value has to be looked up at call time. */
  constructor(private readonly getClient: () => LanguageClient | undefined) {}

  provideDebugConfigurations(): vscode.DebugConfiguration[] {
    return [
      {
        type: FASM_DEBUG_TYPE,
        request: 'launch',
        name: 'Debug FASM program',
        asmFile: '${file}',
        stopOnEntry: true,
      },
    ];
  }

  async resolveDebugConfiguration(
    _folder: vscode.WorkspaceFolder | undefined,
    config: vscode.DebugConfiguration,
  ): Promise<vscode.DebugConfiguration | undefined> {
    // Gated here rather than in the FASM: Debug command because this is the only point every
    // launch passes through — F5 against a launch.json entry never touches that command.
    if (!(await ensureTrusted('Debugging'))) return undefined;

    if (!config.type && !config.request) {
      // Launched via F5 with no launch.json at all: fall back to the active editor.
      const editor = activeFasmEditor();
      if (!editor) {
        void vscode.window.showErrorMessage(NO_ACTIVE_FASM_FILE_MESSAGE);
        return undefined;
      }
      config = this.provideDebugConfigurations()[0];
      config.asmFile = editor.document.uri.fsPath;
    }

    let asmFile = config.asmFile as string;
    if (!asmFile) {
      void vscode.window.showErrorMessage(`${MESSAGE_PREFIX}no source file specified (set "asmFile" in launch.json).`);
      return undefined;
    }

    // asmFile may be a fragment (no "format" directive of its own) — resolve to the real entry
    // point it should actually build/debug as, same as the FASM: Build/Run/Debug commands. If the
    // language server isn't up yet, fall back to asmFile as-is rather than blocking the launch.
    const client = this.getClient();
    if (client) {
      const entryFile = await resolveEntryPointFsPath(client, asmFile);
      if (!entryFile) return undefined;
      asmFile = entryFile;
      config.asmFile = entryFile;
    }

    const dialect = await dialectFor(asmFile);
    if (dialect !== 'fasm2') {
      void vscode.window.showErrorMessage(`${MESSAGE_PREFIX}Debug currently only supports fasm2/fasmg sources.`);
      return undefined;
    }

    // VS Code resolves and runs preLaunchTask *before* calling this method at all — by the time
    // we're here, a broken task-label lookup has already failed the launch, so nothing set here
    // could fix it after the fact. Our generated configs never set preLaunchTask for exactly this
    // reason: build directly instead, ourselves, right now. A launch.json with a genuinely custom
    // preLaunchTask is left alone — that's an explicit user choice, resolved by VS Code as usual.
    if (!config.preLaunchTask) {
      const exitCode = await runBuildTask(asmFile, true);
      if (exitCode !== 0) return undefined;

      const expectedListing = getListingPath(getDefaultOutputPath(asmFile));
      if (!(await waitForFile(expectedListing))) {
        void vscode.window.showErrorMessage(`${MESSAGE_PREFIX}build succeeded but the expected listing file was not found: ${expectedListing}`);
        return undefined;
      }
    }

    // launch.json's values are typed "any" by VS Code — a hand-edited config with e.g. a numeric
    // "program" would otherwise flow silently into getListingPath/path.dirname below and fail with
    // an obscure downstream error instead of a clear one naming the actual bad field.
    for (const key of ['program', 'listingFile', 'cwd'] as const) {
      if (config[key] !== undefined && typeof config[key] !== 'string') {
        void vscode.window.showErrorMessage(`${MESSAGE_PREFIX}"${key}" in launch.json must be a string.`);
        return undefined;
      }
    }

    // A terminal by default, not the Debug Console: assembly programs are console programs, and a
    // program blocked on a `read` syscall with no stdin to answer it looks exactly like a hung
    // debugger. Output-only programs are unaffected beyond which panel their output lands in.
    const CONSOLE_KINDS = ['integratedTerminal', 'externalTerminal', 'debugConsole'];
    if (config.console === undefined) {
      config.console = 'integratedTerminal';
    } else if (!CONSOLE_KINDS.includes(config.console as string)) {
      void vscode.window.showErrorMessage(`${MESSAGE_PREFIX}"console" in launch.json must be one of ${CONSOLE_KINDS.join(', ')}.`);
      return undefined;
    }

    const program = (config.program as string) ?? getDefaultOutputPath(asmFile);
    config.program = program;
    config.listingFile = (config.listingFile as string) ?? getListingPath(program);
    config.cwd = (config.cwd as string) ?? path.dirname(asmFile);
    if (!config.gdbPath) {
      const configuredGdb = fasmConfig().get<string>('gdbPath');
      if (configuredGdb) config.gdbPath = configuredGdb;
    }
    return config;
  }
}
