// Temporary directories for tests, and the one careful thing about removing them again.
//
// On Windows a file cannot be deleted while any handle to it is still open, and the handles here
// belong to the editor rather than to the test: a document that was opened stays loaded for a
// moment after `workbench.action.closeAllEditors` resolves, and VS Code's own file watcher holds
// the directory it was told to watch. Removing the directory in the very next statement therefore
// fails with EPERM (the file) or EBUSY (the directory) often enough to fail a run that proved
// everything it set out to prove. POSIX unlinks a file that is still open without complaint, which
// is why this only ever shows up on the Windows leg of the matrix.
//
// `fs.promises.rm`'s own maxRetries/retryDelay is exactly the remedy — but only in the async form.
// The synchronous one blocks the thread it is retrying on, and the handles being waited for are
// released by that same event loop, so a synchronous retry loop guarantees all of its attempts see
// the identical locked state. This one yields between attempts, which is what lets the editor
// actually let go.

import * as fs from 'fs/promises';
import { mkdtempSync } from 'fs';
import * as os from 'os';
import * as path from 'path';

/** Retries cover 100+200+…+1000 ms of backoff. Sized against what it is waiting for — the editor
 * closing documents and dropping watchers — not against arbitrary slowness. */
const MAX_RETRIES = 10;
const RETRY_DELAY_MS = 100;

/** A fresh temp directory named after the test using it, so a leaked one names its own culprit. */
export function makeTempDir(prefix: string): string {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * Removes a temp directory, waiting out the handles the editor has not dropped yet.
 *
 * Never throws: a directory that survives all the retries is left to the operating system's own
 * temp cleanup, with a warning naming it. Teardown failing the test it just finished is the worst
 * of both outcomes — it reports a passing feature as broken, and the thing it is complaining about
 * is a few kilobytes in a directory the OS already knows how to reclaim.
 */
export async function removeTempDir(dir: string | undefined): Promise<void> {
  if (!dir) return;
  try {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: MAX_RETRIES, retryDelay: RETRY_DELAY_MS });
  } catch (err) {
    console.warn(`[test] could not remove temp directory ${dir}: ${(err as Error).message}`);
  }
}
