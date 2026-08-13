// The process picker behind "${command:fasm2Studio.pickProcess}" in an attach configuration.
//
// A pid is the one launch.json field that is different every single time, so a config that hardcodes
// one is stale before it is saved. Everything else about attaching can be written down once; this
// has to be asked each run, which is why the generated attach snippet substitutes this command
// rather than leaving a number for the user to go and look up.
//
// The parsing and ordering live in processList.ts, which imports nothing from vscode so it can be
// tested against real `ps`/`tasklist` output directly.

import { execFile } from 'child_process';
import { promisify } from 'util';
import * as vscode from 'vscode';
import { MESSAGE_PREFIX } from './config';
import { orderForPicker, parsePosixProcessList, parseWindowsProcessList, ProcessEntry } from './processList';

const execFileAsync = promisify(execFile);

export const PICK_PROCESS_COMMAND = 'fasm2Studio.pickProcess';

/** Generous, because a busy machine's full process table is genuinely large — and truncating it
 * would silently hide exactly the entry someone is looking for. */
const LIST_BUFFER_BYTES = 8 * 1024 * 1024;

async function listProcesses(): Promise<ProcessEntry[]> {
  if (process.platform === 'win32') {
    const { stdout } = await execFileAsync('tasklist', ['/nh', '/fo', 'csv'], { maxBuffer: LIST_BUFFER_BYTES });
    return parseWindowsProcessList(stdout);
  }
  const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,comm=,args='], { maxBuffer: LIST_BUFFER_BYTES });
  return parsePosixProcessList(stdout);
}

export function registerPickProcess(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    // Returns the pid as a string: a "${command:...}" substitution in launch.json is a string
    // substitution, and the debug adapter accepts either (see resolveAttachTarget).
    vscode.commands.registerCommand(PICK_PROCESS_COMMAND, async (): Promise<string | undefined> => {
      let processes: ProcessEntry[];
      try {
        processes = orderForPicker(await listProcesses(), process.pid);
      } catch (err) {
        void vscode.window.showErrorMessage(`${MESSAGE_PREFIX}could not list running processes: ${(err as Error).message}`);
        return undefined;
      }

      const picked = await vscode.window.showQuickPick(
        processes.map((p) => ({ label: p.name, description: String(p.pid), detail: p.commandLine, pid: p.pid })),
        { placeHolder: 'Which process do you want to attach to?', matchOnDescription: true, matchOnDetail: true },
      );
      return picked ? String(picked.pid) : undefined;
    }),
  );
}
