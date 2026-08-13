import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CompletionItemKind } from 'vscode-languageserver/node';
import { getIncludePathCompletions, includePathContext, stringContext } from '../src/features/includePathCompletion';

describe('stringContext', () => {
  it('reports the text typed inside an unterminated literal', () => {
    assert.deepStrictEqual(stringContext("include 'lib/he"), { quote: "'", typed: 'lib/he' });
  });

  it('is undefined once the literal has closed', () => {
    assert.strictEqual(stringContext("include 'lib.inc'"), undefined);
  });

  it('is undefined outside a literal entirely', () => {
    assert.strictEqual(stringContext('\tmov eax, '), undefined);
  });

  it('treats a doubled quote as an escape rather than a terminator', () => {
    assert.deepStrictEqual(stringContext("db 'it''"), { quote: "'", typed: "it''" });
  });

  it('does not see an apostrophe inside a double-quoted string as an opener', () => {
    assert.strictEqual(stringContext('db "it\'s here"'), undefined);
  });
});

describe('includePathContext', () => {
  it('recognizes a path being typed after include', () => {
    assert.deepStrictEqual(includePathContext("include 'sub/"), { quote: "'", typed: 'sub/', directive: 'include' });
  });

  it('recognizes the binary-embedding file directive too', () => {
    assert.strictEqual(includePathContext("\tfile 'data")?.directive, 'file');
  });

  it('looks through a leading label', () => {
    assert.strictEqual(includePathContext("blob: file 'data")?.directive, 'file');
  });

  it('ignores a quoted argument that is not a path', () => {
    assert.strictEqual(includePathContext("format binary as 'com"), undefined);
    assert.strictEqual(includePathContext("\tdb 'hello"), undefined);
  });
});

describe('getIncludePathCompletions', () => {
  let root: string;
  let sourceFile: string;
  let extraDir: string;

  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'fasm2-include-'));
    sourceFile = path.join(root, 'main.asm');
    fs.writeFileSync(sourceFile, '');
    fs.writeFileSync(path.join(root, 'helpers.inc'), '');
    fs.writeFileSync(path.join(root, 'notes.txt'), '');
    fs.writeFileSync(path.join(root, '.hidden.inc'), '');
    fs.mkdirSync(path.join(root, 'lib'));
    fs.writeFileSync(path.join(root, 'lib', 'strings.inc'), '');

    extraDir = path.join(root, 'sdk');
    fs.mkdirSync(extraDir);
    fs.writeFileSync(path.join(extraDir, 'win64a.inc'), '');
    // Same name in both bases: the including file's own directory must win, and the entry must be
    // offered once rather than twice.
    fs.writeFileSync(path.join(extraDir, 'helpers.inc'), '');
  });

  after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const ctx = (typed: string) => ({ quote: "'", typed, directive: 'include' });
  const at = (character: number) => ({ line: 0, character });

  it('offers files and directories next to the including file', () => {
    const items = getIncludePathCompletions(ctx(''), at(9), sourceFile, []);
    const labels = items.map((i) => i.label);
    assert.ok(labels.includes('helpers.inc'));
    assert.ok(labels.includes('lib/'));
  });

  it('ranks directories first, then source files, then everything else', () => {
    const items = getIncludePathCompletions(ctx(''), at(9), sourceFile, []);
    const sorted = [...items].sort((a, b) => (a.sortText ?? '').localeCompare(b.sortText ?? ''));
    const labels = sorted.map((i) => i.label);
    assert.ok(labels.indexOf('lib/') < labels.indexOf('helpers.inc'), 'directory before source file');
    assert.ok(labels.indexOf('helpers.inc') < labels.indexOf('notes.txt'), 'source file before other file');
  });

  it('skips dotfiles', () => {
    const items = getIncludePathCompletions(ctx(''), at(9), sourceFile, []);
    assert.ok(!items.some((i) => i.label === '.hidden.inc'));
  });

  it('descends into a subdirectory that has already been typed', () => {
    const items = getIncludePathCompletions(ctx('lib/'), at(13), sourceFile, []);
    assert.deepStrictEqual(items.map((i) => i.label), ['strings.inc']);
  });

  it('accepts a backslash as a separator, as fasmg does on any host', () => {
    const items = getIncludePathCompletions(ctx('lib\\'), at(13), sourceFile, []);
    assert.deepStrictEqual(items.map((i) => i.label), ['strings.inc']);
  });

  it('replaces only the partial name, leaving the directory part alone', () => {
    const items = getIncludePathCompletions(ctx('lib/str'), at(16), sourceFile, []);
    const edit = items[0].textEdit;
    assert.ok(edit && 'range' in edit);
    // Covers "str" only — character 13 to the cursor at 16, leaving the "lib/" before it intact.
    assert.deepStrictEqual(edit.range, { start: { line: 0, character: 13 }, end: { line: 0, character: 16 } });
    assert.strictEqual(edit.newText, 'strings.inc');
  });

  it('searches fasm2Studio.includePath directories as well', () => {
    const items = getIncludePathCompletions(ctx(''), at(9), sourceFile, [extraDir]);
    const win64 = items.find((i) => i.label === 'win64a.inc');
    assert.ok(win64, 'offers a file only reachable through the include path');
    assert.strictEqual(win64.detail, `from ${extraDir}`);
  });

  it('offers a name found in two bases once, for the base that wins', () => {
    const items = getIncludePathCompletions(ctx(''), at(9), sourceFile, [extraDir]);
    const helpers = items.filter((i) => i.label === 'helpers.inc');
    assert.strictEqual(helpers.length, 1);
    assert.strictEqual(helpers[0].detail, undefined, 'the local one, not the include-path copy');
  });

  it('re-triggers suggestions after a directory, so the path can be completed in one go', () => {
    const items = getIncludePathCompletions(ctx(''), at(9), sourceFile, []);
    const dir = items.find((i) => i.label === 'lib/');
    assert.strictEqual(dir?.kind, CompletionItemKind.Folder);
    assert.strictEqual(dir?.command?.command, 'editor.action.triggerSuggest');
  });

  it('falls back to the include path for a buffer with no directory of its own', () => {
    const items = getIncludePathCompletions(ctx(''), at(9), undefined, [extraDir]);
    assert.ok(items.some((i) => i.label === 'win64a.inc'));
  });

  it('returns nothing when there is nowhere to look', () => {
    assert.deepStrictEqual(getIncludePathCompletions(ctx(''), at(9), undefined, []), []);
  });
});
