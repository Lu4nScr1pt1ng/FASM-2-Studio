// The prompt offered when the server has proved the configured dialect is the wrong one. Runs in
// the VS Code host because the module it covers reaches the configuration API.
//
// Only the decisions made on this side are covered -- which settings scope to write and how the
// claim is worded. Whether to prompt at all is decided in the server, from one assembler rejecting
// the file and the other accepting it, and is exercised there against the real binaries.
import * as assert from 'assert';
import * as vscode from 'vscode';
import { configurationTargetFor, suggestionMessage } from '../../src/dialectSuggestion';

describe('dialect suggestion', () => {
  it('writes to the workspace, since the dialect belongs to the project', () => {
    // Writing globally would carry one project's dialect into every other project opened later --
    // the exact failure this feature exists to prevent, just in the other direction.
    assert.strictEqual(configurationTargetFor(true), vscode.ConfigurationTarget.Workspace);
  });

  it('falls back to global for a loose file, which has no workspace scope to write to', () => {
    assert.strictEqual(configurationTargetFor(false), vscode.ConfigurationTarget.Global);
  });

  it('names the file and both dialects, so the claim can be judged rather than trusted', () => {
    const message = suggestionMessage('fasm1', 'listplay.asm');
    assert.match(message, /listplay\.asm/);
    assert.match(message, /does not assemble as fasm2/);
    assert.match(message, /but does as fasm1/);
  });

  it('reads correctly in the opposite direction too', () => {
    const message = suggestionMessage('fasm2', 'demo.asm');
    assert.match(message, /does not assemble as fasm1/);
    assert.match(message, /but does as fasm2/);
  });
});
