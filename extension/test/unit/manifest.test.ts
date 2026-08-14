// Checks on the extension manifest that only show up in the UI, where nothing else would catch
// them: VS Code composes several of these fields with each other before displaying the result, so a
// field that looks right on its own can still render wrongly.
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

const PACKAGE_JSON = path.join(__dirname, '..', '..', 'package.json');
const GRAMMAR_PATH = path.join(__dirname, '..', '..', 'syntaxes', 'fasm.tmLanguage.json');

interface Manifest {
  name: string;
  publisher: string;
  activationEvents: string[];
  categories: string[];
  extensionKind?: string[];
  capabilities: {
    untrustedWorkspaces: { supported: boolean | string; restrictedConfigurations?: string[]; description?: string };
  };
  contributes: {
    commands: Array<{ command: string; title: string; shortTitle?: string; category?: string }>;
    menus: Record<string, Array<{ command: string; when?: string; group?: string }>>;
    debuggers: Array<{
      type: string;
      label: string;
      configurationSnippets?: Array<{ label: string }>;
      configurationAttributes?: Record<string, { properties: Record<string, { description?: string; default?: unknown }> }>;
    }>;
    configuration: { properties: Record<string, { description?: string; type?: string }> };
    languages: Array<{ id: string; extensions: string[] }>;
    taskDefinitions: Array<{ type: string }>;
    semanticTokenScopes: Array<{ language: string; scopes: Record<string, string[]> }>;
    configurationDefaults: Record<string, Record<string, unknown>>;
    keybindings: Array<{ command: string; key: string; mac?: string; when?: string }>;
    views?: Record<string, Array<{ id: string; name: string; when?: string }>>;
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

  describe('"New File" discoverability', () => {
    // FASM: New File exists for someone who has no .asm file yet — and until this entry, the only
    // way to reach it was the command palette, which is not where VS Code teaches people to make
    // a file. File > New File... is, and it is populated from this menu alone.
    it('appears in File > New File..., which is where a user without a source file looks', () => {
      const entries = manifest.contributes.menus['file/newFile'] ?? [];
      assert.ok(
        entries.some((e) => e.command === 'fasm2Studio.newFile'),
        'fasm2Studio.newFile is not contributed to file/newFile',
      );
    });

    // That picker renders each entry with renderShortTitle, so a command whose title is just
    // "New File" comes out indistinguishable from the built-in "New Text File" sitting next to it.
    it('gives the entry a short title that says what kind of file it makes', () => {
      const newFile = manifest.contributes.commands.find((c) => c.command === 'fasm2Studio.newFile');
      assert.ok(newFile?.shortTitle, 'fasm2Studio.newFile has no shortTitle to render there');
      assert.notStrictEqual(newFile.shortTitle, newFile.title, 'the short title adds nothing over the plain title');
    });

    it('every menu entry names a command this extension contributes', () => {
      const contributed = new Set(manifest.contributes.commands.map((c) => c.command));
      for (const [menu, entries] of Object.entries(manifest.contributes.menus)) {
        for (const entry of entries) {
          assert.ok(contributed.has(entry.command), `${menu} references ${entry.command}, which is not contributed`);
        }
      }
    });
  });

  describe('where the extension runs', () => {
    // Diagnostics, Build, Run and Debug all spawn a compiler and gdb against files on disk, and the
    // language server indexes the real workspace — all of which exist on the remote side of a
    // Remote-SSH/WSL/Codespaces window, not the local UI side. VS Code infers a kind when none is
    // declared; stating it keeps a UI-side host from ever being chosen for an extension that has
    // nothing to run there.
    it('declares itself a workspace extension, since everything it does needs the real filesystem', () => {
      assert.deepStrictEqual(manifest.extensionKind, ['workspace']);
    });
  });

  describe('marketplace categories', () => {
    // Categories are how the marketplace is browsed, and each of these is a headline feature: a
    // language, a debugger, live compiler diagnostics, snippets, and Format Document.
    it('claims a category for every headline feature, including the formatter', () => {
      for (const category of ['Programming Languages', 'Snippets', 'Linters', 'Formatters', 'Debuggers']) {
        assert.ok(manifest.categories.includes(category), `missing category: ${category}`);
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

  describe('attach configurations', () => {
    const fasm = manifest.contributes.debuggers.find((d) => d.type === 'fasm')!;

    // A debugger that only declares "launch" gets no attach UI at all — "Add Configuration..."
    // offers nothing for it, and a hand-written attach entry is rejected before the adapter sees it.
    it('declares attach, not only launch', () => {
      assert.ok(fasm.configurationAttributes?.attach, 'no attach configurationAttributes');
    });

    it('documents both attach targets, since which one you have decides the whole session', () => {
      const properties = fasm.configurationAttributes!.attach!.properties;
      assert.ok(properties.processId, 'attach has no "processId"');
      assert.ok(properties.coreFile, 'attach has no "coreFile"');
      for (const [name, schema] of Object.entries(properties)) {
        assert.ok(schema.description && schema.description.trim().length > 0, `attach.${name} has no description`);
      }
    });

    // A pid is different on every run, so a config that makes you go and look one up is one that
    // has to be edited every time it is used.
    it('defaults processId to the picker rather than to a number that is stale immediately', () => {
      const processId = fasm.configurationAttributes!.attach!.properties.processId;
      assert.strictEqual(processId.default, '${command:fasm2Studio.pickProcess}');
      assert.ok(
        manifest.contributes.commands.some((c) => c.command === 'fasm2Studio.pickProcess'),
        'the picker the default substitutes is not a contributed command',
      );
    });

    it('offers a snippet for each attach target, so neither has to be written from the schema', () => {
      const labels = (fasm.configurationSnippets ?? []).map((s) => s.label.toLowerCase());
      assert.ok(labels.some((l) => l.includes('attach')), 'no attach snippet');
      assert.ok(labels.some((l) => l.includes('core')), 'no core dump snippet');
    });
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

    // onLanguage:fasm needs a fasm file to have been *opened*, so a window that opened on a folder
    // had none of this extension's presence in it — no status bar, and above all no "FASM Entry
    // Points" section, which is the one thing whose entire job is to tell you what a project you
    // have not opened a file in yet contains.
    it('activates on opening a folder that has fasm sources in it', () => {
      const globs = manifest.activationEvents
        .filter((e) => e.startsWith('workspaceContains:'))
        .map((e) => e.slice('workspaceContains:'.length));
      assert.ok(globs.length > 0, 'no workspaceContains event — opening a fasm project folder activates nothing');

      // Every extension the language claims that this extension is the natural owner of has to be
      // covered, or a project made only of those files still activates nothing.
      const owned = ['asm', 'fasm', 'fas', 'alm'];
      for (const extension of owned) {
        assert.ok(
          globs.some((glob) => new RegExp(`[{,.]${extension}[},]`).test(glob)),
          `no workspaceContains glob covers .${extension} (globs: ${JSON.stringify(globs)})`,
        );
      }

      // .inc is deliberately absent, and stays that way: it is a fragment extension shared with
      // several unrelated ecosystems, and a fasm fragment is only ever reached through the entry
      // point that includes it — which is one of the files above. Matching it would activate this
      // extension, and start a language server, in every project that happens to hold an include
      // file, for a folder that has no fasm program in it to find.
      assert.ok(
        !globs.some((glob) => /[{,.]inc[},]/.test(glob)),
        'a workspaceContains glob matches .inc, activating in unrelated projects that merely have include files',
      );
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

  // Several general-purpose assembly extensions also claim ".asm". With more than one formatter
  // registered for a language and no default named, Format Document stops to ask which one — every
  // time — instead of formatting.
  it('names itself the default formatter for FASM, so Format Document never opens a picker', () => {
    const defaults = manifest.contributes.configurationDefaults;
    assert.strictEqual(defaults['[fasm]']['editor.defaultFormatter'], `${manifest.publisher}.${manifest.name}`);
  });

  it('leaves word-based suggestions off for FASM, so the language server\'s completions are not diluted by arbitrary words from other open files', () => {
    assert.strictEqual(manifest.contributes.configurationDefaults['[fasm]']['editor.wordBasedSuggestions'], 'off');
  });

  describe('the entry points view', () => {
    const view = manifest.contributes.views?.explorer?.find((v) => v.id === 'fasm2Studio.entryPoints');

    it('is contributed into the Explorer, where build targets belong', () => {
      assert.ok(view, 'expected a fasm2Studio.entryPoints view in the explorer container');
    });

    // Without a `when`, the section shows up in the Explorer of every workspace this extension has
    // ever activated in, including ones with no fasm program in them at all.
    it('is gated on there actually being an entry point to list', () => {
      assert.strictEqual(view?.when, 'fasm2Studio.hasEntryPoints');
    });

    // These take a tree element, not a Uri, so invoking one from the palette — where there is no
    // element to pass — would do nothing at all.
    it('keeps its per-item commands out of the command palette', () => {
      const hidden = new Set(
        (manifest.contributes.menus.commandPalette ?? []).filter((entry) => entry.when === 'false').map((entry) => entry.command),
      );
      const itemCommands = manifest.contributes.commands
        .map((c) => c.command)
        .filter((c) => c.startsWith('fasm2Studio.entryPoints.') && c !== 'fasm2Studio.entryPoints.refresh');
      assert.ok(itemCommands.length > 0, 'expected the view to contribute per-item commands');
      for (const command of itemCommands) {
        assert.ok(hidden.has(command), `${command} is reachable from the palette, where it has no tree item to act on`);
      }
    });

    it('gives every view menu entry a command this extension contributes', () => {
      const contributed = new Set(manifest.contributes.commands.map((c) => c.command));
      for (const menu of ['view/title', 'view/item/context']) {
        for (const entry of manifest.contributes.menus[menu] ?? []) {
          assert.ok(contributed.has(entry.command), `${menu} references unknown command ${entry.command}`);
        }
      }
    });
  });

  describe('keybindings', () => {
    // A keybinding that fires while a Python file is focused would run a fasm build against it.
    it('scopes every binding to a focused FASM editor', () => {
      for (const binding of manifest.contributes.keybindings) {
        assert.ok(binding.when?.includes('resourceLangId == fasm'), `${binding.command} is not scoped to fasm files`);
        assert.ok(binding.when?.includes('editorTextFocus'), `${binding.command} fires without an editor focused`);
      }
    });

    it('binds each of the things you do to a file, so none of them needs the palette', () => {
      const bound = new Set(manifest.contributes.keybindings.map((b) => b.command));
      for (const command of ['fasm2Studio.build', 'fasm2Studio.buildAndRun', 'fasm2Studio.run', 'fasm2Studio.debug', 'fasm2Studio.clean']) {
        assert.ok(bound.has(command), `${command} has no keybinding`);
      }
    });

    // Build-and-run is the ▷ button in the editor title bar and the first entry in the editor
    // context menu — it is what "run this" means here. Plain Run re-runs the last build without
    // assembling, which is the specialist of the two and had the shorter chord until this test.
    it('gives the unshifted chord to build-and-run, not to running a possibly-stale binary', () => {
      const chordFor = (command: string) => manifest.contributes.keybindings.find((b) => b.command === command)?.key;
      const buildAndRun = chordFor('fasm2Studio.buildAndRun');
      const run = chordFor('fasm2Studio.run');
      assert.ok(buildAndRun && run, 'both run commands need a binding for this comparison');
      assert.ok(!buildAndRun.includes('shift'), `build-and-run is behind a shifted chord (${buildAndRun})`);
      assert.ok(run.includes('shift'), `plain run holds an unshifted chord (${run})`);
    });

    it('gives every binding a mac chord, since ctrl is not the modifier there', () => {
      for (const binding of manifest.contributes.keybindings) {
        assert.ok(binding.mac, `${binding.command} has no mac binding`);
      }
    });

    it('never binds two commands to the same chord', () => {
      for (const platform of ['key', 'mac'] as const) {
        const chords = manifest.contributes.keybindings.map((b) => b[platform]);
        assert.strictEqual(new Set(chords).size, chords.length, `duplicate ${platform} chord`);
      }
    });

    it('binds every command it names', () => {
      const contributed = new Set(manifest.contributes.commands.map((c) => c.command));
      for (const binding of manifest.contributes.keybindings) {
        assert.ok(contributed.has(binding.command), `${binding.command} is bound but not contributed`);
      }
    });
  });
});
