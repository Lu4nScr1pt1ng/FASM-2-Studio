import * as vscode from 'vscode';
import { resolveCompiler } from './compilerDiscovery';
import { dialectFor } from './taskProvider';

export function createStatusBarItem(context: vscode.ExtensionContext): vscode.StatusBarItem {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  item.command = 'fasm2Studio.selectCompiler';
  context.subscriptions.push(item);

  const refresh = async (editor: vscode.TextEditor | undefined) => {
    if (!editor || editor.document.languageId !== 'fasm') {
      item.hide();
      return;
    }

    try {
      const dialect = await dialectFor(editor.document.uri.fsPath);
      const compiler = resolveCompiler(dialect);
      item.text = compiler ? `$(tools) ${dialect} (${compiler.path})` : `$(warning) ${dialect}: compiler not found`;
      item.tooltip = compiler
        ? `FASM2 Studio — using ${compiler.path}${compiler.autoDetected ? ' (auto-detected)' : ''}. Click to change.`
        : 'FASM2 Studio — no compiler found on PATH. Click to configure one.';
      item.show();
    } catch {
      item.hide();
    }
  };

  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(refresh));
  void refresh(vscode.window.activeTextEditor);

  return item;
}
