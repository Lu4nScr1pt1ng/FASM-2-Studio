// The "FASM Entry Points" view — the workspace's buildable programs, as a list.
//
// Everything else in this extension is addressed at whatever file is currently focused, which is
// the right default for editing but leaves a project's actual shape invisible: which of forty
// .asm/.inc files are programs and which are fragments is knowledge the server already has (a
// top-level `format` directive is what distinguishes them) and the user previously had to
// reconstruct by opening files and looking for a code lens.
//
// Contributed into the Explorer rather than an activity-bar container of its own: these are build
// targets, they belong next to the files, and a whole activity bar icon is more presence than a
// list of usually two or three items has earned.

import * as path from 'path';
import * as vscode from 'vscode';
import { LanguageClient } from 'vscode-languageclient/node';
import { EntryPoint, listEntryPoints } from './entryPoints';

export const ENTRY_POINTS_VIEW_ID = 'fasm2Studio.entryPoints';

/** Gates the view's `when` clause, so a workspace with no fasm programs in it doesn't grow an
 * empty section in its Explorer. */
const HAS_ENTRY_POINTS_CONTEXT = 'fasm2Studio.hasEntryPoints';

class EntryPointsProvider implements vscode.TreeDataProvider<EntryPoint> {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(private readonly getClient: () => LanguageClient | undefined) {}

  refresh(): void {
    this.changed.fire();
  }

  dispose(): void {
    this.changed.dispose();
  }

  async getChildren(element?: EntryPoint): Promise<EntryPoint[]> {
    if (element) return []; // flat list — an entry point has no children
    const entryPoints = await listEntryPoints(this.getClient());
    void vscode.commands.executeCommand('setContext', HAS_ENTRY_POINTS_CONTEXT, entryPoints.length > 0);
    return entryPoints;
  }

  getTreeItem(entry: EntryPoint): vscode.TreeItem {
    const item = new vscode.TreeItem(entry.name, vscode.TreeItemCollapsibleState.None);
    // Gives the item whatever icon the user's file icon theme already uses for this file, and the
    // same hover/drag behaviour as the Explorer's own entries.
    item.resourceUri = vscode.Uri.file(entry.fsPath);
    // Only the directory: the file name is already the label, and repeating it in the description
    // is the noise that makes a two-column tree unreadable.
    const dir = path.dirname(entry.relativePath);
    item.description = dir === '.' ? undefined : dir;
    item.tooltip = entry.fsPath;
    item.contextValue = 'fasmEntryPoint';
    item.command = { command: 'vscode.open', title: 'Open', arguments: [item.resourceUri] };
    return item;
  }
}

/**
 * Registers the view and the commands its buttons invoke.
 *
 * The buttons cannot bind to `fasm2Studio.build` and friends directly: a tree item's menu command
 * is handed the tree *element*, not a Uri, and those commands read a Uri (and, since the explorer
 * multi-select work, a Uri list). These thin wrappers convert the one into the other and delegate,
 * so the view can never drift from what the palette does.
 */
export function registerEntryPointsView(
  context: vscode.ExtensionContext,
  getClient: () => LanguageClient | undefined,
): { refresh: () => void } {
  const provider = new EntryPointsProvider(getClient);

  const delegate = (viewCommand: string, target: string): vscode.Disposable =>
    vscode.commands.registerCommand(viewCommand, (entry?: EntryPoint) => {
      if (!entry) return undefined;
      return vscode.commands.executeCommand(target, vscode.Uri.file(entry.fsPath));
    });

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider(ENTRY_POINTS_VIEW_ID, provider),
    delegate('fasm2Studio.entryPoints.build', 'fasm2Studio.build'),
    delegate('fasm2Studio.entryPoints.buildAndRun', 'fasm2Studio.buildAndRun'),
    delegate('fasm2Studio.entryPoints.debug', 'fasm2Studio.debug'),
    delegate('fasm2Studio.entryPoints.clean', 'fasm2Studio.clean'),
    delegate('fasm2Studio.entryPoints.openBuildOutput', 'fasm2Studio.openBuildOutput'),
    vscode.commands.registerCommand('fasm2Studio.entryPoints.refresh', () => provider.refresh()),
    provider,
  );

  return { refresh: () => provider.refresh() };
}
