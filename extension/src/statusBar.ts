// The one always-visible piece of this extension's state: which dialect the active file is being
// treated as, and which executable will actually assemble it.
//
// Everything it displays is derived — from settings, from the file's own contents, and from a PATH
// probe — so it has to be recomputed whenever any of those change, not just when the active editor
// does. Refreshing on editor switches alone left it confidently reporting the *previous* compiler
// after "FASM: Select Compiler" had just changed it, the previous dialect after "FASM: Select
// Dialect", and the pre-edit dialect while typing the very marker (`end macro`, `namespace`, ...)
// that flips it. A status bar that is wrong is worse than one that is absent, since it is the
// thing users check to confirm the extension picked up their configuration at all.

import * as vscode from 'vscode';
import { isFasmDocument } from './activeEditor';
import { dialectForDocument } from './buildPaths';
import { resolveCompiler } from './compilerDiscovery';
import { CONFIG_SECTION } from './config';

/** How long to wait after a keystroke before re-detecting the dialect. Detection is a regex scan
 * over the whole buffer, so it is cheap but not free; this keeps it off the per-keystroke path
 * while still settling well inside the pause between one edit and reading the result. */
const REFRESH_DEBOUNCE_MS = 300;

/** Set once by createStatusBarItem, so commands that change what the bar displays can force it to
 * catch up immediately rather than waiting for an unrelated editor switch. */
let refreshNow: (() => void) | undefined;

/** Re-renders the status bar from current settings/document state. Safe to call before the bar
 * exists (a no-op then) and safe to call repeatedly — refreshes coalesce. */
export function refreshStatusBar(): void {
  refreshNow?.();
}

/**
 * Set when the language server reports it cannot run the compiler at all for the active file
 * (see the 'fasm2Studio/diagnosticsUnavailable' notification). Held here rather than shown as a
 * popup: a compiler that times out on a large project would otherwise nag on every keystroke,
 * while the status bar can state it permanently and quietly.
 */
let diagnosticsIssue: { uri: string; reason: string } | undefined;

export function setDiagnosticsIssue(issue: { uri: string; reason: string } | undefined): void {
  diagnosticsIssue = issue;
  refreshStatusBar();
}

export function createStatusBarItem(context: vscode.ExtensionContext): vscode.StatusBarItem {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  context.subscriptions.push(item);

  // Guards against a slow resolveCompiler for an editor the user has already switched away from
  // overwriting the text computed for the editor they are actually looking at now.
  let generation = 0;

  const render = async (editor: vscode.TextEditor | undefined): Promise<void> => {
    const mine = ++generation;
    if (!editor || !isFasmDocument(editor.document)) {
      item.hide();
      return;
    }

    try {
      const dialect = dialectForDocument(editor.document);
      const compiler = await resolveCompiler(dialect, editor.document.uri);
      if (mine !== generation) return;

      const issue = diagnosticsIssue?.uri === editor.document.uri.toString() ? diagnosticsIssue : undefined;
      if (!compiler) {
        item.text = `$(warning) ${dialect}: compiler not found`;
        item.tooltip = 'FASM2 Studio — no compiler found on PATH. Click to configure one.';
        item.command = 'fasm2Studio.selectCompiler';
      } else if (issue) {
        item.text = `$(warning) ${dialect}: diagnostics unavailable`;
        item.tooltip = `FASM2 Studio — using ${compiler.path}, but live error checking is not running: ${issue.reason}. Click to change the compiler.`;
        item.command = 'fasm2Studio.selectCompiler';
      } else {
        item.text = `$(tools) ${dialect} (${compiler.path})`;
        item.tooltip = `FASM2 Studio — using ${compiler.path}${compiler.autoDetected ? ' (auto-detected)' : ''}. Click to change.`;
        item.command = 'fasm2Studio.selectCompiler';
      }
      item.show();
    } catch {
      if (mine === generation) item.hide();
    }
  };

  let debounce: ReturnType<typeof setTimeout> | undefined;
  const refresh = (): void => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => {
      debounce = undefined;
      void render(vscode.window.activeTextEditor);
    }, REFRESH_DEBOUNCE_MS);
  };
  refreshNow = refresh;

  context.subscriptions.push(
    // Switching editors is the one case worth rendering immediately: the bar is describing a
    // different file than a moment ago, and a debounce there reads as lag rather than smoothing.
    vscode.window.onDidChangeActiveTextEditor((editor) => void render(editor)),
    // A settings edit can change the compiler path, the default dialect, or (via the resource
    // scope) which folder's value applies at all.
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(CONFIG_SECTION)) refresh();
    }),
    // Only the active document's own edits can change what is displayed.
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document === vscode.window.activeTextEditor?.document && isFasmDocument(e.document)) refresh();
    }),
    { dispose: () => { if (debounce) clearTimeout(debounce); refreshNow = undefined; } },
  );

  void render(vscode.window.activeTextEditor);

  return item;
}
