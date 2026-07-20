// Entry point for the debug adapter process, spawned by the extension via a
// DebugAdapterExecutable. Runs the DAP session over stdio, the standard transport VS Code expects
// for a single-session-per-process adapter (no multi-session server mode needed here).
import { FasmDebugSession } from './session';

FasmDebugSession.run(FasmDebugSession);
