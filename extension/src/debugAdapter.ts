import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { dialectFor, getDefaultOutputPath, getListingPath, runBuildTask } from './taskProvider';

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
    if (!config.type && !config.request) {
      // Launched via F5 with no launch.json at all: fall back to the active editor.
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.languageId !== 'fasm') {
        void vscode.window.showErrorMessage('FASM debug: open a .asm file first.');
        return undefined;
      }
      config = this.provideDebugConfigurations()[0];
      config.asmFile = editor.document.uri.fsPath;
    }

    const asmFile = config.asmFile as string;
    if (!asmFile) {
      void vscode.window.showErrorMessage('FASM debug: no source file specified (set "asmFile" in launch.json).');
      return undefined;
    }

    const dialect = await dialectFor(asmFile);
    if (dialect !== 'fasm2') {
      void vscode.window.showErrorMessage('FASM debug currently only supports fasm2/fasmg sources.');
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
        void vscode.window.showErrorMessage(`FASM debug: build succeeded but the expected listing file was not found: ${expectedListing}`);
        return undefined;
      }
    }

    const program = (config.program as string) ?? getDefaultOutputPath(asmFile);
    config.program = program;
    config.listingFile = (config.listingFile as string) ?? getListingPath(program);
    config.cwd = (config.cwd as string) ?? path.dirname(asmFile);
    if (!config.gdbPath) {
      const configuredGdb = vscode.workspace.getConfiguration('fasm2Studio').get<string>('gdbPath');
      if (configuredGdb) config.gdbPath = configuredGdb;
    }
    return config;
  }
}
