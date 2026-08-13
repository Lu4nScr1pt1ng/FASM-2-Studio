// The body of "FASM: Report Issue", kept free of any `vscode` import so the report's shape can be
// asserted without a running editor — issueReportCommand.ts collects the facts and shows it.
//
// This exists because of what this extension is: it ships neither an assembler nor a debugger, so
// almost every bug worth reporting depends on facts only the reporter's machine has — which of two
// byte-identical fasmg builds is on PATH, whether a preload is configured, which gdb, which
// platform. Asking for those one round-trip at a time is how a bug report takes a week.

/** A tool that was looked for, and what was found. */
export interface ToolFact {
  /** What a launch would actually spawn — a resolved path or a bare name to look up on PATH. */
  command: string;
  /** Whether that came from a setting rather than auto-detection. */
  configured?: boolean;
  /** First line of the tool's own banner/version output, or undefined if it did not run. */
  version?: string;
  /** Why there is no version, when there is none. */
  problem?: string;
}

export interface IssueReportFacts {
  extensionVersion: string;
  vscodeVersion: string;
  platform: string;
  /** Kernel/OS release string, which distinguishes a distro-packaged toolchain from a hand-built one. */
  osRelease: string;
  arch: string;
  nodeVersion: string;
  workspaceTrusted: boolean;
  /** The dialect the active file is being treated as, or undefined with no fasm file open. */
  dialect?: string;
  fasm2?: ToolFact;
  fasm1?: ToolFact;
  debugger?: ToolFact;
  /** Settings the user has actually changed, name -> value as written. Defaults are left out: a
   * report listing every setting at its default buries the two that were changed. */
  changedSettings: Record<string, string>;
  /** Standing problems the extension is already reporting in the status bar. */
  diagnosticsIssue?: string;
  indexingIssue?: string;
}

function toolLine(fact: ToolFact | undefined): string {
  if (!fact) return 'not resolved';
  const source = fact.configured ? 'from settings' : 'auto-detected';
  if (fact.version) return `\`${fact.command}\` (${source}) — ${fact.version}`;
  return `\`${fact.command}\` (${source}) — ${fact.problem ?? 'did not run'}`;
}

/**
 * The report, as Markdown, ready to paste into an issue.
 *
 * Deliberately a document the user reads before sending rather than anything submitted on their
 * behalf: it contains absolute paths from their machine, and that is their call to make.
 */
export function buildIssueReport(facts: IssueReportFacts): string {
  const lines: string[] = [
    '### Environment',
    '',
    `- **FASM2 Studio**: ${facts.extensionVersion}`,
    `- **VS Code**: ${facts.vscodeVersion}`,
    `- **OS**: ${facts.platform} ${facts.osRelease} (${facts.arch})`,
    `- **Node**: ${facts.nodeVersion}`,
    `- **Workspace trust**: ${facts.workspaceTrusted ? 'trusted' : 'restricted — building, running and live error checking are off'}`,
  ];

  if (facts.dialect) lines.push(`- **Active file dialect**: ${facts.dialect}`);

  lines.push('', '### Toolchain', '', `- **fasm2/fasmg**: ${toolLine(facts.fasm2)}`, `- **fasm1**: ${toolLine(facts.fasm1)}`, `- **Debugger**: ${toolLine(facts.debugger)}`);

  const settings = Object.entries(facts.changedSettings);
  lines.push('', '### Settings changed from their defaults', '');
  if (settings.length === 0) {
    lines.push('_None._');
  } else {
    for (const [key, value] of settings) lines.push(`- \`${key}\`: ${value}`);
  }

  if (facts.diagnosticsIssue || facts.indexingIssue) {
    lines.push('', '### Reported problems', '');
    if (facts.diagnosticsIssue) lines.push(`- Live error checking is not running: ${facts.diagnosticsIssue}`);
    if (facts.indexingIssue) lines.push(`- The workspace index did not finish: ${facts.indexingIssue}`);
  }

  lines.push(
    '',
    '### What happened',
    '',
    '<!-- What you did, what you expected, and what happened instead. A source file that',
    '     reproduces it helps more than anything else here. -->',
    '',
    '### Language server log',
    '',
    '<!-- Set "fasm2Studio.trace.server" to "verbose", reproduce the problem, then paste the',
    '     output of FASM: Show Language Server Log below. -->',
    '',
    '```',
    '```',
    '',
  );

  return lines.join('\n');
}
