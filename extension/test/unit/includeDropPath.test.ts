// The `include` line a dropped file turns into. What can go wrong here is a path that reads
// plausibly and does not open — which nothing reports until the assembler is run, and which is the
// whole thing the gesture exists to prevent.
import * as assert from 'assert';
import * as path from 'path';
import { includeDirectiveFor, includeDirectivesFor, includePathFor, isIncludable } from '../../src/includeDropPath';

/** Builds an absolute path in the host's own separator, so these read the same on both platforms. */
const p = (...segments: string[]) => path.resolve(path.sep, ...segments);

describe('include paths for a dropped file', () => {
  describe('which files get one at all', () => {
    it('accepts every extension this extension claims as fasm source', () => {
      for (const ext of ['.inc', '.asm', '.fasm', '.fas', '.alm']) {
        assert.ok(isIncludable(`macros${ext}`), `${ext} is not includable`);
      }
    });

    it('ignores case, since a file named .INC is the same file', () => {
      assert.ok(isIncludable('MACROS.INC'));
    });

    // An `include` names source the assembler parses. Left alone, VS Code's own default inserts the
    // path as text, which is a better answer for these than a line that will not assemble.
    it('leaves anything else to VS Code', () => {
      for (const name of ['logo.png', 'notes.txt', 'data.bin', 'Makefile']) {
        assert.ok(!isIncludable(name), `${name} should not produce an include`);
      }
      assert.strictEqual(
        includeDirectiveFor({ fromFsPath: p('proj', 'main.asm'), droppedFsPath: p('proj', 'logo.png') }),
        undefined,
      );
    });
  });

  describe('spelling the path', () => {
    it('writes a sibling as a bare file name', () => {
      assert.strictEqual(includePathFor({ fromFsPath: p('proj', 'main.asm'), droppedFsPath: p('proj', 'macros.inc') }), 'macros.inc');
    });

    it('writes a file in a subdirectory relative to the including file', () => {
      const result = includePathFor({ fromFsPath: p('proj', 'main.asm'), droppedFsPath: p('proj', 'lib', 'macros.inc') });
      assert.strictEqual(result, path.join('lib', 'macros.inc'));
    });

    // The including file's own directory is where fasmg looks first, so this is the spelling that
    // resolves — not one relative to the workspace root, which is what a naive drop would insert.
    it('is relative to the file being edited, not to the project root', () => {
      const result = includePathFor({ fromFsPath: p('proj', 'src', 'boot', 'main.asm'), droppedFsPath: p('proj', 'src', 'macros.inc') });
      assert.strictEqual(result, path.join('..', 'macros.inc'));
    });

    it('refuses to include a file into itself', () => {
      const self = p('proj', 'main.asm');
      assert.strictEqual(includePathFor({ fromFsPath: self, droppedFsPath: self }), undefined);
      assert.strictEqual(includeDirectiveFor({ fromFsPath: self, droppedFsPath: self }), undefined);
    });
  });

  describe('when a configured include directory can spell it better', () => {
    const fromFsPath = p('work', 'proj', 'src', 'main.asm');
    const dropped = p('work', 'vendor', 'fasm', 'include', 'win64a.inc');

    // A relative path that climbs out of the project encodes the layout of the machine it was
    // written on. The search directory is the spelling that keeps working when the two trees sit
    // differently elsewhere — and it is the one the assembler is already configured to resolve.
    it('prefers the search directory over a path that climbs out of the tree', () => {
      const result = includePathFor({ fromFsPath, droppedFsPath: dropped, searchDirs: [p('work', 'vendor', 'fasm', 'include')] });
      assert.strictEqual(result, 'win64a.inc');
    });

    it('picks the deepest matching directory, which spells the shortest path', () => {
      const result = includePathFor({
        fromFsPath,
        droppedFsPath: dropped,
        searchDirs: [p('work', 'vendor'), p('work', 'vendor', 'fasm', 'include')],
      });
      assert.strictEqual(result, 'win64a.inc');
    });

    // Only when the relative path would escape: inside the project, a relative path is what keeps
    // the reference correct after the project moves, and it is what fasmg resolves first anyway.
    it('still prefers a relative path for a file inside the project', () => {
      const result = includePathFor({
        fromFsPath,
        droppedFsPath: p('work', 'proj', 'src', 'lib', 'macros.inc'),
        searchDirs: [p('work', 'proj', 'src')],
      });
      assert.strictEqual(result, path.join('lib', 'macros.inc'));
    });

    it('falls back to climbing out when no search directory contains the file', () => {
      const result = includePathFor({ fromFsPath, droppedFsPath: dropped, searchDirs: [p('somewhere', 'else')] });
      assert.strictEqual(result, path.join('..', '..', 'vendor', 'fasm', 'include', 'win64a.inc'));
    });

    it('is not confused by a directory that merely shares a name prefix', () => {
      const result = includePathFor({ fromFsPath, droppedFsPath: dropped, searchDirs: [p('work', 'vendor', 'fasm', 'inc')] });
      assert.strictEqual(result, path.join('..', '..', 'vendor', 'fasm', 'include', 'win64a.inc'));
    });
  });

  describe('the line it writes', () => {
    it('writes a whole include statement, not a bare path', () => {
      assert.strictEqual(
        includeDirectiveFor({ fromFsPath: p('proj', 'main.asm'), droppedFsPath: p('proj', 'macros.inc') }),
        "include 'macros.inc'",
      );
    });

    // A backslash written into a source file makes it non-portable, and fasm accepts forward
    // slashes on Windows — so there is nothing to be gained by emitting the host's separator.
    it('always uses forward slashes, whatever the host separator is', () => {
      const line = includeDirectiveFor({ fromFsPath: p('proj', 'main.asm'), droppedFsPath: p('proj', 'lib', 'deep', 'macros.inc') })!;
      assert.strictEqual(line, "include 'lib/deep/macros.inc'");
      assert.ok(!line.includes('\\'), `a backslash survived into ${line}`);
    });

    // Doubling is how both fasm1 and fasmg escape a quote inside a string. Left raw, the literal
    // would end early and the rest of the path would be parsed as code.
    it('doubles a quote in a file name rather than ending the string on it', () => {
      const line = includeDirectiveFor({ fromFsPath: p('proj', 'main.asm'), droppedFsPath: p('proj', "it's.inc") })!;
      assert.strictEqual(line, "include 'it''s.inc'");
    });

    it('writes one include per dropped file, in the order dropped', () => {
      const text = includeDirectivesFor(p('proj', 'main.asm'), [p('proj', 'a.inc'), p('proj', 'b.inc')]);
      assert.strictEqual(text, "include 'a.inc'\ninclude 'b.inc'");
    });

    // Dragging a folder's worth of files across is normal, and one unusable entry among them is no
    // reason to insert nothing at all.
    it('skips what it cannot include and keeps the rest', () => {
      const text = includeDirectivesFor(p('proj', 'main.asm'), [p('proj', 'logo.png'), p('proj', 'a.inc'), p('proj', 'main.asm')]);
      assert.strictEqual(text, "include 'a.inc'");
    });

    it('gives back nothing when none of the dropped files can be included', () => {
      assert.strictEqual(includeDirectivesFor(p('proj', 'main.asm'), [p('proj', 'logo.png')]), undefined);
      assert.strictEqual(includeDirectivesFor(p('proj', 'main.asm'), []), undefined);
    });
  });
});
