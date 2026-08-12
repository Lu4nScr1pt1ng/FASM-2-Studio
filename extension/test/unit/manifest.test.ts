// Checks on the extension manifest that only show up in the UI, where nothing else would catch
// them: VS Code composes several of these fields with each other before displaying the result, so a
// field that looks right on its own can still render wrongly.
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

const PACKAGE_JSON = path.join(__dirname, '..', '..', 'package.json');
const GRAMMAR_PATH = path.join(__dirname, '..', '..', 'syntaxes', 'fasm.tmLanguage.json');

interface Manifest {
  activationEvents: string[];
  capabilities: {
    untrustedWorkspaces: { supported: boolean | string; restrictedConfigurations?: string[]; description?: string };
  };
  contributes: {
    commands: Array<{ command: string; title: string; category?: string }>;
    debuggers: Array<{ type: string; label: string; configurationSnippets?: Array<{ label: string }> }>;
    configuration: { properties: Record<string, { description?: string; type?: string }> };
    languages: Array<{ id: string; extensions: string[] }>;
    taskDefinitions: Array<{ type: string }>;
    semanticTokenScopes: Array<{ language: string; scopes: Record<string, string[]> }>;
    configurationDefaults: Record<string, Record<string, unknown>>;
  };
}

const manifest = JSON.parse(fs.readFileSync(PACKAGE_JSON, 'utf8')) as Manifest;

describe('extension manifest', () => {
  describe('command palette entries', () => {
    // The palette renders "category: title". A title that repeats its own category therefore comes
    // out as "FASM: FASM: Build", which is what shipped until this test existed.
    for (const command of manifest.contributes.commands) {
      it(`"${command.command}" does not repeat its category in its title`, () => {
        if (!command.category) return;
        assert.ok(
          !command.title.toLowerCase().startsWith(`${command.category.toLowerCase()}:`),
          `title ${JSON.stringify(command.title)} would render as "${command.category}: ${command.title}"`,
        );
      });
    }

    it('gives every command a category, so they group together in the palette', () => {
      for (const command of manifest.contributes.commands) {
        assert.ok(command.category, `${command.command} has no category`);
      }
    });

    it('gives every command a non-empty title', () => {
      for (const command of manifest.contributes.commands) {
        assert.ok(command.title.trim().length > 0, `${command.command} has an empty title`);
      }
    });
  });

  describe('debugger contributions', () => {
    // "Add Configuration..." composes the debugger's label with the snippet's label, the same way
    // the palette composes category with title.
    for (const debuggerContribution of manifest.contributes.debuggers) {
      for (const snippet of debuggerContribution.configurationSnippets ?? []) {
        it(`snippet "${snippet.label}" does not repeat the "${debuggerContribution.label}" label`, () => {
          assert.ok(
            !snippet.label.toLowerCase().startsWith(`${debuggerContribution.label.toLowerCase()}:`),
            `would render as "${debuggerContribution.label}: ${snippet.label}"`,
          );
        });
      }
    }
  });

  describe('settings', () => {
    it('describes every setting, since the description is all the settings UI shows', () => {
      for (const [name, schema] of Object.entries(manifest.contributes.configuration.properties)) {
        assert.ok(schema.description && schema.description.trim().length > 0, `${name} has no description`);
        assert.ok(schema.type, `${name} has no type`);
      }
    });

    it('namespaces every setting under fasm2Studio', () => {
      for (const name of Object.keys(manifest.contributes.configuration.properties)) {
        assert.ok(name.startsWith('fasm2Studio.'), `${name} is not namespaced`);
      }
    });
  });

  describe('activation events', () => {
    // VS Code generates implicit activation events for several contribution points, but
    // `contributes.debuggers` is not one of them — its bundle registers an activationEventsGenerator
    // for taskDefinitions (`onTaskType:`), languages, commands and others, and none for debuggers.
    // The debug service then calls activateDebuggers, which only fires "onDebug",
    // "onDebugResolve" and "onDebugResolve:<type>". Relying on onLanguage:fasm alone therefore
    // means F5 against a launch.json does nothing at all unless a .asm tab happened to be opened
    // first in that window, since the adapter factory is registered during activation.
    it('activates on a debug launch, not only on opening a fasm file', () => {
      for (const debuggerContribution of manifest.contributes.debuggers) {
        assert.ok(
          manifest.activationEvents.includes(`onDebugResolve:${debuggerContribution.type}`),
          `no onDebugResolve:${debuggerContribution.type} — F5 from launch.json would not activate the extension`,
        );
      }
    });
  });

  describe('workspace trust', () => {
    const trust = manifest.capabilities.untrustedWorkspaces;

    // Reading unfamiliar assembly is a large share of why this extension gets installed, and
    // "supported: false" turns off highlighting, hover, completion and navigation along with the
    // things that actually run a process.
    it('keeps the read-only language features available in an untrusted workspace', () => {
      assert.strictEqual(trust.supported, 'limited');
    });

    // "limited" only means the extension still loads; on its own it would leave the workspace free
    // to name the executable that gets spawned. Every setting that resolves to a program path, or
    // that feeds a path into one, has to be listed here for VS Code to ignore it while untrusted.
    it('restricts every setting that can point at something executable', () => {
      const restricted = new Set(trust.restrictedConfigurations ?? []);
      for (const name of ['fasm2CompilerPath', 'fasm1CompilerPath', 'gdbPath', 'fasm2Preload', 'includePath']) {
        assert.ok(restricted.has(`fasm2Studio.${name}`), `fasm2Studio.${name} is not restricted in an untrusted workspace`);
      }
    });

    it('only restricts settings that exist', () => {
      for (const name of trust.restrictedConfigurations ?? []) {
        assert.ok(manifest.contributes.configuration.properties[name], `${name} is restricted but is not a setting this extension contributes`);
      }
    });
  });

  it('contributes the language client\'s trace setting, so it is discoverable and not flagged as unknown', () => {
    // vscode-languageclient reads "<clientId>.trace.server" itself; the client id is the first
    // argument to the LanguageClient constructor in extension.ts. Without a declaration here the
    // setting does not appear in the settings UI and hand-adding it to settings.json is marked
    // "Unknown Configuration Setting" — leaving no way to capture a trace for a bug report.
    const trace = manifest.contributes.configuration.properties['fasm2Studio.trace.server'];
    assert.ok(trace, 'fasm2Studio.trace.server is not contributed');
    assert.deepStrictEqual((trace as { enum?: string[] }).enum, ['off', 'messages', 'verbose']);
  });

  it('claims the same language id the task and debugger contributions are built around', () => {
    assert.ok(manifest.contributes.languages.some((l) => l.id === 'fasm'));
    assert.ok(manifest.contributes.taskDefinitions.some((t) => t.type === 'fasm'));
    assert.ok(manifest.contributes.debuggers.some((d) => d.type === 'fasm'));
  });

  describe('semantic token scopes', () => {
    // This block is what stops a semantic token from rendering *less* coloured than the same word
    // would be under the grammar alone: without it, VS Code falls back to its own probe scopes,
    // which for a mnemonic is `keyword.control` — the directive colour under the default dark
    // themes, contradicting the blue the grammar gives it. Since resolution stops at the first
    // probe the theme styles, the leading entry is the one that decides the colour, so each list
    // leads with this grammar's own scope and ends with a standard one as the safety net.
    const entries = manifest.contributes.semanticTokenScopes;
    const grammar = fs.readFileSync(GRAMMAR_PATH, 'utf8');

    // The legend the server actually emits (server/src/features/semanticTokens.ts). Kept as a
    // literal rather than imported: this package builds independently of the server's sources, and
    // a selector naming something outside this list is silently ignored by VS Code.
    const TYPES = ['keyword', 'variable', 'macro', 'function', 'property', 'struct'];
    const MODIFIERS = ['defaultLibrary', 'readonly'];

    it('targets the fasm language, so it never overrides another extension\'s tokens', () => {
      assert.ok(entries.length > 0, 'expected at least one semanticTokenScopes entry');
      for (const entry of entries) {
        assert.strictEqual(entry.language, 'fasm', `entry targets ${entry.language}`);
      }
    });

    it('uses only token types and modifiers the server actually emits', () => {
      for (const entry of entries) {
        for (const selector of Object.keys(entry.scopes)) {
          const [type, ...modifiers] = selector.split('.');
          assert.ok(TYPES.includes(type), `selector "${selector}" names an unknown token type`);
          for (const modifier of modifiers) {
            assert.ok(MODIFIERS.includes(modifier), `selector "${selector}" names an unknown modifier`);
          }
        }
      }
    });

    it('only probes .fasm scopes the grammar really produces, so a rename cannot silently orphan a mapping', () => {
      for (const entry of entries) {
        for (const [selector, probes] of Object.entries(entry.scopes)) {
          for (const probe of probes.filter((s) => s.endsWith('.fasm'))) {
            assert.ok(grammar.includes(`"${probe}"`), `"${selector}" probes ${probe}, which no rule in the grammar emits`);
          }
        }
      }
    });

    it('ends every probe list with a standard scope, so a theme that knows nothing about FASM still colours the token', () => {
      for (const entry of entries) {
        for (const [selector, probes] of Object.entries(entry.scopes)) {
          assert.ok(probes.length > 0, `"${selector}" has no probe scopes`);
          assert.ok(!probes[probes.length - 1].endsWith('.fasm'), `"${selector}" ends on a FASM-only scope, leaving nothing to fall back to`);
        }
      }
    });
  });

  it('turns semantic highlighting on for FASM files only, since roughly half of published themes never opt in and would otherwise ignore the server entirely', () => {
    const defaults = manifest.contributes.configurationDefaults;
    assert.deepStrictEqual(Object.keys(defaults), ['[fasm]'], 'the default must stay scoped to this language');
    assert.strictEqual(defaults['[fasm]']['editor.semanticHighlighting.enabled'], true);
  });
});
