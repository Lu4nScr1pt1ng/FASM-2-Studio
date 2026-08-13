// "FASM: Report Issue" — collects the machine-specific facts a useful bug report needs and opens
// them as a document to review and paste. See issueReport.ts for why this extension in particular
// needs one.

import { spawn } from 'child_process';
import * as os from 'os';
import * as vscode from 'vscode';
import packageJson from '../package.json';
import { activeFasmEditor } from './activeEditor';
import { dialectForDocument } from './buildPaths';
import { resolveCompiler } from './compilerDiscovery';
import { CONFIG_SECTION, fasmConfig, MESSAGE_PREFIX } from './config';
import { resolveDebuggerCommand } from './gdbDiscovery';
import { buildIssueReport, IssueReportFacts, ToolFact } from './issueReport';
import { activeDiagnosticsIssue, activeIndexingIssue } from './statusBar';
import { COMPILER_PATH_SETTING, Dialect } from './types';
import { isWorkspaceTrusted } from './workspaceTrust';

export const REPORT_ISSUE_COMMAND = 'fasm2Studio.reportIssue';

/** Long enough for a cold start of a tool on a slow disk, short enough that the command still feels
 * like it answers immediately. */
const VERSION_TIMEOUT_MS = 3000;
const MAX_VERSION_OUTPUT = 4096;

/** The settings worth reporting. Every one of them changes what gets spawned or how a file is
 * interpreted, which is exactly the class of fact a report cannot be reconstructed without. */
const REPORTED_SETTINGS = [
  'defaultDialect',
  COMPILER_PATH_SETTING.fasm2,
  COMPILER_PATH_SETTING.fasm1,
  'gdbPath',
  'includePath',
  'fasm2Preload',
  'buildOutputPath',
  'diagnosticsEnabled',
  'diagnosticsDebounceMs',
  'inlayHints',
  'format.mnemonicColumn',
  'format.operandColumn',
  'format.commentColumn',
] as const;

/**
 * The first meaningful line a tool prints, or undefined if it did not run.
 *
 * fasm1/fasm2 have no `--version`: run with no arguments they print their banner and a usage
 * summary, and the banner is the line that identifies the build. gdb and lldb-mi do take
 * `--version`. Either way only the first non-empty line is kept — the rest is usage text that would
 * bury the report.
 */
function probeVersion(command: string, args: string[]): Promise<{ version?: string; problem?: string }> {
  return new Promise((resolve) => {
    let settled = false;
    let output = '';

    const finish = (result: { version?: string; problem?: string }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    let child;
    try {
      // Through a shell for the same reason compilerDiscovery.ts probes that way: the official
      // Windows fasm2 distribution is a .cmd wrapper, which Node cannot exec directly.
      child = spawn(command, args, { shell: true, windowsHide: true });
    } catch (err) {
      finish({ problem: `could not be run (${(err as Error).message})` });
      return;
    }

    const timer = setTimeout(() => {
      child.kill();
      finish({ problem: 'did not respond in time' });
    }, VERSION_TIMEOUT_MS);

    const collect = (chunk: Buffer): void => {
      if (output.length < MAX_VERSION_OUTPUT) output += chunk.toString('utf8');
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    child.on('error', (err) => finish({ problem: `could not be run (${err.message})` }));
    child.on('close', () => {
      const first = output.split(/\r?\n/).find((line) => line.trim().length > 0);
      finish(first ? { version: first.trim() } : { problem: 'ran but printed nothing' });
    });
  });
}

async function compilerFact(dialect: Dialect, resource: vscode.Uri | undefined, trusted: boolean): Promise<ToolFact | undefined> {
  const resolved = await resolveCompiler(dialect, resource);
  if (!resolved) return undefined;
  const fact: ToolFact = { command: resolved.path, configured: !resolved.autoDetected };
  // Spawning a binary named by workspace settings is exactly what an untrusted workspace forbids,
  // and a report is not a good enough reason to make an exception.
  if (!trusted) return { ...fact, problem: 'not run — the workspace is not trusted' };
  return { ...fact, ...(await probeVersion(resolved.path, [])) };
}

async function debuggerFact(trusted: boolean): Promise<ToolFact> {
  const command = resolveDebuggerCommand();
  const configured = ((fasmConfig().get<string>('gdbPath') ?? '').trim().length > 0);
  const fact: ToolFact = { command, configured };
  if (!trusted) return { ...fact, problem: 'not run — the workspace is not trusted' };
  return { ...fact, ...(await probeVersion(command, ['--version'])) };
}

/** Settings the user has actually set, at any scope, with their values as written. Anything left at
 * its default is omitted — see IssueReportFacts.changedSettings. */
function changedSettings(resource: vscode.Uri | undefined): Record<string, string> {
  const config = fasmConfig(resource);
  const changed: Record<string, string> = {};
  for (const key of REPORTED_SETTINGS) {
    const inspected = config.inspect(key);
    if (!inspected) continue;
    const value =
      inspected.workspaceFolderValue ?? inspected.workspaceValue ?? inspected.globalValue ?? undefined;
    if (value === undefined) continue;
    changed[`${CONFIG_SECTION}.${key}`] = typeof value === 'string' ? (value === '' ? '""' : value) : JSON.stringify(value);
  }
  return changed;
}

async function collectFacts(): Promise<IssueReportFacts> {
  const editor = activeFasmEditor();
  const resource = editor?.document.uri;
  const trusted = isWorkspaceTrusted();

  const [fasm2, fasm1, debuggerTool] = await Promise.all([
    compilerFact('fasm2', resource, trusted),
    compilerFact('fasm1', resource, trusted),
    debuggerFact(trusted),
  ]);

  return {
    extensionVersion: packageJson.version,
    vscodeVersion: vscode.version,
    platform: process.platform,
    osRelease: os.release(),
    arch: process.arch,
    nodeVersion: process.versions.node,
    workspaceTrusted: trusted,
    dialect: editor ? dialectForDocument(editor.document) : undefined,
    fasm2,
    fasm1,
    debugger: debuggerTool,
    changedSettings: changedSettings(resource),
    diagnosticsIssue: activeDiagnosticsIssue(),
    indexingIssue: activeIndexingIssue(),
  };
}

const NEW_ISSUE_URL = `${packageJson.bugs.url}/new`;

export function registerReportIssue(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(REPORT_ISSUE_COMMAND, async () => {
      const report = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: `${MESSAGE_PREFIX}collecting environment details…` },
        async () => buildIssueReport(await collectFacts()),
      );

      // Opened as a document first, and never sent anywhere on its own: it carries absolute paths
      // from the user's machine, so what leaves the machine is their decision, made while looking
      // at what they would be sending.
      const document = await vscode.workspace.openTextDocument({ content: report, language: 'markdown' });
      await vscode.window.showTextDocument(document, { preview: false });

      const copy = 'Copy and open GitHub';
      const choice = await vscode.window.showInformationMessage(
        `${MESSAGE_PREFIX}here is what your setup looks like. Fill in what happened, then attach it to an issue.`,
        copy,
      );
      if (choice === copy) {
        await vscode.env.clipboard.writeText(report);
        await vscode.env.openExternal(vscode.Uri.parse(NEW_ISSUE_URL));
      }
    }),
  );
}
