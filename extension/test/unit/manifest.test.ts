// Checks on the extension manifest that only show up in the UI, where nothing else would catch
// them: VS Code composes several of these fields with each other before displaying the result, so a
// field that looks right on its own can still render wrongly.
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

const PACKAGE_JSON = path.join(__dirname, '..', '..', 'package.json');

interface Manifest {
  contributes: {
    commands: Array<{ command: string; title: string; category?: string }>;
    debuggers: Array<{ type: string; label: string; configurationSnippets?: Array<{ label: string }> }>;
    configuration: { properties: Record<string, { description?: string; type?: string }> };
    languages: Array<{ id: string; extensions: string[] }>;
    taskDefinitions: Array<{ type: string }>;
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

  it('claims the same language id the task and debugger contributions are built around', () => {
    assert.ok(manifest.contributes.languages.some((l) => l.id === 'fasm'));
    assert.ok(manifest.contributes.taskDefinitions.some((t) => t.type === 'fasm'));
    assert.ok(manifest.contributes.debuggers.some((d) => d.type === 'fasm'));
  });
});
