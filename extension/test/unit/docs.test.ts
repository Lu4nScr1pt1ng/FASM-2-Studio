// Prevents extension/README.md's settings table -- the one place meant to exhaustively list every
// setting -- from silently drifting behind package.json. Found a real, confirmed gap this way:
// "fasm2Studio.includePath" was a real, working setting missing from it entirely. The root
// README.md is deliberately narrative rather than an exhaustive reference, so it isn't held to the
// same per-setting bar here.
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import packageJson from '../../package.json';

const EXTENSION_README_PATH = path.join(__dirname, '..', '..', 'README.md');

describe('documentation stays in sync with package.json', () => {
  it('lists every fasm2Studio.* setting in extension/README.md\'s settings table', () => {
    const settingNames = Object.keys(packageJson.contributes.configuration.properties);
    assert.ok(settingNames.length > 0, 'expected at least one configuration property');

    const extensionReadme = fs.readFileSync(EXTENSION_README_PATH, 'utf8');
    const missing = settingNames.filter((name) => !extensionReadme.includes(name));

    assert.strictEqual(missing.length, 0, `settings missing from extension/README.md: ${missing.join(', ')}`);
  });
});
