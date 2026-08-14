// The workspace's entry points — the files with a top-level `format` directive, i.e. the ones that
// are a program in their own right rather than a fragment some other file includes.
//
// The server already computes this set (it is the same include-graph walk behind go-to-definition
// and the Run/Debug code lenses), and entryPointResolver.ts has always asked for it as a fallback.
// It is pulled out here because two other things need the same list: the task provider, so
// Ctrl+Shift+B has something to offer when no fasm file happens to be focused, and the entry-points
// view.

import * as path from 'path';
import * as vscode from 'vscode';
import { LanguageClient } from 'vscode-languageclient/node';

export interface EntryPoint {
  fsPath: string;
  /** File name alone — what to call this program in a task name or a tree label. */
  name: string;
  /** Path relative to its workspace folder, for telling two same-named entry points apart. */
  relativePath: string;
}

function toEntryPoint(entryUri: string): EntryPoint {
  const fsPath = vscode.Uri.parse(entryUri).fsPath;
  return { fsPath, name: path.basename(fsPath), relativePath: vscode.workspace.asRelativePath(fsPath, false) };
}

/**
 * Every entry point the server currently knows about, sorted by path so the order is stable
 * between calls — a task list or a tree that reshuffles itself on refresh is worse than one that
 * is occasionally out of date.
 *
 * Returns an empty list rather than throwing: every caller is building an optional affordance, and
 * a server that cannot answer should cost them nothing more than that affordance being absent.
 */
export async function listEntryPoints(client: LanguageClient | undefined): Promise<EntryPoint[]> {
  if (!client) return [];
  try {
    const { entryUris } = await client.sendRequest<{ entryUris: string[] }>('fasm2Studio/listEntryPoints', {});
    return entryUris.map(toEntryPoint).sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  } catch {
    return [];
  }
}
