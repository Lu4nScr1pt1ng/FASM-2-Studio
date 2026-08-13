import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { LanguageClient } from 'vscode-languageclient/node';
import { activeFasmEditor, buildableFsPath, NO_ACTIVE_FASM_FILE_MESSAGE } from './activeEditor';
import { dialectFor, getDefaultOutputPath, getListingPath } from './buildPaths';
import { fasmConfig, MESSAGE_PREFIX } from './config';
import { fasmDebugConfigurations, FASM_DEBUG_TYPE } from './debugConfigurations';
import { resolveEntryPointFsPath } from './entryPointResolver';
import { openInferiorTerminal } from './inferiorTerminal';
import { runOutputBinary } from './runCommand';
import { ensureDebuggerAvailable } from './selectDebugger';
import { runBuildTask } from './taskProvider';
import { ensureTrusted } from './workspaceTrust';

export { FASM_DEBUG_TYPE };

/**
 * Waits for a file to appear, briefly. `vscode.tasks.onDidEndTaskProcess` firing (a build task
 * reporting exit code 0) doesn't strictly guarantee the file it just wrote is visible to this
 * process's very next `fs` call yet — observed as a rare race where the debug adapter's launch
 * request fails with ENOENT on a listing file the build just successfully produced.
 */
async function waitForFile(filePath: string, timeoutMs = 2000): Promise<boolean> {
  const start = Date.now();
  while (!fs.existsSync(filePath)) {
    if (Date.now() - start >= timeoutMs) return false;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return true;
}

export class FasmDebugAdapterDescriptorFactory implements vscode.DebugAdapterDescriptorFactory {
  constructor(private readonly context: vscode.ExtensionContext) {}

  createDebugAdapterDescriptor(): vscode.DebugAdapterDescriptor {
    const adapterPath = this.context.asAbsolutePath(path.join('dist', 'adapter.js'));
    return new vscode.DebugAdapterExecutable(process.execPath, [adapterPath]);
  }
}

export class FasmDebugConfigurationProvider implements vscode.DebugConfigurationProvider {
  /** A getter, not the client itself: the language client isn't started yet when this provider
   * is constructed during activation, so the current value has to be looked up at call time. */
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly getClient: () => LanguageClient | undefined,
  ) {}

  /** Index 0 is load-bearing: resolveDebugConfiguration falls back to it for "F5 with no
   * launch.json at all", which must be the launch config rather than one that asks for a pid. */
  provideDebugConfigurations(): vscode.DebugConfiguration[] {
    return fasmDebugConfigurations();
  }

  /**
   * The listing an attach session needs, or undefined if the user declined to produce one.
   *
   * Attach is the one case where building is not obviously the right thing to do: the listing has
   * to describe the binary that is *already running* (or that produced the core), and a rebuild
   * from since-edited source would map addresses onto source lines they never belonged to — a
   * debugger confidently pointing at the wrong line. So a missing listing asks first, and says what
   * the assumption is, rather than either silently rebuilding or dead-ending.
   */
  private async ensureAttachListing(asmFile: string, listingFile: string): Promise<boolean> {
    if (fs.existsSync(listingFile)) return true;

    const build = 'Build it now';
    const choice = await vscode.window.showWarningMessage(
      `${MESSAGE_PREFIX}no listing file at ${listingFile}. Attaching needs the listing from the build that produced the program you are attaching to — building one now only maps correctly if the source has not changed since.`,
      { modal: true },
      build,
    );
    if (choice !== build) return false;

    const exitCode = await runBuildTask(asmFile, true);
    if (exitCode !== 0) return false;
    return waitForFile(listingFile);
  }

  async resolveDebugConfiguration(
    _folder: vscode.WorkspaceFolder | undefined,
    config: vscode.DebugConfiguration,
  ): Promise<vscode.DebugConfiguration | undefined> {
    // Gated here rather than in the FASM: Debug command because this is the only point every
    // launch passes through — F5 against a launch.json entry never touches that command.
    if (!(await ensureTrusted('Debugging'))) return undefined;

    if (!config.type && !config.request) {
      // Launched via F5 with no launch.json at all: fall back to the active editor.
      const editor = activeFasmEditor();
      if (!editor) {
        void vscode.window.showErrorMessage(NO_ACTIVE_FASM_FILE_MESSAGE);
        return undefined;
      }
      const file = await buildableFsPath(editor.document);
      if (!file) return undefined;
      config = this.provideDebugConfigurations()[0];
      config.asmFile = file;
    }

    let asmFile = config.asmFile as string;
    if (!asmFile) {
      void vscode.window.showErrorMessage(`${MESSAGE_PREFIX}no source file specified (set "asmFile" in launch.json).`);
      return undefined;
    }

    // Everything downstream — entry-point resolution, the build, gdb — assumes a real file. A
    // launch.json whose "asmFile" is `${file}` while an unsaved buffer is focused substitutes the
    // buffer's label rather than a path, and a hand-written relative path is resolved against the
    // filesystem root rather than the workspace. Both used to reach the server as a path that
    // resolves to nothing, which surfaced as the "which project is this for?" quick pick.
    if (!fs.existsSync(asmFile)) {
      void vscode.window.showErrorMessage(`${MESSAGE_PREFIX}no such source file: ${asmFile}. "asmFile" must be an absolute path to a saved file.`);
      return undefined;
    }

    // asmFile may be a fragment (no "format" directive of its own) — resolve to the real entry
    // point it should actually build/debug as, same as the FASM: Build/Run/Debug commands. If the
    // language server isn't up yet, fall back to asmFile as-is rather than blocking the launch.
    const client = this.getClient();
    if (client) {
      const entryFile = await resolveEntryPointFsPath(client, asmFile);
      if (!entryFile) return undefined;
      asmFile = entryFile;
      config.asmFile = entryFile;
    }

    // "Run Without Debugging" (Ctrl+F5) reaches the debug machinery like any other launch, just
    // with noDebug set — so left unhandled it started gdb and stopped the program on its first
    // instruction, which is the exact opposite of what was asked for. There is nothing for a
    // debug adapter to do here: build it, run it in a terminal, and cancel the session by
    // returning undefined. Attach has no meaning without a debugger, so it is left alone.
    if (config.noDebug && config.request !== 'attach') {
      const exitCode = await runBuildTask(asmFile);
      if (exitCode === 0) await runOutputBinary(getDefaultOutputPath(asmFile), path.dirname(asmFile));
      return undefined;
    }

    const dialect = await dialectFor(asmFile);
    if (dialect !== 'fasm2') {
      void vscode.window.showErrorMessage(`${MESSAGE_PREFIX}Debug currently only supports fasm2/fasmg sources.`);
      return undefined;
    }

    const isAttach = config.request === 'attach';

    // Before anything is built, opened or spawned: is there a debugger to drive at all? Placed
    // this early because everything below it is wasted work if there is not — a build runs, a
    // listing is produced, a terminal is opened, and only then does the adapter fail with an
    // ENOENT from deep inside gdbDriver.start(), which reaches the user as the bare text
    // "gdb error: spawn gdb ENOENT" in the Debug Console. See gdbDiscovery.ts.
    if (!(await ensureDebuggerAvailable(config.gdbPath as string | undefined))) return undefined;

    // VS Code resolves and runs preLaunchTask *before* calling this method at all — by the time
    // we're here, a broken task-label lookup has already failed the launch, so nothing set here
    // could fix it after the fact. Our generated configs never set preLaunchTask for exactly this
    // reason: build directly instead, ourselves, right now. A launch.json with a genuinely custom
    // preLaunchTask is left alone — that's an explicit user choice, resolved by VS Code as usual.
    //
    // Attach never builds unprompted at all: see ensureAttachListing.
    if (!config.preLaunchTask && !isAttach) {
      const exitCode = await runBuildTask(asmFile, true);
      if (exitCode !== 0) return undefined;

      const expectedListing = getListingPath(getDefaultOutputPath(asmFile));
      if (!(await waitForFile(expectedListing))) {
        void vscode.window.showErrorMessage(`${MESSAGE_PREFIX}build succeeded but the expected listing file was not found: ${expectedListing}`);
        return undefined;
      }
    }

    // launch.json's values are typed "any" by VS Code — a hand-edited config with e.g. a numeric
    // "program" would otherwise flow silently into getListingPath/path.dirname below and fail with
    // an obscure downstream error instead of a clear one naming the actual bad field.
    for (const key of ['program', 'listingFile', 'cwd'] as const) {
      if (config[key] !== undefined && typeof config[key] !== 'string') {
        void vscode.window.showErrorMessage(`${MESSAGE_PREFIX}"${key}" in launch.json must be a string.`);
        return undefined;
      }
    }

    // A terminal by default, not the Debug Console: assembly programs are console programs, and a
    // program blocked on a `read` syscall with no stdin to answer it looks exactly like a hung
    // debugger. Output-only programs are unaffected beyond which panel their output lands in.
    // Attach has nothing to point anywhere: the program already has whatever terminal it was
    // started with, and a core dump has no I/O at all.
    const CONSOLE_KINDS = ['integratedTerminal', 'externalTerminal', 'debugConsole'];
    if (!isAttach) {
      if (config.console === undefined) {
        config.console = 'integratedTerminal';
      } else if (!CONSOLE_KINDS.includes(config.console as string)) {
        void vscode.window.showErrorMessage(`${MESSAGE_PREFIX}"console" in launch.json must be one of ${CONSOLE_KINDS.join(', ')}.`);
        return undefined;
      }
    }

    const program = (config.program as string) ?? getDefaultOutputPath(asmFile);
    config.program = program;
    config.listingFile = (config.listingFile as string) ?? getListingPath(program);
    config.cwd = (config.cwd as string) ?? path.dirname(asmFile);
    if (!config.gdbPath) {
      const configuredGdb = fasmConfig().get<string>('gdbPath');
      if (configuredGdb) config.gdbPath = configuredGdb;
    }

    if (isAttach) {
      if (config.processId === undefined && !config.coreFile) {
        void vscode.window.showErrorMessage(
          `${MESSAGE_PREFIX}an attach configuration needs "processId" (a running process) or "coreFile" (a core dump).`,
        );
        return undefined;
      }
      // The program itself has to exist to attach at all — gdb reads the binary for its code bytes,
      // and the core references it. Checked here so the failure names the file rather than arriving
      // as a gdb error about symbols.
      if (!fs.existsSync(program)) {
        void vscode.window.showErrorMessage(`${MESSAGE_PREFIX}no program to attach against at ${program}. Build it first, or set "program" in launch.json.`);
        return undefined;
      }
      if (!(await this.ensureAttachListing(asmFile, config.listingFile as string))) return undefined;
    }

    // Last, so that nothing after this can abandon a terminal it opened: every way this method can
    // still decline the launch has already been taken.
    if (!isAttach) {
      config.terminalEndpoint = openInferiorTerminal(this.context, config.console as string | undefined, config.cwd as string);
    }

    return config;
  }
}
