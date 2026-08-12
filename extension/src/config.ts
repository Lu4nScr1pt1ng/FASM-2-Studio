import * as vscode from 'vscode';

export const CONFIG_SECTION = 'fasm2Studio';

/**
 * Shorthand for `vscode.workspace.getConfiguration(CONFIG_SECTION, resource)`, kept in one place
 * so the section name is never duplicated as a bare string across call sites.
 *
 * `resource` is the file the setting is being read *on behalf of*, and passing it is what makes
 * per-folder settings work at all: every setting this extension contributes is declared
 * `resource`- or `machine-overridable`-scoped (see package.json), so VS Code resolves it against
 * that file's own workspace folder. Omitting it silently falls back to the window-wide value,
 * which in a multi-root workspace is whichever folder happens to be first — so a fasm1 project
 * and a fasm2 project opened side by side would both get one dialect. Only pass undefined where
 * there genuinely is no file in play (e.g. a command acting on the workspace as a whole).
 */
export function fasmConfig(resource?: vscode.Uri): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration(CONFIG_SECTION, resource);
}

/** Common prefix for every user-facing notification this extension shows, so they're
 * recognizable as coming from the same source regardless of which module raised them. */
export const MESSAGE_PREFIX = 'FASM2 Studio: ';

/**
 * Where to write a setting that describes the project rather than the user — the dialect being the
 * clearest case, since one project's answer is wrong for the next one. Writing at workspace scope
 * is also what makes VS Code create `.vscode/settings.json` on its own, so the choice is recorded
 * in the project and travels with it.
 *
 * A file opened with no folder around it has no workspace scope to write to, and VS Code rejects
 * the attempt rather than ignoring it, so that case settles for the global setting.
 *
 * In a *multi-root* workspace, plain Workspace scope writes to the shared `.code-workspace` file,
 * which is exactly wrong for a per-project answer: setting one folder to fasm1 there would set it
 * for every other folder too. When the setting is being written on behalf of a known file, and
 * that file belongs to a folder in a multi-root workspace, target that folder's own settings
 * instead — the whole point of making these settings `resource`-scoped.
 */
export function projectConfigurationTarget(hasWorkspaceFolder: boolean, resource?: vscode.Uri): vscode.ConfigurationTarget {
  if (!hasWorkspaceFolder) return vscode.ConfigurationTarget.Global;
  const isMultiRoot = (vscode.workspace.workspaceFolders?.length ?? 0) > 1;
  if (isMultiRoot && resource && vscode.workspace.getWorkspaceFolder(resource)) {
    return vscode.ConfigurationTarget.WorkspaceFolder;
  }
  return vscode.ConfigurationTarget.Workspace;
}

/** Human-readable name for a ConfigurationTarget, for the "saved it — here" confirmations. */
export function configurationTargetLabel(target: vscode.ConfigurationTarget): string {
  if (target === vscode.ConfigurationTarget.WorkspaceFolder) return 'for this workspace folder';
  if (target === vscode.ConfigurationTarget.Workspace) return 'for this workspace';
  return 'globally';
}

/** Whether a folder is open, i.e. whether there is a workspace scope to write settings into. */
export function hasWorkspaceFolder(): boolean {
  return (vscode.workspace.workspaceFolders?.length ?? 0) > 0;
}
