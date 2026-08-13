// The Run and Debug panel's configuration dropdown, for a workspace with no launch.json.
//
// Registering only for the Initial trigger kind meant those configurations existed solely as
// something to copy *into* a launch.json that had to be created first — the panel offered "create a
// launch.json file" and nothing else, so the shortest path to a debug session ran through a JSON
// file the user never needed.
import * as assert from 'assert';
import * as vscode from 'vscode';
import { fasmDebugConfigurations, FasmDynamicDebugConfigurationProvider, FASM_DEBUG_TYPE } from '../../src/debugConfigurations';

describe('dynamic debug configurations', () => {
  before(async () => {
    const extension = vscode.extensions.getExtension('Lu4nScr1pt1ng.fasm2-studio');
    assert.ok(extension, 'the extension is not installed in this test host');
    await extension.activate();
  });

  // Asserted against the provider rather than through VS Code: there is no API — and no command
  // in the test host, `debug.getDebugConfigurationsForType` does not exist — that enumerates the
  // dynamic configurations registered for a type. What the dropdown shows is exactly what this
  // returns, so the contract is covered here and the registration itself is covered by reading
  // extension.ts. Keep that in mind before trusting this file to catch a dropped registration.
  it('offers both a launch and an attach entry, which is what the dropdown lists', () => {
    const configurations = new FasmDynamicDebugConfigurationProvider().provideDebugConfigurations();

    assert.ok(configurations.length > 0, 'no dynamic configurations were offered');
    for (const configuration of configurations) {
      assert.strictEqual(configuration.type, FASM_DEBUG_TYPE);
    }
    assert.ok(configurations.some((c) => c.request === 'launch'), 'no launch configuration');
    assert.ok(configurations.some((c) => c.request === 'attach'), 'no attach configuration');
  });

  // resolveDebugConfiguration is what builds the program and opens the inferior terminal, and VS
  // Code calls it once per *registered provider* regardless of trigger kind. Sharing one object
  // across both registrations would therefore assemble every launch twice and strand a terminal.
  it('keeps the dynamic provider free of resolve methods, so nothing is resolved twice', () => {
    const provider = new FasmDynamicDebugConfigurationProvider() as vscode.DebugConfigurationProvider;
    assert.strictEqual(provider.resolveDebugConfiguration, undefined);
    assert.strictEqual(provider.resolveDebugConfigurationWithSubstitutedVariables, undefined);
  });

  it('offers the same entries the "create a launch.json" flow would, so the two cannot drift', () => {
    assert.deepStrictEqual(new FasmDynamicDebugConfigurationProvider().provideDebugConfigurations(), fasmDebugConfigurations());
  });
});
