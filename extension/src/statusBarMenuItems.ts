// What the status bar menu offers, and in what order. Kept free of any `vscode` import so the
// ordering — the part with actual behaviour in it — can be asserted without a running editor;
// statusBarMenu.ts turns these into a real QuickPick. The shape below is structurally a
// vscode.QuickPickItem, which is all showQuickPick asks for.

import { InlayHintsMode, inlayHintsSummary } from './inlayHintsChoices';
import { Dialect, DIALECT_LABEL } from './types';

export interface MenuState {
  dialect: Dialect;
  /** Resolved compiler path, or undefined when none could be found. */
  compilerPath: string | undefined;
  diagnosticsEnabled: boolean;
  /** Current fasm2Studio.inlayHints mode. */
  inlayHints: InlayHintsMode;
  /** Set when the server reported it cannot run the compiler for this file (see statusBar.ts). */
  diagnosticsIssue: string | undefined;
  /** Set when the workspace scan behind every cross-file feature did not finish (see
   * statusBar.ts). Restarting the server is what rebuilds it, so that entry leads when this is
   * the standing problem. */
  indexingIssue?: string | undefined;
}

export interface MenuItem {
  label: string;
  description?: string;
  detail?: string;
  /** Command to run when picked, or the marker below for the built-in diagnostics toggle. */
  action: string;
}

/** The diagnostics switch is not a command anywhere else — it exists only here, since a setting
 * with one obvious on/off meaning is better flipped in place than hunted for in the settings UI. */
export const TOGGLE_DIAGNOSTICS_ACTION = 'fasm2Studio.internal.toggleDiagnostics';

/**
 * The menu, ordered so that whatever is currently broken comes first: a missing compiler makes
 * every other entry moot, and live error checking that has stopped working is the next most likely
 * reason someone clicked. With nothing wrong, the dialect leads — it is the setting that is wrong
 * most often, and the one detection cannot settle on its own.
 */
export function menuItems(state: MenuState): MenuItem[] {
  const compiler: MenuItem = {
    label: state.compilerPath ? '$(tools) Change compiler' : '$(warning) Find a compiler',
    description: state.compilerPath ?? 'none found on PATH',
    detail: state.compilerPath
      ? 'Pick which assembler executable builds this project.'
      : 'Nothing to build with yet — install fasm2/fasm1, or point at an existing copy.',
    action: 'fasm2Studio.selectCompiler',
  };

  const dialect: MenuItem = {
    label: '$(symbol-namespace) Change dialect',
    description: DIALECT_LABEL[state.dialect],
    detail: 'fasm2 is detected from the source itself; a fasm1 project has to say so once.',
    action: 'fasm2Studio.selectDialect',
  };

  const diagnostics: MenuItem = {
    label: state.diagnosticsEnabled ? '$(circle-slash) Turn off live error checking' : '$(check) Turn on live error checking',
    description: state.diagnosticsIssue ? `not running: ${state.diagnosticsIssue}` : state.diagnosticsEnabled ? 'on' : 'off',
    detail: state.diagnosticsEnabled
      ? 'Stops assembling in the background as you type. Errors then only appear when you build.'
      : 'Assembles in the background as you type and reports the compiler’s own errors.',
    action: TOGGLE_DIAGNOSTICS_ACTION,
  };

  // The one entry here that offers a feature rather than a setting to correct. It earns the space
  // because nothing else in the UI mentions the annotations at all: they are off by default and
  // were reachable only from their own row in the settings editor, so the single most fasm-specific
  // thing this extension does was invisible to anyone who never went looking for it.
  const inlayHints: MenuItem = {
    label: '$(symbol-numeric) Annotate instructions inline',
    description: inlayHintsSummary(state.inlayHints),
    detail: 'Show the address each instruction lands at and the bytes it encodes to, without building a listing.',
    action: 'fasm2Studio.selectInlayHints',
  };

  const restart: MenuItem = {
    label: '$(debug-restart) Restart language server',
    description: state.indexingIssue ? `index incomplete: ${state.indexingIssue}` : undefined,
    detail: 'Rebuilds the workspace index and re-detects the compiler.',
    action: 'fasm2Studio.restartLanguageServer',
  };

  const rest: MenuItem[] = [
    // Ahead of the log and the restart, and behind everything above: it is the only entry that
    // offers something rather than fixing something, so it belongs after whatever is wrong and
    // before the entries you reach for only when writing a bug report.
    inlayHints,
    {
      label: '$(output) Show language server log',
      detail: 'The extension’s own output channel — start here for a bug report.',
      action: 'fasm2Studio.showOutput',
    },
    restart,
    {
      label: '$(bug) Report an issue',
      detail: 'Collects your platform, versions and resolved tool paths into a report to attach.',
      action: 'fasm2Studio.reportIssue',
    },
  ];

  if (!state.compilerPath) return [compiler, dialect, diagnostics, ...rest];
  if (state.diagnosticsIssue) return [diagnostics, compiler, dialect, ...rest];
  // A stale index makes navigation quietly wrong rather than visibly broken, so when that is the
  // standing problem the one action that fixes it leads instead of sitting last.
  if (state.indexingIssue) return [restart, dialect, compiler, diagnostics, ...rest.filter((i) => i !== restart)];
  return [dialect, compiler, diagnostics, ...rest];
}
