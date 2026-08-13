// The debugger menu's ordering and its install guidance. Both are the whole point of the module:
// the first entry is what a click lands on, and the guidance is the one thing a raw "spawn gdb
// ENOENT" could never tell anybody.
import * as assert from 'assert';
import {
  debuggerChoices,
  debuggerInstallHint,
  defaultDebuggerCommand,
  selectDebuggerPlaceholder,
} from '../../src/debuggerChoices';

describe('defaultDebuggerCommand', () => {
  it('is gdb on Linux and Windows', () => {
    assert.strictEqual(defaultDebuggerCommand('linux'), 'gdb');
    assert.strictEqual(defaultDebuggerCommand('win32'), 'gdb');
  });

  it('is lldb-mi on macOS, which ships no gdb at all', () => {
    assert.strictEqual(defaultDebuggerCommand('darwin'), 'lldb-mi');
  });
});

describe('debuggerInstallHint', () => {
  it('names a package manager on Linux', () => {
    assert.match(debuggerInstallHint('linux'), /apt install gdb|dnf install gdb|pacman -S gdb/);
  });

  it('names MSYS2 or w64devkit on Windows, since gdb is not part of a normal install', () => {
    assert.match(debuggerInstallHint('win32'), /MSYS2|w64devkit/);
  });

  it('says on macOS that Apple’s own lldb is not the one, which is the whole trap there', () => {
    const hint = debuggerInstallHint('darwin');
    assert.match(hint, /lldb-mi/);
    assert.match(hint, /MI/, 'must explain that the bundled lldb does not speak MI');
  });
});

describe('debuggerChoices', () => {
  it('leads with how to get one when none was found — there is nothing to browse to yet', () => {
    const [first] = debuggerChoices('gdb', false);
    assert.strictEqual(first.action.kind, 'install');
  });

  it('leads with pointing at one when a debugger is already working', () => {
    const [first] = debuggerChoices('/usr/bin/gdb', true);
    assert.strictEqual(first.action.kind, 'browse');
  });

  it('shows the resolved command when found, and says so plainly when not', () => {
    assert.strictEqual(debuggerChoices('/usr/bin/gdb', true)[0].description, '/usr/bin/gdb');
    const browse = debuggerChoices('gdb', false).find((c) => c.action.kind === 'browse')!;
    assert.strictEqual(browse.description, 'not found');
  });

  it('always offers all three, in either state', () => {
    for (const found of [true, false]) {
      const kinds = debuggerChoices('gdb', found).map((c) => c.action.kind).sort();
      assert.deepStrictEqual(kinds, ['browse', 'install', 'rescan']);
    }
  });

  it('names the setting a browse actually writes, so the choice is not a mystery', () => {
    const browse = debuggerChoices('gdb', false).find((c) => c.action.kind === 'browse')!;
    assert.match(browse.detail, /fasm2Studio\.gdbPath/);
  });
});

describe('selectDebuggerPlaceholder', () => {
  it('admits nothing was found, rather than asking a question that cannot be answered', () => {
    assert.match(selectDebuggerPlaceholder('gdb', false), /No debugger found/);
  });

  it('names what is in use when one is working', () => {
    assert.strictEqual(selectDebuggerPlaceholder('/usr/bin/gdb', true), 'Currently using /usr/bin/gdb');
  });
});
