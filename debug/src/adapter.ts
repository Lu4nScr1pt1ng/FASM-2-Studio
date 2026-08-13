// Entry point for the debug adapter process, spawned by the extension via a
// DebugAdapterExecutable. Runs the DAP session over stdio, the standard transport VS Code expects
// for a single-session-per-process adapter (no multi-session server mode needed here).
//
// The same binary doubles as the agent that runs inside the debugged program's terminal — one file
// to ship, and the terminal is started with a command vector this process already knows how to
// build (see inferiorTerminal.ts).
import { TERMINAL_AGENT_FLAG } from './inferiorTerminal';
import { FasmDebugSession } from './session';
import { runTerminalAgent } from './terminalAgent';

const agentFlagIndex = process.argv.indexOf(TERMINAL_AGENT_FLAG);
if (agentFlagIndex >= 0) {
  const endpoint = process.argv[agentFlagIndex + 1];
  if (!endpoint) {
    process.stderr.write(`${TERMINAL_AGENT_FLAG} needs the address of the debug session to report to.\n`);
    process.exit(2);
  }
  void runTerminalAgent(endpoint).then((code) => process.exit(code));
} else {
  FasmDebugSession.run(FasmDebugSession);
}
