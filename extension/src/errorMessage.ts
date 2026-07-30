// Kept separate (like shellQuote.ts) so this pure logic can be unit tested directly without a
// real VS Code host.

/** Human-readable message for a caught value of unknown shape. A bare `(err as Error).message`
 * assumes every catch actually receives an Error instance — not guaranteed by VS Code's own APIs
 * or Node's child_process layer — and silently reads as "undefined" when it doesn't. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
