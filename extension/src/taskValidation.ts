import { Dialect } from './types';

// Kept vscode-free (like dialect.ts) so it's plain-mocha unit-testable without an Extension Host.
interface TaskDefinitionShape {
  file?: unknown;
  output?: unknown;
  dialect?: unknown;
  extraArgs?: unknown;
  debugBuild?: unknown;
}

const DIALECTS: Dialect[] = ['fasm2', 'fasm1'];

/**
 * A "fasm" task's definition comes straight from a user-hand-edited tasks.json, with no schema
 * enforcement of its own — a malformed field (e.g. `"extraArgs": "foo"` instead of an array, or
 * `"dialect": "fasm3"`) would otherwise flow unchecked into ShellExecution's args or the dialect
 * check, surfacing only as a confusing shell-execution or "unknown dialect" failure far from the
 * actual mistake. Returns a human-readable description of the first problem found, or undefined.
 */
export function validateTaskDefinition(def: TaskDefinitionShape): string | undefined {
  if (typeof def.file !== 'string' || !def.file) return '"file" must be a non-empty string.';
  if (def.output !== undefined && typeof def.output !== 'string') return '"output" must be a string.';
  if (def.dialect !== undefined && !DIALECTS.includes(def.dialect as Dialect)) return '"dialect" must be "fasm2" or "fasm1".';
  if (def.extraArgs !== undefined && (!Array.isArray(def.extraArgs) || def.extraArgs.some((a) => typeof a !== 'string'))) {
    return '"extraArgs" must be an array of strings.';
  }
  if (def.debugBuild !== undefined && typeof def.debugBuild !== 'boolean') return '"debugBuild" must be a boolean.';
  return undefined;
}
