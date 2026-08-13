// Temporary directories for tests, and the one careful thing about removing them again.
//
// On Windows a file cannot be deleted while any handle to it is still open, and these tests hand
// their directories to programs that hold handles of their own — a real assembler writing an
// output file, gdb reading a binary it has loaded. A process that has exited still leaves a brief
// window where its handles are not yet reaped, so removing the directory in the very next
// statement fails with EPERM (the file) or EBUSY (the directory) often enough to fail a run that
// proved everything it set out to prove. POSIX unlinks a file that is still open without
// complaint, which is why this only shows up on Windows.
//
// `fs.promises.rm`'s own maxRetries/retryDelay is exactly the remedy, and deliberately the async
// form: the synchronous one blocks the thread it is retrying on, so nothing that has to run on
// this event loop to release a handle can make progress between attempts.

import * as fs from 'fs/promises';
import { mkdtempSync } from 'fs';
import * as os from 'os';
import * as path from 'path';

/** Retries cover 100+200+…+1000 ms of backoff. */
const MAX_RETRIES = 10;
const RETRY_DELAY_MS = 100;

/** A fresh temp directory named after the test using it, so a leaked one names its own culprit. */
export function makeTempDir(prefix: string): string {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * Removes a temp directory, waiting out handles that have not been released yet.
 *
 * Never throws: a directory that survives all the retries is left to the operating system's own
 * temp cleanup, with a warning naming it. Teardown failing the test it just finished reports a
 * passing feature as broken, over a few kilobytes the OS already knows how to reclaim.
 */
export async function removeTempDir(dir: string | undefined): Promise<void> {
  if (!dir) return;
  try {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: MAX_RETRIES, retryDelay: RETRY_DELAY_MS });
  } catch (err) {
    console.warn(`[test] could not remove temp directory ${dir}: ${(err as Error).message}`);
  }
}
