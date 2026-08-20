// Kept separate from runCommand.ts (which imports `vscode`) so this pure logic can be unit
// tested directly without needing a real VS Code host.

/** Characters that survive an unquoted shell word unchanged on every shell this runs against.
 * Everything else is quoted rather than reasoned about — the set is deliberately conservative,
 * since the cost of quoting something that did not need it is nothing. */
const SHELL_SAFE = /^[A-Za-z0-9_@%+=:,./-]+$/;

/**
 * Quotes one word for a command line typed into the integrated terminal.
 *
 * Only quotes when needed, but "needed" covers more than whitespace: a glob (`*.txt`), a command
 * separator (`a;b`) or a redirect would otherwise be acted on by the shell instead of reaching the
 * program as the argument it was written as. This matters for `fasm2Studio.runArgs`, where the
 * values are arbitrary user text rather than the filesystem path this originally quoted — though
 * a path needs it too, since filesystems (ext4 in particular) permit every one of these characters
 * in a filename.
 *
 * The escaping inside the quotes is POSIX double-quote semantics, which is also what the two
 * Windows shells do with `"` — `$` and backtick are escaped because a POSIX shell still expands
 * them inside double quotes, and a literal backslash because it is what performs that escaping.
 */
export function quoteForShell(value: string): string {
  if (SHELL_SAFE.test(value)) return value;
  // An empty argument is not "safe" by the test above (it matches nothing), and has to survive as
  // an explicit empty word rather than disappearing from the command line entirely.
  return `"${value.replace(/([\\"$`])/g, '\\$1')}"`;
}

/**
 * Builds the fasm-level source text for an injected `-i` line that includes `filePath` — the string
 * fasmg itself will parse as `include <quoted path>`. Quoted at the *fasm* syntax level here; the
 * caller wraps the result in one more layer of quoting (`vscode.ShellQuoting.Strong`) so it survives
 * as a single shell argument.
 *
 * That outer layer is a bare wrap in whatever quote character the target shell uses for "strong"
 * quoting, with no escaping of characters already inside the value (per vscode.ShellQuoting.Strong's
 * own documentation: `"` for cmd, `'` for bash and PowerShell). Delimiting the fasm string with the
 * *same* character the outer wrap will use is what broke this on Windows: cmd's own `"..."` wrap
 * around an already-`"`-quoted fasm string just toggles quoted-state on and off without ever emitting
 * a literal `"`, so fasmg received the bare, unquoted path — `c:/Users/...` parsed as an expression
 * (division by `Users`, `by`, ...) instead of a string, hence "symbol 'c' is undefined".
 *
 * `forceCmdOuter` must reflect whichever character the caller's outer Strong-quoting will actually
 * use (see buildTask, which forces cmd.exe as the task's shell on Windows precisely so this can be
 * known for certain rather than guessed at). The delimiter chosen here is always the *other*
 * character, so the two layers can never collide. A literal occurrence of that delimiter inside
 * `filePath` is escaped by doubling it, fasmg's own convention for a quote inside a same-quoted
 * string.
 */
export function fasmIncludeDirective(filePath: string, forceCmdOuter: boolean): string {
  const quote = forceCmdOuter ? "'" : '"';
  return `include ${quote}${filePath.split(quote).join(quote + quote)}${quote}`;
}
