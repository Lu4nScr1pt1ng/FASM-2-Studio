// Runs a previously built output binary in the integrated terminal. fasm2 (like fasm1) never
// sets the executable bit on the files it produces, so POSIX platforms need an explicit chmod
// before exec — skipping it would surface a confusing "Permission denied" on every first run.

import * as fs from 'fs/promises';
import * as os from 'os';
import * as vscode from 'vscode';
import { MESSAGE_PREFIX } from './config';
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
  // "FASM: Run" deliberately does not build first — it runs whatever was built last. When there is
  // nothing there, sending the command anyway produced a bare shell error ("no such file or
  // directory") against an absolute path the user never typed, which reads as a broken extension
  // rather than "you haven't built this yet". Name the actual situation and offer the fix.
  if (!(await exists(outputFsPath))) {
    const build = 'Build it now';
    const choice = await vscode.window.showWarningMessage(
      `${MESSAGE_PREFIX}nothing built at ${outputFsPath} yet.`,
      build,
      'Cancel',
    );
    if (choice !== build) return;
    await vscode.commands.executeCommand('fasm2Studio.buildAndRun');
    return;
  }

  await ensureExecutable(outputFsPath);
  const terminal = getOrCreateTerminal();
  terminal.show(true);
  // outputFsPath is always absolute (derived from the source file's own absolute path), so it
  // runs directly on every shell without needing a "./" prefix or PATH lookup.
  terminal.sendText(quoteForShell(outputFsPath));
}

async function exists(fsPath: string): Promise<boolean> {
  try {
    await fs.access(fsPath);
    return true;
  } catch {
    return false;
  }
}
