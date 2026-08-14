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

/** True once the workspace holds at least one buildable program. Decides whether the view has rows;
 * no longer the only thing deciding whether the view exists (see HAS_SOURCES_CONTEXT). */
const HAS_ENTRY_POINTS_CONTEXT = 'fasm2Studio.hasEntryPoints';

/**
 * True when the workspace holds fasm sources but none of them is a program — the state the welcome
 * view explains.
 *
 * Gating the view on entry points alone made its most confusing case invisible: a project of
 * `.inc` fragments, or one whose `format` directive is missing or misspelled, produced no view at
 * all and therefore no hint that this extension had looked and found nothing. An absent section
 * reads as "this extension has nothing to say here", which is indistinguishable from it being
 * broken. A workspace with no fasm files in it at all still gets nothing, which is the case the
 * original gate existed for.
 */
const HAS_SOURCES_CONTEXT = 'fasm2Studio.hasFasmSources';

/** Any file this extension would treat as fasm source. Includes `.inc`, unlike the manifest's
 * activation globs: a workspace made only of fragments is precisely the one that needs explaining,
 * and by the time this runs the extension is already active, so there is no unrelated project to
 * avoid waking up. */
const FASM_SOURCE_GLOB = '**/*.{asm,fasm,fas,alm,inc}';

class EntryPointsProvider implements vscode.TreeDataProvider<EntryPoint> {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;

  /** The list `refresh` last fetched, which is what `getChildren` renders. Held rather than fetched
   * per render because refresh has to ask the server anyway (see below), and a second round-trip
   * on the way to drawing the same list would only ever return the same answer. */
  private entryPoints: EntryPoint[] = [];

  constructor(private readonly getClient: () => LanguageClient | undefined) {}

  /**
   * Re-reads the entry-point list and publishes both things that depend on it: the context key
   * deciding whether the view exists at all, and the rows inside it.
   *
   * The context key cannot be written from `getChildren`, which is where it used to live. The
   * view's `when` clause is what gates it, and a view gated off is never rendered, so its children
   * are never requested — leaving the one call that would turn the key on reachable only once the
   * key was already on. A workspace whose entry points were all found by the initial scan (that
   * is: every workspace, since that scan is what finds them) therefore had nothing to switch it,
   * and the section never appeared.
   */
  async refresh(): Promise<void> {
    this.entryPoints = await listEntryPoints(this.getClient());
    const hasEntryPoints = this.entryPoints.length > 0;
    await vscode.commands.executeCommand('setContext', HAS_ENTRY_POINTS_CONTEXT, hasEntryPoints);
    // Only asked when there are no entry points: with rows to show the view is already visible, and
    // a workspace-wide file search on every refresh — which runs on every save of a fasm file —
    // would be paid for an answer nothing reads. `maxResults: 1` makes it a search for existence
    // rather than a listing; the default excludes (files.exclude/search.exclude) keep it out of
    // node_modules and friends.
    const hasSources =
      hasEntryPoints || (await vscode.workspace.findFiles(FASM_SOURCE_GLOB, undefined, 1)).length > 0;
    await vscode.commands.executeCommand('setContext', HAS_SOURCES_CONTEXT, hasSources);
    this.changed.fire();
  }

  dispose(): void {
    this.changed.dispose();
  }

  getChildren(element?: EntryPoint): EntryPoint[] {
    return element ? [] : this.entryPoints; // flat list — an entry point has no children
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
): { refresh: () => Promise<void> } {
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
    delegate('fasm2Studio.entryPoints.showListing', 'fasm2Studio.showListing'),
    vscode.commands.registerCommand('fasm2Studio.entryPoints.refresh', () => provider.refresh()),
    // Leaves no stale key behind for the next extension to be gated by one of the same name, and
    // — more to the point — stops a deactivated extension from advertising a view it no longer
    // backs with a provider.
    {
      dispose: () => {
        void vscode.commands.executeCommand('setContext', HAS_ENTRY_POINTS_CONTEXT, false);
        void vscode.commands.executeCommand('setContext', HAS_SOURCES_CONTEXT, false);
      },
    },
    provider,
  );

  return { refresh: () => provider.refresh() };
}
