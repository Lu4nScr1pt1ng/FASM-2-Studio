// Runs a previously built output binary in the integrated terminal. fasm2 (like fasm1) never
// sets the executable bit on the files it produces, so POSIX platforms need an explicit chmod
// before exec — skipping it would surface a confusing "Permission denied" on every first run.

import * as fs from 'fs/promises';
import * as os from 'os';
import * as vscode from 'vscode';
import { quoteForShell } from './shellQuote';

const TERMINAL_NAME = 'FASM';

async function ensureExecutable(outputFsPath: string): Promise<void> {
  if (os.platform() === 'win32') return;
  try {
    await fs.chmod(outputFsPath, 0o755);
  } catch {
    // Output may not exist yet if the build failed; let the terminal command surface that.
  }
}

function getOrCreateTerminal(): vscode.Terminal {
  const existing = vscode.window.terminals.find((t) => t.name === TERMINAL_NAME);
  return existing ?? vscode.window.createTerminal(TERMINAL_NAME);
}

export async function runOutputBinary(outputFsPath: string): Promise<void> {
  await ensureExecutable(outputFsPath);
  const terminal = getOrCreateTerminal();
  terminal.show(true);
  // outputFsPath is always absolute (derived from the source file's own absolute path), so it
  // runs directly on every shell without needing a "./" prefix or PATH lookup.
  terminal.sendText(quoteForShell(outputFsPath));
}
