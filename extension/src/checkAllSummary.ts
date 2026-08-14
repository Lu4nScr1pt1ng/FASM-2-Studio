// How a whole-project check reports what it found (see checkAll.ts for the command itself).
//
// Split out with no `vscode` import so the wording can be pinned down by unit tests: this sentence
// is the entire visible result of the command, and every one of its parts is a distinction that
// matters — "no errors" and "stopped early" are very different answers, and a run that could not
// assemble anything at all must not be able to report either.

/** What the server reports about one whole-project check. Mirrors CheckAllSummary in server.ts. */
export interface CheckAllSummary {
  /** Entry points actually assembled. */
  checked: number;
  /** Entry points passed over — already covered by an open document's live compile, or unreadable. */
  skipped: number;
  filesWithErrors: number;
  errors: number;
  /** Entry points that could not be assembled at all, as "name: why". */
  failures: string[];
  cancelled: boolean;
  /** Why nothing could run (no compiler, untrusted workspace). */
  unavailable?: string;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/**
 * The sentence shown when the run finishes.
 *
 * A check that found nothing has to say so out loud. Silence is what the Problems panel already
 * looked like before the command ran, so a quiet success is indistinguishable from the command
 * having done nothing at all — which, for a command whose whole purpose is to tell you about files
 * you are not looking at, is the one outcome most worth being explicit about.
 */
export function summaryMessage(summary: CheckAllSummary): string {
  // "0 errors" would be a claim about programs that were never assembled. A standing condition —
  // no compiler installed, an untrusted workspace — is the reason there is no result at all, and
  // is reported instead of one.
  if (summary.unavailable && summary.checked === 0) return `nothing could be checked: ${summary.unavailable}`;

  const parts = [`${summary.cancelled ? 'stopped after' : 'checked'} ${plural(summary.checked, 'entry point')}`];
  if (summary.errors > 0) parts.push(`${plural(summary.errors, 'error')} in ${plural(summary.filesWithErrors, 'file')}`);
  // A cancelled run has no verdict to give: the programs it never reached are not programs it
  // found clean.
  else if (!summary.cancelled) parts.push('no errors');
  // Skipped entry points are mostly ones an open editor is already checking live, so they are not
  // a hole in the result — but they do explain a count lower than the entry-points view shows.
  if (summary.skipped > 0) parts.push(`${summary.skipped} already open or unreadable`);
  return parts.join(' — ');
}
