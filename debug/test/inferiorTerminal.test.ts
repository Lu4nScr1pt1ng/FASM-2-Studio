// The pure half of the terminal handshake: what the holder command says, and how its answer is
// read back. The end-to-end proof that this actually reaches a program's stdin lives in
// inferiorTerminal.e2e.test.ts; these are the pieces that are easier to pin down exactly.
import * as assert from 'assert';
import { spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { handshakeFilePath, holderCommand, isTerminalConsole, parseTtyPath, releaseTerminal, runInTerminalKind, waitForTty } from '../src/inferiorTerminal';

describe('inferior terminal handshake', () => {
  it('only treats the terminal consoles as terminals', () => {
    assert.strictEqual(isTerminalConsole('integratedTerminal'), true);
    assert.strictEqual(isTerminalConsole('externalTerminal'), true);
    assert.strictEqual(isTerminalConsole('debugConsole'), false);
    assert.strictEqual(isTerminalConsole(undefined), false);
  });

  it('maps each console onto the runInTerminal kind DAP defines', () => {
    assert.strictEqual(runInTerminalKind('integratedTerminal'), 'integrated');
    assert.strictEqual(runInTerminalKind('externalTerminal'), 'external');
  });

  it('gives every session its own handshake file, outside the workspace', () => {
    const first = handshakeFilePath();
    assert.strictEqual(path.dirname(first), os.tmpdir());
    // Two sessions of the same adapter process must not collide on one file.
    assert.notStrictEqual(first, handshakeFilePath());
  });

  describe('holderCommand', () => {
    it('is a plain /bin/sh command vector, which is all the client is asked to run', () => {
      const [shell, flag] = holderCommand('/tmp/handshake');
      assert.strictEqual(shell, '/bin/sh');
      assert.strictEqual(flag, '-c');
    });

    it('survives a path with a quote in it rather than breaking out of the script', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fasm2-quote'test-"));
      try {
        const file = path.join(dir, 'handshake');
        const [, , script] = holderCommand(file);
        // Only the redirect is run, not the wait loop that follows it. `tty` exits non-zero when
        // stdin is not a terminal (it is a pipe here), which says nothing about the quoting — where
        // the redirect landed is the whole question.
        spawnSync('/bin/sh', ['-c', script.split(';')[0]], { stdio: 'ignore', timeout: 5000 });
        assert.ok(fs.existsSync(file), 'the tty redirect did not land on the intended path');
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('exits on its own once the handshake file is removed', async function () {
      if (os.platform() === 'win32') {
        this.skip();
        return;
      }
      this.timeout(10000);
      const file = handshakeFilePath();
      const [shell, flag, script] = holderCommand(file);
      const holder = spawn(shell, [flag, script], { stdio: 'ignore' });
      const exited = new Promise<number | null>((resolve) => holder.on('exit', (code) => resolve(code)));

      // Without a tty attached, `tty` writes "not a tty" — the file still exists, which is what the
      // wait loop keys off, so this is a fair test of the release path.
      await new Promise((resolve) => setTimeout(resolve, 300));
      releaseTerminal(file);
      const code = await Promise.race([exited, new Promise((resolve) => setTimeout(() => resolve('timeout'), 5000))]);
      assert.notStrictEqual(code, 'timeout', 'the holder kept the terminal open after the session ended');
    });
  });

  describe('parseTtyPath', () => {
    it('accepts the device path a terminal reports', () => {
      assert.strictEqual(parseTtyPath('/dev/pts/7\n'), '/dev/pts/7');
    });

    it('rejects "not a tty", which is what a client without a real terminal produces', () => {
      assert.strictEqual(parseTtyPath('not a tty\n'), undefined);
      assert.strictEqual(parseTtyPath(''), undefined);
    });
  });

  it('gives up waiting rather than hanging the launch when no tty is ever reported', async function () {
    this.timeout(5000);
    const started = Date.now();
    const tty = await waitForTty(path.join(os.tmpdir(), 'fasm2-studio-nonexistent-handshake'), 200, 20);
    assert.strictEqual(tty, undefined);
    assert.ok(Date.now() - started < 2000, 'waitForTty did not respect its own timeout');
  });
});
