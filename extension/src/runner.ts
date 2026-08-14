// The process that runs a built program in the "FASM" terminal, started as that terminal's own
// process rather than typed into a shell running in it.
//
// Typing it in is what used to happen, and it silently ran nothing. `Terminal.sendText` hands the
// command to whatever shell the terminal opened with, and a shell still busy with its own startup
// discards typed-ahead input outright — both readline and fish switch the terminal to raw mode with
// TCSAFLUSH, which throws away anything written before they were ready. The visible result was a
// terminal that opened, showed a prompt, and never ran the program: exactly the state a first run
// lands in, since that is when there is no already-warm terminal to reuse. (Same failure, same
// reason, as the debug adapter's terminal agent — see inferiorTerminal.ts.) A terminal created with
// an explicit shellPath runs that program directly: no shell, no quoting, nothing to race.
//
// This wrapper rather than the built program as the shellPath, because VS Code closes a terminal as
// soon as its process exits. A program that prints and returns would take its own output off the
// screen with it, and there is no waitOnExit in the extension API to ask for otherwise. So the
// program runs as a child with the terminal's tty inherited — it reads and writes the terminal
// directly, this process is not in the middle of its I/O — and the terminal is held open afterwards
// until a key is pressed.

import { spawnSync } from 'child_process';

const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

/** How the program ended, as the one line printed after it. */
export function exitSummary(program: string, status: number | null, signal: NodeJS.Signals | null): string {
  // The signal matters more than the code for the programs this runs: an assembly program that
  // faults exits on SIGSEGV, and "exited with code null" would say nothing about why.
  if (signal) return `${program} was killed by ${signal}`;
  return `${program} exited with code ${status ?? 0}`;
}

/**
 * Ignores whatever is already sitting in the terminal's input buffer, then resolves on the next key.
 *
 * The drain is what keeps the prompt from answering itself: a program that read a line of input
 * leaves the newline the user typed after it in the tty buffer, and treating that as the keypress
 * would close the terminal before its output could be read.
 */
function waitForKey(drainMs = 150): Promise<void> {
  const stdin = process.stdin;
  if (!stdin.isTTY) return Promise.resolve();
  return new Promise((resolve) => {
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', () => undefined);
    setTimeout(() => {
      stdin.read();
      stdin.once('data', () => resolve());
    }, drainMs);
  });
}

async function main(): Promise<void> {
  const [program, ...args] = process.argv.slice(2);
  if (!program) {
    process.stderr.write('fasm2-studio: no program to run\n');
    process.exit(1);
  }

  // ELECTRON_RUN_AS_NODE is set on this terminal only to make VS Code's own binary behave as Node
  // (see runCommand.ts); it is not part of the environment the user's program should see.
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;

  process.stdout.write(`${DIM}${[program, ...args].join(' ')}${RESET}\r\n`);
  const result = spawnSync(program, args, { stdio: 'inherit', env });

  if (result.error) {
    process.stdout.write(`\r\n${DIM}could not run ${program}: ${result.error.message}${RESET}\r\n`);
  } else {
    process.stdout.write(`\r\n${DIM}${exitSummary(program, result.status, result.signal)}${RESET}\r\n`);
  }

  process.stdout.write(`${DIM}Press any key to close this terminal.${RESET}\r\n`);
  await waitForKey();
  // Always 0: this process's own exit code is the terminal's, and VS Code raises a notification for
  // a non-zero one. The program's status is reported above, where it belongs — as output, not as a
  // popup claiming the terminal failed.
  process.exit(0);
}

void main();
