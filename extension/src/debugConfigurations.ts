// The launch/attach pair this extension can start a debug session from without a launch.json, and
// the provider that offers them in the Run and Debug panel's dropdown.
//
// Deliberately separate from debugAdapter.ts, which pulls in the language client: nothing here
// needs it, and keeping the split lets these be exercised directly rather than only through a
// running extension host.
import * as vscode from 'vscode';
import { PICK_PROCESS_COMMAND } from './pickProcess';

export const FASM_DEBUG_TYPE = 'fasm';

/** Shared by both registrations (initial and dynamic) so the two can never drift apart. */
export function fasmDebugConfigurations(): vscode.DebugConfiguration[] {
  return [
    {
      type: FASM_DEBUG_TYPE,
      request: 'launch',
      name: 'Debug FASM program',
      asmFile: '${file}',
      stopOnEntry: true,
    },
    {
      type: FASM_DEBUG_TYPE,
      request: 'attach',
      name: 'Attach to running FASM program',
      asmFile: '${file}',
      processId: `\${command:${PICK_PROCESS_COMMAND}}`,
    },
  ];
}

/**
 * Puts those same two configurations in the Run and Debug panel's dropdown, under a "FASM" group,
 * for a workspace that has no launch.json.
 *
 * Registered for the Dynamic trigger kind, and deliberately a *different object* from
 * FasmDebugConfigurationProvider rather than the same one registered twice. The trigger kind
 * applies only to `provideDebugConfigurations`; VS Code documents that "registering a single
 * provider with resolve methods for different trigger kinds results in the same resolve methods
 * called multiple times". Since resolveDebugConfiguration is what assembles the program and opens
 * the inferior terminal, sharing one object would build every launch twice and strand a terminal.
 * That is what the absence of a resolve method here buys, so it must stay absent.
 */
export class FasmDynamicDebugConfigurationProvider implements vscode.DebugConfigurationProvider {
  provideDebugConfigurations(): vscode.DebugConfiguration[] {
    return fasmDebugConfigurations();
  }
}
