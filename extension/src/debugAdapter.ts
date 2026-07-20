import * as path from 'path';
import * as vscode from 'vscode';
import { dialectFor, getDefaultOutputPath, getListingPath } from './taskProvider';

export const FASM_DEBUG_TYPE = 'fasm';

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
        preLaunchTask: 'fasm: Debug build (active file)',
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
