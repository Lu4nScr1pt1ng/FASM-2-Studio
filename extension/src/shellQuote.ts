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
