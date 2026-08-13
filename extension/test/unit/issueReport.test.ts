// The report is the whole point of the command, so what it does and does not contain is worth
// pinning down: a missing toolchain line makes the report useless, and a setting listed at its
// default buries the two that were changed.
import * as assert from 'assert';
import { buildIssueReport, IssueReportFacts } from '../../src/issueReport';

const FACTS: IssueReportFacts = {
  extensionVersion: '1.12.0',
  vscodeVersion: '1.94.2',
  platform: 'linux',
  osRelease: '6.11.0',
  arch: 'x64',
  nodeVersion: '20.18.0',
  workspaceTrusted: true,
  dialect: 'fasm2',
  fasm2: { command: '/usr/local/bin/fasm2', configured: true, version: 'flat assembler  version g.rc55' },
  fasm1: { command: 'fasm1', version: 'flat assembler  version 1.73.32' },
  debugger: { command: 'gdb', version: 'GNU gdb (GDB) 15.2' },
  changedSettings: { 'fasm2Studio.includePath': '/opt/fasm2/include' },
};

describe('issue report', () => {
  it('names the extension, editor and platform, which decide what half of the code even runs', () => {
    const report = buildIssueReport(FACTS);
    assert.match(report, /\*\*FASM2 Studio\*\*: 1\.12\.0/);
    assert.match(report, /\*\*VS Code\*\*: 1\.94\.2/);
    assert.match(report, /\*\*OS\*\*: linux 6\.11\.0 \(x64\)/);
  });

  it('reports each tool with its version and where the path came from', () => {
    const report = buildIssueReport(FACTS);
    assert.match(report, /\*\*fasm2\/fasmg\*\*: `\/usr\/local\/bin\/fasm2` \(from settings\) — flat assembler {2}version g\.rc55/);
    assert.match(report, /\*\*fasm1\*\*: `fasm1` \(auto-detected\) — flat assembler {2}version 1\.73\.32/);
    assert.match(report, /\*\*Debugger\*\*: `gdb` \(auto-detected\) — GNU gdb \(GDB\) 15\.2/);
  });

  it('says a tool was not resolved rather than leaving the line blank', () => {
    const report = buildIssueReport({ ...FACTS, fasm1: undefined });
    assert.match(report, /\*\*fasm1\*\*: not resolved/);
  });

  it('says why a resolved tool produced no version', () => {
    const report = buildIssueReport({ ...FACTS, debugger: { command: 'gdb', problem: 'did not respond in time' } });
    assert.match(report, /\*\*Debugger\*\*: `gdb` \(auto-detected\) — did not respond in time/);
  });

  it('lists the settings that were changed', () => {
    assert.match(buildIssueReport(FACTS), /- `fasm2Studio\.includePath`: \/opt\/fasm2\/include/);
  });

  it('says so explicitly when nothing was changed, rather than showing an empty section', () => {
    assert.match(buildIssueReport({ ...FACTS, changedSettings: {} }), /_None\._/);
  });

  it('records restricted trust, which turns off building, running and error checking', () => {
    const report = buildIssueReport({ ...FACTS, workspaceTrusted: false });
    assert.match(report, /restricted/);
  });

  it('carries the standing problems the status bar is already showing', () => {
    const report = buildIssueReport({ ...FACTS, diagnosticsIssue: 'compile timed out', indexingIssue: 'scan interrupted' });
    assert.match(report, /Live error checking is not running: compile timed out/);
    assert.match(report, /The workspace index did not finish: scan interrupted/);
  });

  it('leaves out the problems section when there are none', () => {
    assert.ok(!buildIssueReport(FACTS).includes('### Reported problems'));
  });

  it('leaves room for the two things only the reporter can supply', () => {
    const report = buildIssueReport(FACTS);
    assert.match(report, /### What happened/);
    assert.match(report, /### Language server log/);
    assert.match(report, /fasm2Studio\.trace\.server/);
  });
});
