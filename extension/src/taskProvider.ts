import * as path from 'path';
import * as vscode from 'vscode';
import { LanguageClient } from 'vscode-languageclient/node';
import { activeFasmEditor } from './activeEditor';
import { listEntryPoints } from './entryPoints';
import { dialectFor, getDefaultOutputPath } from './buildPaths';
import { resolveCompiler } from './compilerDiscovery';
import { CONFIG_SECTION, fasmConfig, MESSAGE_PREFIX, stringArraySetting } from './config';
import { errorMessage } from './errorMessage';
import { validateTaskDefinition } from './taskValidation';
import { COMPILER_PATH_SETTING, Dialect, DIALECT_LABEL } from './types';

export const FASM_TASK_TYPE = 'fasm';

export interface FasmTaskDefinition extends vscode.TaskDefinition {
  type: typeof FASM_TASK_TYPE;
  file: string;
  output?: string;
  dialect?: Dialect;
  extraArgs?: string[];
  /** Injects the bundled listing macro via fasm2's -i flag, producing a .lst address/line map
   * for the debugger. fasm2 (fasmg) only — fasm1's own native -s listing flag produces a
   * different format this extension doesn't parse, so a debug build with dialect fasm1 fails
   * with a clear error rather than silently producing a listing the debugger can't read. */
  debugBuild?: boolean;
}

/**
 * fasm2Studio.includePath as a ShellExecutionOptions.env override, or undefined if unset (VS Code
 * merges a provided env with the parent process' own, so this only needs to carry INCLUDE itself).
 * Many real fasmg projects need this to build at all: a bare `include 'foo.inc'` that isn't found
 * next to the including file falls back to the directory the assembly process was started from,
 * then to the semicolon-separated paths in the INCLUDE environment variable — exactly the
 * mechanism fasmg's own bundled make.bat scripts set up themselves (e.g.
 * packages/x86/examples/windows/make.bat does `set include=..\..\include` before building).
 */
function configuredIncludePathEnv(sourceFsPath: string): { [key: string]: string } | undefined {
  const configured = fasmConfig(vscode.Uri.file(sourceFsPath)).get<string>('includePath', '').trim();
  return configured ? { INCLUDE: configured } : undefined;
}

/**
 * `fasm2Studio.compilerArgs` — extra flags for every invocation of the assembler.
 *
 * A project can require them to assemble at all: fasmg's `-p` raises a pass limit that a
 * macro-heavy project genuinely exceeds, and `-i` is how a build-time definition is supplied,
 * since fasmg (unlike fasm1) has no `-d`. Without a setting, the only way to pass one was a
 * hand-written tasks.json, which Build, Run and Debug do not go through.
 *
 * Blank entries are dropped. An empty argument means nothing to either assembler — it would be
 * read as a second positional parameter, i.e. as an output file named "" — so it can only be a
 * leftover from editing the list, and passing it on would fail the build for a reason the user
 * cannot see in their own settings.
 */
function configuredCompilerArgs(sourceFsPath: string): string[] {
  return stringArraySetting('compilerArgs', vscode.Uri.file(sourceFsPath)).filter((arg) => arg.trim().length > 0);
}

/** Path to the listing.inc macro bundled with the extension (see extension/esbuild.js's
 * copyDebugAdapterBundle) — resolved relative to this bundled module's own location so it works
 * regardless of where the extension is installed. */
function bundledListingIncPath(): string {
  return path.join(__dirname, 'debug-support', 'listing.inc');
}

/** Resolves a task-definition-relative path against `folder` (the task's own owning workspace
 * folder, when known) rather than always guessing `workspaceFolders[0]` — in a multi-root
 * workspace, a task defined in the second or third folder's own tasks.json otherwise had its
 * relative "file"/"output" resolved against a completely unrelated folder. */
function resolveWorkspacePath(raw: string, folder?: vscode.WorkspaceFolder): string {
  if (path.isAbsolute(raw)) return raw;
  const base = folder ?? vscode.workspace.workspaceFolders?.[0];
  return base ? path.join(base.uri.fsPath, raw) : raw;
}

export async function buildTask(def: FasmTaskDefinition, name: string, folder?: vscode.WorkspaceFolder): Promise<vscode.Task> {
  const sourceFsPath = resolveWorkspacePath(def.file, folder);
  const outputFsPath = def.output ? resolveWorkspacePath(def.output, folder) : getDefaultOutputPath(sourceFsPath);
  const dialect = await dialectFor(sourceFsPath, def.dialect);

  if (def.debugBuild && dialect !== 'fasm2') {
    throw new Error(`${MESSAGE_PREFIX}Debug currently only supports fasm2/fasmg sources (fasm1 listing format is not supported).`);
  }

  const compiler = await resolveCompiler(dialect, vscode.Uri.file(sourceFsPath));
  if (!compiler) {
    throw new Error(
      `${MESSAGE_PREFIX}Could not find a ${DIALECT_LABEL[dialect]} executable on PATH. ` +
        `Set "${CONFIG_SECTION}.${COMPILER_PATH_SETTING[dialect]}" or install it.`,
    );
  }

  // fasm2/fasm1 won't create missing parent directories for their own output file — needed for
  // fasm2Studio.buildOutputPath to actually redirect output into a not-yet-existing directory
  // (e.g. a project's already-gitignored "bin/") instead of silently failing to write there.
  try {
    await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(outputFsPath)));
  } catch {
    // Best-effort: if this fails, the compiler invocation below will surface its own clear error.
  }

  const args: (string | vscode.ShellQuotedString)[] = [sourceFsPath, outputFsPath];
  // fasm2Studio.fasm2Preload — supplies the x86 package to a bare `fasmg` binary the same way the
  // official fasm2 wrapper script does. Added before the listing include below so that a debug
  // build still gets both, in the order the preload expects (instruction set first). fasm1 has its
  // own built-in instruction set and no -i flag, so this never applies there.
  const preload = dialect === 'fasm2' ? fasmConfig(vscode.Uri.file(sourceFsPath)).get<string>('fasm2Preload', '').trim() : '';
  if (preload) {
    args.push('-i', { value: `include "${preload.replace(/"/g, '""')}"`, quoting: vscode.ShellQuoting.Strong });
  }
  // The user's own flags sit between the preload and the listing include, and that position is the
  // whole of what the ordering rule has to say: a `-i` line of theirs may use the instruction set
  // the preload defines, and nothing the preload does can depend on theirs. Being last among the
  // flags that carry a value also means a repeated one wins — fasmg takes the final occurrence, so
  // `["-e", "5"]` genuinely replaces the `-e 200` a diagnostics compile passes, rather than being
  // silently ignored. Each entry is one argument and is quoted as written, so a value containing a
  // space (`-i` and `define X 1`) stays a single argument rather than being re-split by the shell.
  args.push(...(def.extraArgs ?? []), ...configuredCompilerArgs(sourceFsPath));
  if (def.debugBuild) {
    // vscode.ShellQuoting.Strong wraps this whole value in single quotes on POSIX shells but
    // does not escape single quotes *within* the value — so the fasm-level string must use
    // double quotes instead, which fasm accepts equally well, to avoid colliding with the
    // shell's own outer quoting.
    const listingPath = bundledListingIncPath().replace(/\\/g, '/').replace(/"/g, '""');
    args.push('-i', { value: `include "${listingPath}"`, quoting: vscode.ShellQuoting.Strong });
  }
  // fasm2Studio.includePath, forwarded as INCLUDE so a bare `include 'foo.inc'` not found next to
  // the including file still resolves — many real fasmg projects need this to build at all (see
  // configuredIncludePathEnv's doc comment).
  const execution = new vscode.ShellExecution(compiler.path, args, {
    cwd: path.dirname(sourceFsPath),
    env: configuredIncludePathEnv(sourceFsPath),
  });

  const task = new vscode.Task(def, vscode.TaskScope.Workspace, name, 'fasm', execution);
  task.presentationOptions = { reveal: vscode.TaskRevealKind.Always, panel: vscode.TaskPanelKind.Shared, clear: true };
  // Without a group, VS Code files these under "other tasks": Ctrl+Shift+B (Run Build Task) offers
  // them only behind an extra "no build task is configured" step, and "Configure Default Build
  // Task" cannot pin one — for an extension whose whole point is assembling the open file, the
  // editor's standard build gesture should reach it directly.
  task.group = vscode.TaskGroup.Build;
  return task;
}

export const DEBUG_BUILD_TASK_NAME = 'Debug build (active file)';

/**
 * Builds and runs a task directly via the task-execution API rather than through VS Code's
 * preLaunchTask label lookup — which asks every TaskProvider for tasks and matches by label, so
 * it only ever finds FasmTaskProvider's dynamic tasks when the active editor happens to be a fasm
 * file at that exact moment (see FasmTaskProvider.provideTasks below). Debug launches (which may
 * start from the Run and Debug panel, not the editor) need this more direct, reliable path.
 */
export async function runBuildTask(file: string, debugBuild = false): Promise<number | undefined> {
  const def: FasmTaskDefinition = { type: FASM_TASK_TYPE, file, debugBuild };
  let task: vscode.Task;
  try {
    task = await buildTask(def, debugBuild ? DEBUG_BUILD_TASK_NAME : 'Build active file');
  } catch (err) {
    void vscode.window.showErrorMessage(errorMessage(err));
    return undefined;
  }

  const execution = await vscode.tasks.executeTask(task);
  return new Promise<number | undefined>((resolve) => {
    const disposable = vscode.tasks.onDidEndTaskProcess((e) => {
      if (e.execution === execution) {
        disposable.dispose();
        resolve(e.exitCode);
      }
    });
  });
}

export class FasmTaskProvider implements vscode.TaskProvider {
  constructor(private readonly getClient: () => LanguageClient | undefined) {}

  /**
   * One "Build" task per entry point in the workspace, for when there is no active fasm file to
   * build instead.
   *
   * Without this, `Ctrl+Shift+B` from a focused README — or straight after opening a folder,
   * before any source file has been clicked — found no tasks at all and reported the workspace as
   * having no build task configured, in a workspace whose every file this extension knows how to
   * build. Entry points only: a fragment cannot be assembled standalone, which is the same reason
   * the code lenses appear on entry points alone.
   */
  private async workspaceBuildTasks(): Promise<vscode.Task[]> {
    const entryPoints = await listEntryPoints(this.getClient());
    const built = await Promise.allSettled(
      entryPoints.map((entry) => buildTask({ type: FASM_TASK_TYPE, file: entry.fsPath }, `Build ${entry.relativePath}`)),
    );
    // Each can fail on its own (a dialect whose compiler isn't installed), and one such entry point
    // shouldn't remove the rest of the workspace's from the picker.
    return built.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []));
  }

  async provideTasks(): Promise<vscode.Task[]> {
    const editor = activeFasmEditor();
    if (!editor) return this.workspaceBuildTasks();

    const file = editor.document.uri.fsPath;

    // Both resolve the compiler independently, but resolveCompiler already de-dupes concurrent
    // probes for the same dialect into one in-flight promise, so running them together costs no
    // extra process spawns — just avoids waiting for the first to fully finish before starting
    // the second.
    const [build, debugBuild] = await Promise.allSettled([
      buildTask({ type: FASM_TASK_TYPE, file }, 'Build active file'),
      buildTask({ type: FASM_TASK_TYPE, file, debugBuild: true }, DEBUG_BUILD_TASK_NAME),
    ]);

    const tasks: vscode.Task[] = [];
    // Either can fail independently (no compiler found, or not a fasm2 file for the debug
    // build) — contribute whichever succeeded rather than surfacing a broken task in the picker.
    if (build.status === 'fulfilled') tasks.push(build.value);
    if (debugBuild.status === 'fulfilled') tasks.push(debugBuild.value);

    return tasks;
  }

  async resolveTask(task: vscode.Task): Promise<vscode.Task | undefined> {
    const def = task.definition as FasmTaskDefinition;
    if (def.file === undefined) return undefined; // no "file" at all — not a task this provider handles

    const validationError = validateTaskDefinition(def);
    if (validationError) {
      void vscode.window.showErrorMessage(`${MESSAGE_PREFIX}invalid "fasm" task in tasks.json — ${validationError}`);
      return undefined;
    }

    // A task from a workspace folder's own tasks.json carries that folder as task.scope (as
    // opposed to the vscode.TaskScope.Workspace/Global enum values) — the right base for a
    // relative "file"/"output" in a multi-root workspace, see resolveWorkspacePath.
    const folder = typeof task.scope === 'object' ? task.scope : undefined;
    try {
      return await buildTask(def, task.name || 'Build', folder);
    } catch (err) {
      void vscode.window.showErrorMessage(errorMessage(err));
      return undefined;
    }
  }
}
