// Turning a platform's process-listing command into something a picker can show, and deciding what
// order to show it in. Kept free of any `vscode` import — same reason as statusBarMenuItems.ts — so
// the parsing can be asserted against real `ps`/`tasklist` output without a running editor.
//
// Both of these fail quietly when they are wrong: a bad pattern drops rows rather than throwing,
// and a bad ordering just buries the entry the user actually wanted. Neither is visible from a
// glance at a running picker, which is why they live here rather than inline in the command.

export interface ProcessEntry {
  pid: number;
  /** The executable's own name, without a path. */
  name: string;
  /** The full command line, when the platform gives one. */
  commandLine: string;
}

/**
 * Parses `ps -axo pid=,comm=,args=` output.
 *
 * The command line is deliberately taken as "everything after the pid and comm columns" rather than
 * by splitting on whitespace: arguments contain spaces, and a path with a space in it is exactly
 * the case a naive split turns into a truncated, wrong-looking entry.
 */
export function parsePosixProcessList(stdout: string): ProcessEntry[] {
  const entries: ProcessEntry[] = [];
  for (const line of stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!match) continue;
    entries.push({ pid: Number(match[1]), name: match[2], commandLine: match[3].trim() });
  }
  return entries;
}

/** Parses `tasklist /nh /fo csv` output ("name","pid","session","#","mem"). */
export function parseWindowsProcessList(stdout: string): ProcessEntry[] {
  const entries: ProcessEntry[] = [];
  for (const line of stdout.split('\n')) {
    const fields = line.match(/"([^"]*)"/g);
    if (!fields || fields.length < 2) continue;
    const name = fields[0].slice(1, -1);
    const pid = Number(fields[1].slice(1, -1));
    // Drops "System Idle Process" (pid 0) along with any malformed row: there is nothing there to
    // attach to, and it would otherwise sit in the list looking like a real choice.
    if (!Number.isInteger(pid) || pid <= 0) continue;
    entries.push({ pid, name, commandLine: name });
  }
  return entries;
}

/**
 * The order the list is offered in: most recently started first.
 *
 * pids ascend as processes are created, so the highest is very nearly always the one just started —
 * which is what someone attaching to their own program is looking for, and what they would
 * otherwise scroll a few hundred system processes to find.
 */
export function orderForPicker(entries: ProcessEntry[], ownPid: number): ProcessEntry[] {
  return entries.filter((e) => e.pid !== ownPid).sort((a, b) => b.pid - a.pid);
}
