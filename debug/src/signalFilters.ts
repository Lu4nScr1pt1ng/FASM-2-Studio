// The signals the Breakpoints panel can be told to stop on, and the gdb commands that put that
// choice into effect.
//
// Pure metadata and string building, kept out of session.ts so the mapping can be checked without
// a gdb behind it — the failure mode being guarded against is a command that reads correctly and
// means the opposite ("nostop" where "stop" belongs), which no amount of running the debugger makes
// obvious.
//
// Why this is worth having at all: gdb stops on every one of these by default, so an assembly
// program that installs its own SIGSEGV handler — a real technique, not a curiosity — cannot be run
// under this debugger without gdb interrupting every fault the program was written to handle
// itself. Before this, the Breakpoints panel showed no toggles for a FASM session and the only way
// to change it was to know the `handle` command and type it into the Debug Console.

export interface SignalFilter {
  /** DAP filter id. The signal name itself, which is also the token gdb's `handle` takes. */
  filter: string;
  /** Rendered as the checkbox label in the Breakpoints panel. */
  label: string;
  /** Shown as its tooltip. */
  description: string;
  /**
   * Whether the box starts checked.
   *
   * True for all of these, because that is what gdb already does (`info handle` reports Stop=Yes,
   * Print=Yes, Pass=Yes for every signal below). A default that disagreed with the debugger would
   * make the panel describe a session other than the one running until the user touched it.
   */
  default: boolean;
}

export const SIGNAL_FILTERS: readonly SignalFilter[] = [
  {
    filter: 'SIGSEGV',
    label: 'Segmentation fault (SIGSEGV)',
    description:
      'Stop when the program touches memory it does not own — a bad pointer, a stack that has run away, or a jump into unmapped memory. Uncheck to let a program that installs its own handler deal with it.',
    default: true,
  },
  {
    filter: 'SIGILL',
    label: 'Illegal instruction (SIGILL)',
    description:
      'Stop when the CPU is handed something it cannot execute — commonly a jump into data, or an instruction the target machine does not have.',
    default: true,
  },
  {
    filter: 'SIGFPE',
    label: 'Arithmetic exception (SIGFPE)',
    description:
      'Stop on a faulting arithmetic instruction. On x86 this is raised by div/idiv on a zero divisor, and also on a quotient too large for the destination register — which is the same signal for a different reason.',
    default: true,
  },
  {
    filter: 'SIGBUS',
    label: 'Bus error (SIGBUS)',
    description:
      'Stop on an access the address is valid for but the hardware refuses — a misaligned operand where alignment is enforced, or a mapped file read past its end.',
    default: true,
  },
  {
    filter: 'SIGABRT',
    label: 'Abort (SIGABRT)',
    description: 'Stop when the program aborts itself, whether by calling abort() or by raising the signal directly.',
    default: true,
  },
  {
    filter: 'SIGPIPE',
    label: 'Broken pipe (SIGPIPE)',
    description:
      'Stop when the program writes to a pipe or socket with nothing left reading it. Worth unchecking for a program written to expect it — piping into `head` produces one every time, and none of them is a bug.',
    default: true,
  },
];

/**
 * The gdb command that makes `signal` either stop the session or go by unremarked.
 *
 * `pass` in both branches on purpose: the signal belongs to the program, and whether the *debugger*
 * pauses is a separate question from whether the program ever receives it. Turning a signal off
 * here means "do not interrupt me for this", not "hide it from the program" — swallowing it would
 * change what the program does under the debugger versus outside it, which is the one thing a
 * debugger must not do.
 */
export function signalHandlingCommand(signal: string, stop: boolean): string {
  return stop ? `handle ${signal} stop print pass` : `handle ${signal} nostop noprint pass`;
}

/** One command per known signal, reflecting `enabled` — the full desired state, as DAP's
 * setExceptionBreakpoints hands it over. A signal missing from `enabled` is one the user unchecked,
 * so it has to be actively turned off rather than left at whatever the last call set. */
export function signalHandlingCommands(enabled: ReadonlySet<string>): string[] {
  return SIGNAL_FILTERS.map((f) => signalHandlingCommand(f.filter, enabled.has(f.filter)));
}

/** The filter set a session starts with, before the client has sent any preference of its own. */
export function defaultEnabledSignals(): Set<string> {
  return new Set(SIGNAL_FILTERS.filter((f) => f.default).map((f) => f.filter));
}
