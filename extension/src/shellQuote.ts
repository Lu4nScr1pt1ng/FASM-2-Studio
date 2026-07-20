// Kept separate from runCommand.ts (which imports `vscode`) so this pure logic can be unit
// tested directly without needing a real VS Code host.

/** Quotes a path for use in a shell command line typed into the integrated terminal. Only quotes
 * when actually needed (spaces or embedded quotes), escaping any embedded double quote so the
 * quoting itself can't be broken out of — matters more than it might seem since filesystems (ext4
 * in particular) permit a literal `"` in a filename. */
export function quoteForShell(value: string): string {
  if (!/[\s"]/.test(value)) return value;
  return `"${value.replace(/"/g, '\\"')}"`;
}
