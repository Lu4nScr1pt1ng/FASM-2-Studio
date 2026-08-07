// Semantic highlighting is opt-in per theme. A theme that omits "semanticHighlighting" makes VS
// Code discard the language server's tokens outright, so the ISA-aware colouring the server works
// to compute would simply never appear in this extension's own themes — a silent, invisible
// failure with nothing in the logs. These tests keep that from regressing unnoticed.
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

const PACKAGE_JSON = path.join(__dirname, '..', '..', 'package.json');

/** The token types the server's legend declares (server/src/features/semanticTokens.ts). Every one
 * of these needs a colour, otherwise a token falls back to the editor's default foreground and
 * reads as uncoloured. */
const SERVER_TOKEN_SELECTORS = ['keyword.defaultLibrary', 'variable.defaultLibrary', 'macro'];

interface Theme {
  semanticHighlighting?: boolean;
  semanticTokenColors?: Record<string, { foreground?: string }>;
  tokenColors?: unknown[];
}

function themeFiles(): string[] {
  const contributed = JSON.parse(fs.readFileSync(PACKAGE_JSON, 'utf8')) as {
    contributes: { themes: Array<{ path: string }> };
  };
  return contributed.contributes.themes.map((t) => path.join(__dirname, '..', '..', t.path));
}

describe('bundled colour themes', () => {
  it('contributes at least one theme, and every contributed file exists', () => {
    const files = themeFiles();
    assert.ok(files.length > 0);
    for (const f of files) assert.ok(fs.existsSync(f), `contributed theme missing on disk: ${f}`);
  });

  for (const file of themeFiles()) {
    const name = path.basename(file);

    describe(name, () => {
      const theme = JSON.parse(fs.readFileSync(file, 'utf8')) as Theme;

      it('opts into semantic highlighting, so the server\'s ISA-aware tokens are not discarded', () => {
        assert.strictEqual(theme.semanticHighlighting, true);
      });

      it('gives every semantic token type the server emits its own colour', () => {
        const colors = theme.semanticTokenColors ?? {};
        for (const selector of SERVER_TOKEN_SELECTORS) {
          assert.ok(colors[selector]?.foreground, `no colour for semantic token "${selector}"`);
        }
      });

      it('still carries its TextMate colours, which remain the fallback for everything not classified semantically', () => {
        assert.ok(Array.isArray(theme.tokenColors) && theme.tokenColors.length > 0);
      });
    });
  }
});
