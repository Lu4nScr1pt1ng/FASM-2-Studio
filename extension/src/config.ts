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
