// What an "attach" session is attaching *to*, and the two things gdb tells us about it in prose
// rather than in a machine-readable MI field.
//
// Attach covers two cases that look identical from the editor's side — you did not start this
// program from here — but are nothing alike underneath:
//
//   - A live process. gdb stops it, and everything the launch path can do (breakpoints, stepping,
//     writing memory) works from there. Detaching leaves it running.
//   - A core dump. There is no process at all: registers and memory are a frozen snapshot, so it
//     can be read but never resumed, and the interesting question is which signal killed it.
//
// Both are worth having for assembly specifically. A fault is the normal way an assembly program
// ends, and a core dump is frequently the only artifact of one — a debugger that can only run a
// program forwards from its entry point has nothing to say about a crash that already happened.

export type AttachTarget =
  /** A live process, stopped by gdb on attach and left running on detach. */
  | { kind: 'process'; processId: number }
  /** A post-mortem snapshot: readable, never resumable. */
  | { kind: 'core'; coreFile: string };

export type AttachTargetResult = { target: AttachTarget } | { error: string };

/**
 * Reads the target out of an attach configuration, rejecting the shapes that cannot mean anything.
 *
 * Both fields set is a genuine ambiguity rather than something to silently prefer one side of: a
 * config naming a pid *and* a core file describes two different debugging sessions, and picking
 * one would answer a question about the wrong one.
 */
export function resolveAttachTarget(args: { processId?: number | string; coreFile?: string }): AttachTargetResult {
  const hasProcess = args.processId !== undefined && args.processId !== '';
  const hasCore = typeof args.coreFile === 'string' && args.coreFile.length > 0;

  if (hasProcess && hasCore) {
    return { error: 'Set either "processId" or "coreFile" in the attach configuration, not both — they describe different sessions.' };
  }
  if (hasCore) return { target: { kind: 'core', coreFile: args.coreFile! } };
  if (!hasProcess) {
    return { error: 'An attach configuration needs "processId" (a running process) or "coreFile" (a core dump).' };
  }

  // launch.json values arrive typed `any`, and the process picker hands back a string — so a pid
  // that isn't a pid has to be caught here rather than reaching gdb as "-target-attach undefined".
  const processId = typeof args.processId === 'number' ? args.processId : Number(String(args.processId).trim());
  if (!Number.isInteger(processId) || processId <= 0) {
    return { error: `"processId" must be a positive integer, not ${JSON.stringify(args.processId)}.` };
  }
  return { target: { kind: 'process', processId } };
}

/**
 * The signal a core dump records, which gdb reports only as a console line ("Program terminated
 * with signal SIGSEGV, Segmentation fault.") — there is no *stopped record for a core load at all,
 * and so no signal-name/signal-meaning fields of the kind a live stop carries.
 *
 * Worth digging out of prose because it is the first thing anyone opening a core wants to know,
 * and because it feeds the same exceptionInfo path that makes a live fault read as
 * "SIGSEGV (Segmentation fault)" rather than the word "exception".
 */
export function parseTerminationSignal(consoleText: string): { name: string; meaning: string } | undefined {
  const match = /Program terminated with signal ([A-Z0-9]+), ([^.\n]+)\./.exec(consoleText);
  if (!match) return undefined;
  return { name: match[1], meaning: match[2].trim() };
}
