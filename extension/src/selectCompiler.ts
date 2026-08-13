// "FASM: Select Compiler" — points the extension at an assembler executable.
//
// This is the recovery path when a compiler isn't on PATH: the status bar reports "compiler not
// found" and clicking it lands here, so it has to work for someone who does not know which setting
// holds the path.
//
// Its first step asks which of the two path settings to write, and that question used to read
// "Which dialect are you configuring a compiler path for?" — close enough to "which dialect is this
// project?" to be mistaken for it, which is exactly what happened. The wording below keeps the
// subject on executables, shows what each dialect currently resolves to, and names the command that
// does answer the other question.
//
// It also has to answer the case it was most likely to be reached from and used to have no reply
// to: nothing is installed at all. Every entry here used to end in a file dialog, so someone whose
// status bar said "compiler not found" because they have never installed an assembler was sent to
// browse a filesystem that has nothing to find — a dead end with no next step in it. The two
// entries below the dialect ones cover that: where to get one, and "look again" for the very
// common case of installing it in another window and coming back to a cached "not found".

import * as vscode from 'vscode';
import { resolveCompiler, invalidateCompilerCache } from './compilerDiscovery';
import { fasmConfig, MESSAGE_PREFIX } from './config';
import { refreshStatusBar } from './statusBar';
import { COMPILER_PATH_SETTING, Dialect, DIALECT_LABEL } from './types';

/** Where the assembler itself comes from. Used as the fallback when the walkthrough — the richer
 * surface, since it also explains that fasm2 is fasmg plus a wrapper — cannot be opened. */
export const DOWNLOAD_URL = 'https://flatassembler.net/download.php';

const WALKTHROUGH_ID = 'fasm2StudioSetup';

export type CompilerChoiceAction =
  /** Browse for the executable that `dialect`'s path setting should name. */
  | { kind: 'browse'; dialect: Dialect }
  /** Open the setup walkthrough, which says where to get an assembler for each platform. */
  | { kind: 'walkthrough' }
  /** Drop the cached probe result and detect again. */
  | { kind: 'rescan' };

export interface CompilerChoice {
  label: string;
  description: string;
  detail: string;
  action: CompilerChoiceAction;
}

/** Where each dialect's compiler currently resolves to, or undefined when none was found. */
export type ResolvedCompilers = Partial<Record<Dialect, { path: string; autoDetected: boolean } | undefined>>;

/**
 * The options offered, showing what each dialect resolves to today so it is clear the choice is
 * about executables. Pure, so the wording and the ordering can be asserted without a running
 * VS Code.
 *
 * Ordered the same way the status bar menu is (statusBarMenuItems.ts): whatever is currently
 * broken leads. With no assembler found anywhere, browsing for one is the entry least likely to
 * help — there is nothing on disk to browse to — so "get one" and "look again" come first. With a
 * working install they are the least likely to be wanted, and go last.
 */
export function compilerChoices(resolved: ResolvedCompilers): CompilerChoice[] {
  const browse: CompilerChoice[] = (Object.keys(DIALECT_LABEL) as Dialect[]).map((dialect) => {
    const current = resolved[dialect];
    return {
      label: DIALECT_LABEL[dialect],
      description: current ? `${current.path}${current.autoDetected ? ' (auto-detected)' : ''}` : 'not found',
      detail: `Sets ${COMPILER_PATH_SETTING[dialect]}. This does not change which dialect your project uses — run "FASM: Select Dialect" for that.`,
      action: { kind: 'browse', dialect },
    };
  });

  const walkthrough: CompilerChoice = {
    label: '$(cloud-download) I don’t have one yet',
    description: 'flatassembler.net',
    detail: 'Opens the setup walkthrough: where to download fasm2/fasm1, and where to put it so it is found automatically.',
    action: { kind: 'walkthrough' },
  };

  const rescan: CompilerChoice = {
    label: '$(refresh) Look again',
    description: 'detected once per session',
    detail: 'Re-runs detection. Use this after installing an assembler, rather than reloading the window.',
    action: { kind: 'rescan' },
  };

  const anyFound = (Object.keys(DIALECT_LABEL) as Dialect[]).some((dialect) => resolved[dialect]);
  return anyFound ? [...browse, rescan, walkthrough] : [walkthrough, rescan, ...browse];
}

export const SELECT_COMPILER_PLACEHOLDER = 'Which assembler executable do you want to point at?';

/** Asking someone who has no assembler which executable they want to point at is a question they
 * cannot answer; when detection found nothing, the prompt has to admit that first. */
export const NO_COMPILER_PLACEHOLDER = 'No assembler found — get one, or point at an executable you already have';

export function selectCompilerPlaceholder(resolved: ResolvedCompilers): string {
  const anyFound = (Object.keys(DIALECT_LABEL) as Dialect[]).some((dialect) => resolved[dialect]);
  return anyFound ? SELECT_COMPILER_PLACEHOLDER : NO_COMPILER_PLACEHOLDER;
}

async function resolveAll(): Promise<ResolvedCompilers> {
  const resolved: ResolvedCompilers = {};
  for (const dialect of Object.keys(DIALECT_LABEL) as Dialect[]) {
    resolved[dialect] = await resolveCompiler(dialect);
  }
  return resolved;
}

/**
 * Detection is cached for the whole session (compilerDiscovery.ts), so installing an assembler
 * while VS Code is open leaves it reporting "not found" until something invalidates that — which
 * previously meant restarting the language server or reloading the window, neither of which is a
 * step anyone would guess at from a status bar that says the compiler is missing.
 */
async function rescan(): Promise<void> {
  invalidateCompilerCache();
  const resolved = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: `${MESSAGE_PREFIX}looking for an assembler…` },
    () => resolveAll(),
  );
  refreshStatusBar();

  const found = (Object.keys(DIALECT_LABEL) as Dialect[])
    .filter((dialect) => resolved[dialect])
    .map((dialect) => `${DIALECT_LABEL[dialect]} (${resolved[dialect]!.path})`);

  if (found.length > 0) {
    void vscode.window.showInformationMessage(`${MESSAGE_PREFIX}found ${found.join(', ')}.`);
    return;
  }
  // Re-offers the menu rather than ending on the bad news: "still nothing" is precisely the state
  // in which the remaining entries — where to get one, or point at a path detection cannot guess —
  // are what the user needs next.
  const openSetup = 'How do I install one?';
  const choice = await vscode.window.showWarningMessage(
    `${MESSAGE_PREFIX}still no assembler found on PATH.`,
    openSetup,
  );
  if (choice === openSetup) await openSetupWalkthrough();
}

let extensionId: string | undefined;

/** The walkthrough carries the platform-by-platform install instructions, so it is the honest
 * answer to "I don't have one yet" — the download page alone doesn't say where to put the binary
 * for detection to find it, or that a bare fasmg needs the preload settings. Falls back to the
 * download page if the walkthrough can't be opened (an id mismatch, or a VS Code that has moved
 * the command), since ending on nothing is the failure this entry exists to remove. */
export async function openSetupWalkthrough(): Promise<void> {
  try {
    if (!extensionId) throw new Error('extension id unknown');
    await vscode.commands.executeCommand('workbench.action.openWalkthrough', `${extensionId}#${WALKTHROUGH_ID}`, false);
  } catch {
    await vscode.env.openExternal(vscode.Uri.parse(DOWNLOAD_URL));
  }
}

async function browseFor(dialect: Dialect, label: string): Promise<void> {
  const chosen = await vscode.window.showOpenDialog({
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: false,
    title: `Select the ${label} executable`,
  });
  if (!chosen || chosen.length === 0) return;

  // Global on purpose: where a tool is installed is a property of the machine, not of one
  // project — unlike the dialect, which Select Dialect writes into the workspace.
  await fasmConfig().update(COMPILER_PATH_SETTING[dialect], chosen[0].fsPath, vscode.ConfigurationTarget.Global);
  invalidateCompilerCache();
  // The status bar names the resolved compiler, so it is stale the moment this returns.
  // onDidChangeConfiguration would eventually cover it, but only once VS Code has finished
  // persisting the write — refresh explicitly so the bar reflects the choice as soon as the
  // confirmation appears, not a beat later.
  refreshStatusBar();
  void vscode.window.showInformationMessage(`${MESSAGE_PREFIX}${label} compiler set to ${chosen[0].fsPath}`);
}

export function registerSelectCompiler(context: vscode.ExtensionContext): void {
  extensionId = context.extension.id;
  context.subscriptions.push(
    vscode.commands.registerCommand('fasm2Studio.selectCompiler', async () => {
      const resolved = await resolveAll();

      const picked = await vscode.window.showQuickPick(compilerChoices(resolved), {
        placeHolder: selectCompilerPlaceholder(resolved),
        matchOnDescription: true,
      });
      if (!picked) return;

      switch (picked.action.kind) {
        case 'browse':
          await browseFor(picked.action.dialect, picked.label);
          return;
        case 'walkthrough':
          await openSetupWalkthrough();
          return;
        case 'rescan':
          await rescan();
          return;
      }
    }),
  );
}
