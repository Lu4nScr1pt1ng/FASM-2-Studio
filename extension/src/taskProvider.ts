import * as path from 'path';
import * as vscode from 'vscode';
import { resolveCompiler } from './compilerDiscovery';
import { detectDialect } from './dialect';
import { Dialect } from './types';

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

function defaultOutputFor(sourceFsPath: string): string {
  const { dir, name } = path.parse(sourceFsPath);
  return path.join(dir, name);
}

export function getListingPath(outputFsPath: string): string {
  return `${outputFsPath}.lst`;
}

/** Path to the listing.inc macro bundled with the extension (see extension/esbuild.js's
 * copyDebugAdapterBundle) — resolved relative to this bundled module's own location so it works
 * regardless of where the extension is installed. */
function bundledListingIncPath(): string {
  return path.join(__dirname, 'debug-support', 'listing.inc');
}

export async function dialectFor(sourceFsPath: string, override?: Dialect): Promise<Dialect> {
  if (override) return override;
  const config = vscode.workspace.getConfiguration('fasm2Studio');
  const fallback = config.get<Dialect>('defaultDialect', 'fasm2');
  try {
    const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(sourceFsPath));
    return detectDialect(Buffer.from(bytes).toString('utf8'), fallback);
  } catch {
    return fallback;
  }
}

function resolveWorkspacePath(raw: string): string {
  if (path.isAbsolute(raw)) return raw;
  const folder = vscode.workspace.workspaceFolders?.[0];
  return folder ? path.join(folder.uri.fsPath, raw) : raw;
}

export async function buildTask(def: FasmTaskDefinition, name: string): Promise<vscode.Task> {
  const sourceFsPath = resolveWorkspacePath(def.file);
  const outputFsPath = def.output ? resolveWorkspacePath(def.output) : defaultOutputFor(sourceFsPath);
  const dialect = await dialectFor(sourceFsPath, def.dialect);

  if (def.debugBuild && dialect !== 'fasm2') {
    throw new Error('FASM: Debug currently only supports fasm2/fasmg sources (fasm1 listing format is not supported).');
  }

  const compiler = await resolveCompiler(dialect);
  if (!compiler) {
    throw new Error(
      `Could not find a ${dialect === 'fasm1' ? 'fasm1' : 'fasm2/fasmg'} executable on PATH. ` +
        `Set "fasm2Studio.${dialect === 'fasm1' ? 'fasm1CompilerPath' : 'fasm2CompilerPath'}" or install it.`,
    );
  }

  const args: (string | vscode.ShellQuotedString)[] = [sourceFsPath, outputFsPath, ...(def.extraArgs ?? [])];
  if (def.debugBuild) {
    // vscode.ShellQuoting.Strong wraps this whole value in single quotes on POSIX shells but
    // does not escape single quotes *within* the value — so the fasm-level string must use
    // double quotes instead, which fasm accepts equally well, to avoid colliding with the
    // shell's own outer quoting.
    const listingPath = bundledListingIncPath().replace(/\\/g, '/').replace(/"/g, '""');
    args.push('-i', { value: `include "${listingPath}"`, quoting: vscode.ShellQuoting.Strong });
  }
  const execution = new vscode.ShellExecution(compiler.path, args, { cwd: path.dirname(sourceFsPath) });

  const task = new vscode.Task(def, vscode.TaskScope.Workspace, name, 'fasm', execution);
  task.presentationOptions = { reveal: vscode.TaskRevealKind.Always, panel: vscode.TaskPanelKind.Shared, clear: true };
  return task;
}

export function getDefaultOutputPath(sourceFsPath: string): string {
  return defaultOutputFor(sourceFsPath);
}

export const DEBUG_BUILD_TASK_NAME = 'Debug build (active file)';

export class FasmTaskProvider implements vscode.TaskProvider {
  async provideTasks(): Promise<vscode.Task[]> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== 'fasm') return [];

    const file = editor.document.uri.fsPath;
    const tasks: vscode.Task[] = [];

    try {
      tasks.push(await buildTask({ type: FASM_TASK_TYPE, file }, 'Build active file'));
    } catch {
      // Compiler not found: contribute nothing rather than surfacing a broken task in the picker.
    }
    try {
      tasks.push(await buildTask({ type: FASM_TASK_TYPE, file, debugBuild: true }, DEBUG_BUILD_TASK_NAME));
    } catch {
      // Not a fasm2 file, or compiler not found — same reasoning as above.
    }

    return tasks;
  }

  async resolveTask(task: vscode.Task): Promise<vscode.Task | undefined> {
    const def = task.definition as FasmTaskDefinition;
    if (!def.file) return undefined;
    try {
      return await buildTask(def, task.name || 'Build');
    } catch (err) {
      void vscode.window.showErrorMessage((err as Error).message);
      return undefined;
    }
  }
}
