// The process picker's parsing and ordering. Both are the sort of thing that fails by silently
// showing a shorter or wrongly-sorted list rather than by throwing, so neither is safe to leave to
// a glance at a running picker.
import * as assert from 'assert';
import { orderForPicker, parsePosixProcessList, parseWindowsProcessList } from '../../src/processList';

describe('parsePosixProcessList', () => {
  const PS_OUTPUT = [
    '    1 systemd          /sbin/init splash',
    ' 4321 myprog           ./myprog --input data.bin',
    '99999 code             /usr/share/code/code --unity-launch',
  ].join('\n');

  it('reads pid, name and command line out of "ps -axo pid=,comm=,args=" output', () => {
    assert.deepStrictEqual(parsePosixProcessList(PS_OUTPUT), [
      { pid: 1, name: 'systemd', commandLine: '/sbin/init splash' },
      { pid: 4321, name: 'myprog', commandLine: './myprog --input data.bin' },
      { pid: 99999, name: 'code', commandLine: '/usr/share/code/code --unity-launch' },
    ]);
  });

  // The reason the command line is taken as "the rest of the line" instead of being split on
  // whitespace: a path with a space in it is exactly what a naive split truncates.
  it('keeps a command line containing spaces whole', () => {
    const [entry] = parsePosixProcessList('  77 prog             /home/me/My Projects/prog --flag "a b"');
    assert.strictEqual(entry.commandLine, '/home/me/My Projects/prog --flag "a b"');
  });

  it('ignores a header row or any other line that does not start with a pid', () => {
    assert.deepStrictEqual(parsePosixProcessList('  PID COMMAND          ARGS\n\n   5 sh               /bin/sh'), [
      { pid: 5, name: 'sh', commandLine: '/bin/sh' },
    ]);
  });

  it('returns nothing for empty output rather than throwing', () => {
    assert.deepStrictEqual(parsePosixProcessList(''), []);
  });
});

describe('parseWindowsProcessList', () => {
  // "System Idle Process" is pid 0 and drops out: there is nothing there to attach to, and it
  // would otherwise sit in the list looking like a real choice.
  it('reads name and pid out of "tasklist /nh /fo csv" output, minus pid 0', () => {
    const output = ['"System Idle Process","0","Services","0","8 K"', '"myprog.exe","4321","Console","1","3,120 K"'].join('\n');
    assert.deepStrictEqual(parseWindowsProcessList(output), [{ pid: 4321, name: 'myprog.exe', commandLine: 'myprog.exe' }]);
  });

  it('skips rows whose pid column is not a number', () => {
    assert.deepStrictEqual(parseWindowsProcessList('"weird","not-a-pid","Console","1","8 K"'), []);
  });
});

describe('orderForPicker', () => {
  const ENTRIES = [
    { pid: 1, name: 'systemd', commandLine: '/sbin/init' },
    { pid: 5000, name: 'myprog', commandLine: './myprog' },
    { pid: 200, name: 'sshd', commandLine: '/usr/sbin/sshd' },
  ];

  // pids ascend as processes are created, so the program you just started to attach to is almost
  // always the highest — which is the entry that should not require scrolling past every system
  // daemon on the machine.
  it('puts the most recently started process first', () => {
    assert.deepStrictEqual(
      orderForPicker(ENTRIES, 999).map((e) => e.pid),
      [5000, 200, 1],
    );
  });

  it('never offers the extension host itself', () => {
    assert.ok(!orderForPicker(ENTRIES, 200).some((e) => e.pid === 200));
  });
});
