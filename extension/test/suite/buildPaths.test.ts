// A plain string-logic test, not gated on fasm2/gdb being installed — getListingPath and
// getDefaultOutputPath's Windows ".exe" behavior are both pure functions of the path they're
// given, so there's nothing here that needs a real build to exercise. Lives in test/suite/ (not
// test/unit/) only because buildPaths.ts imports vscode at module scope, which the plain-Node unit
// runner cannot resolve.
import * as assert from 'assert';
import * as os from 'os';
import * as path from 'path';
import { getDefaultOutputPath, getListingPath } from '../../src/buildPaths';

describe('getListingPath', () => {
  it('replaces the output\'s own extension rather than appending to it, matching virtual as \'lst\'', () => {
    // Confirmed against a real fasm2 build: "hello.exe" produces "hello.lst" on disk, not
    // "hello.exe.lst" — a regression getDefaultOutputPath's own ".exe" suffix introduced here,
    // since this function used to just append ".lst" and every caller's input happened to have no
    // extension of its own for that to matter.
    assert.strictEqual(getListingPath(path.join('C:', 'proj', 'hello.exe')), path.join('C:', 'proj', 'hello.lst'));
  });

  it('still appends cleanly when the output has no extension at all (Linux, and pre-.exe Windows behavior)', () => {
    assert.strictEqual(getListingPath(path.join('/', 'proj', 'hello')), path.join('/', 'proj', 'hello.lst'));
  });

  it('agrees with getDefaultOutputPath\'s own output for a real source path on this platform', function () {
    // The specific combination "FASM: Debug" actually calls: getListingPath(getDefaultOutputPath(asmFile)).
    // Windows only, since that is the one platform getDefaultOutputPath changes anything for.
    if (os.platform() !== 'win32') {
      this.skip();
      return;
    }
    const asmPath = path.join('C:', 'proj', 'hello.asm');
    assert.strictEqual(getListingPath(getDefaultOutputPath(asmPath)), path.join('C:', 'proj', 'hello.lst'));
  });
});
