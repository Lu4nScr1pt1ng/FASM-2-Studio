// What "FASM: Select Debugger" offers and in what order, plus the platform install guidance the
// preflight leads with. Kept free of any `vscode` import so the wording and the ordering — the
// parts with actual behaviour in them — can be asserted without a running editor, the same way
// statusBarMenuItems.ts is split out from statusBarMenu.ts. selectDebugger.ts turns these into a
// real QuickPick.

/**
 * The debugger assumed when nothing is configured. macOS ships no gdb at all, and Apple's bundled
 * lldb does not speak the MI protocol this adapter is built on — lldb-mi is the separate binary
 * that does. Mirrors the default in debug/src/session.ts, which is what actually gets spawned.
 */
export function defaultDebuggerCommand(platform: NodeJS.Platform = process.platform): string {
  return platform === 'darwin' ? 'lldb-mi' : 'gdb';
}

/**
 * Where to get an MI-speaking debugger. This is the part a raw ENOENT could never carry: that the
 * debugger is a separate install this extension deliberately does not bundle, and on macOS that it
 * is not the lldb already on the machine.
 */
export function debuggerInstallHint(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'darwin') {
    return (
      'macOS ships no gdb, and Apple’s bundled lldb does not speak the MI protocol this debugger ' +
      'is built on — the binary that does is lldb-mi, which is a separate install (e.g. via ' +
      'Homebrew, or built from llvm-project). Debugging on macOS is experimental.'
    );
  }
  if (platform === 'win32') {
    return (
      'On Windows, install gdb from MSYS2 (“pacman -S mingw-w64-x86_64-gdb”) or from w64devkit, ' +
      'then add the directory holding gdb.exe to your PATH.'
    );
  }
  return (
    'gdb comes from your distribution’s package manager — “sudo apt install gdb” on Debian/Ubuntu, ' +
    '“sudo dnf install gdb” on Fedora, “sudo pacman -S gdb” on Arch.'
  );
}

export type DebuggerChoiceAction =
  /** Browse for the debugger executable and write it to fasm2Studio.gdbPath. */
  | { kind: 'browse' }
  /** Show the platform's install instructions. */
  | { kind: 'install' }
  /** Drop the cached probe result and check again. */
  | { kind: 'rescan' };

export interface DebuggerChoice {
  label: string;
  description: string;
  detail: string;
  action: DebuggerChoiceAction;
}

/**
 * The options offered, ordered the way selectCompiler.ts and the status bar menu order theirs:
 * whatever is currently broken leads. With no debugger found, browsing for one is the least useful
 * entry — there is most likely nothing on disk to browse to — so the install instructions come
 * first. With a working one they are the least likely to be wanted, and go last.
 */
export function debuggerChoices(command: string, found: boolean): DebuggerChoice[] {
  const browse: DebuggerChoice = {
    label: '$(folder-opened) Point at a debugger',
    description: found ? command : 'not found',
    detail: 'Sets fasm2Studio.gdbPath. Use this when it is installed somewhere that is not on PATH.',
    action: { kind: 'browse' },
  };

  const install: DebuggerChoice = {
    label: '$(cloud-download) I don’t have one yet',
    description: 'gdb, or lldb-mi on macOS',
    detail: debuggerInstallHint(),
    action: { kind: 'install' },
  };

  const rescan: DebuggerChoice = {
    label: '$(refresh) Look again',
    description: 'checked once per session',
    detail: 'Re-checks for the debugger. Use this after installing one, rather than reloading the window.',
    action: { kind: 'rescan' },
  };

  return found ? [browse, rescan, install] : [install, rescan, browse];
}

/** Asking someone who has no debugger which one they want to use is a question they cannot answer;
 * when nothing was found, the prompt has to admit that first. */
export function selectDebuggerPlaceholder(command: string, found: boolean): string {
  return found ? `Currently using ${command}` : `No debugger found — “${command}” is not installed or not on PATH`;
}
