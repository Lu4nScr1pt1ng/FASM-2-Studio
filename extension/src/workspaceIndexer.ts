// Drives the server's workspace-wide index (see server/src/workspace.ts) so find-references,
// rename and workspace-symbol-search cover the whole project, not just open editors. File
// discovery is delegated to vscode.workspace.findFiles rather than re-implemented here: it's
// VS Code's own optimized, excludes-aware search (honors files.exclude/search.exclude), so
// reusing it avoids duplicating that traversal — and worse, duplicating it *badly*.
import * as vscode from 'vscode';
import { LanguageClient } from 'vscode-languageclient/node';
import packageJson from '../package.json';
import { MESSAGE_PREFIX } from './config';

// Built from package.json's own "fasm" language contribution rather than a second hardcoded
// list, so the two can't silently drift apart when a file extension is added/removed there.
const FASM_EXTENSIONS = packageJson.contributes.languages[0].extensions.map((ext) => ext.replace(/^\./, ''));
export const FASM_FILE_GLOB = `**/*.{${FASM_EXTENSIONS.join(',')}}`;

/**
 * How long to keep waiting for the server's completion notification before giving up on it.
 *
 * Only ever reached if the server died mid-scan or is an older build that does not send one —
 * indexing itself yields between batches and is bounded at 20k files. Generous enough that a very
 * large project is never cut short, finite so the progress indicator cannot become permanent.
 */
const COMPLETION_TIMEOUT_MS = 5 * 60_000;

export function createFasmFileWatcher(): vscode.FileSystemWatcher {
  return vscode.workspace.createFileSystemWatcher(FASM_FILE_GLOB);
}

/** What the server reports once the scan it was asked for has finished. */
interface IndexedNotification {
  indexed: number;
  skipped: number;
  /** Set when the scan threw; the index is then partial or empty. */
  error?: string;
}

export interface IndexResult {
  indexed: number;
  skipped: number;
  /** Why the index is not complete, or undefined when it is. Worth showing: every cross-file
   * feature answers from this index, and a partial one is indistinguishable from a wrong one. */
  issue?: string;
}

/**
 * Scans the workspace and waits for the server to finish indexing it, showing progress meanwhile.
 *
 * The wait is what makes the progress indicator mean anything: sending the notification returns
 * immediately, so without it the indicator would appear and vanish while the scan it describes had
 * barely started, and a failure would land in a console nobody opens.
 */
export async function indexWorkspace(client: LanguageClient): Promise<IndexResult> {
  const files = await vscode.workspace.findFiles(FASM_FILE_GLOB);
  if (files.length === 0) return { indexed: 0, skipped: 0 };

  return vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Window,
      title: `${MESSAGE_PREFIX}indexing ${files.length} file${files.length === 1 ? '' : 's'} for cross-file navigation…`,
    },
    async () => {
      const done = waitForCompletion(client);
      try {
        await client.sendNotification('fasm2Studio/indexWorkspaceFiles', { uris: files.map((f) => f.toString()) });
      } catch (err) {
        done.cancel();
        return { indexed: 0, skipped: 0, issue: err instanceof Error ? err.message : String(err) };
      }
      const result = await done.promise;
      return { indexed: result.indexed, skipped: result.skipped, issue: result.error };
    },
  );
}

/** Listens for the one completion notification this scan will produce, and gives up after
 * COMPLETION_TIMEOUT_MS. The listener is always disposed, on every path out. */
function waitForCompletion(client: LanguageClient): { promise: Promise<IndexedNotification>; cancel: () => void } {
  let settle: ((result: IndexedNotification) => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const listener = client.onNotification('fasm2Studio/workspaceIndexed', (params: IndexedNotification) => {
    settle?.({ indexed: params?.indexed ?? 0, skipped: params?.skipped ?? 0, error: params?.error });
  });

  const promise = new Promise<IndexedNotification>((resolve) => {
    settle = (result) => {
      if (timer) clearTimeout(timer);
      listener.dispose();
      resolve(result);
    };
    timer = setTimeout(
      () => settle?.({ indexed: 0, skipped: 0, error: 'the language server did not report the scan as finished' }),
      COMPLETION_TIMEOUT_MS,
    );
  });

  return { promise, cancel: () => settle?.({ indexed: 0, skipped: 0 }) };
}
