import * as vscode from 'vscode';

export const CONFIG_SECTION = 'fasm2Studio';

/** Shorthand for `vscode.workspace.getConfiguration(CONFIG_SECTION)`, kept in one place so the
 * section name is never duplicated as a bare string across call sites. */
export function fasmConfig(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration(CONFIG_SECTION);
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
 */
export function projectConfigurationTarget(hasWorkspaceFolder: boolean): vscode.ConfigurationTarget {
  return hasWorkspaceFolder ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
}

/** Whether a folder is open, i.e. whether there is a workspace scope to write settings into. */
export function hasWorkspaceFolder(): boolean {
  return (vscode.workspace.workspaceFolders?.length ?? 0) > 0;
}
