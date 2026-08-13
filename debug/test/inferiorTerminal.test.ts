// The pure half of the terminal handshake: what the terminal is asked to run, and how its answer
// is read back. The end-to-end proof that this actually reaches a program's stdin lives in
// inferiorTerminal.e2e.test.ts; these are the pieces that are easier to pin down exactly.
import * as assert from 'assert';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import {
  agentCommand,
  agentEnv,
  endpointPath,
  isTerminalConsole,
  parseTtyPath,
  runInTerminalKind,
  TERMINAL_AGENT_FLAG,
  TerminalHandshake,
} from '../src/inferiorTerminal';

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

  it('gives every session its own endpoint, outside the workspace', () => {
    const first = endpointPath();
    assert.strictEqual(path.dirname(first), os.tmpdir());
    // Two sessions of the same adapter process must not collide on one endpoint.
    assert.notStrictEqual(first, endpointPath());
  });

  describe('agentCommand', () => {
    it('starts this adapter as the agent, with the endpoint to report to', () => {
      assert.deepStrictEqual(agentCommand('/opt/ext/dist/adapter.js', '/tmp/endpoint.sock', '/usr/bin/node'), [
        '/usr/bin/node',
        '/opt/ext/dist/adapter.js',
        TERMINAL_AGENT_FLAG,
        '/tmp/endpoint.sock',
      ]);
    });

    it('has nothing in it for a shell to mangle', () => {
      // The point of the agent. A client that honors runInTerminal by *typing this into a shell*
      // (which is what VS Code does) has to escape it first, per shell — and the shell script this
      // replaced arrived at fish as a wall of backslashes, and at a shell still busy starting up as
      // nothing at all. Only characters that appear in ordinary paths are allowed here.
      for (const arg of agentCommand('/opt/ext/dist/adapter.js', endpointPath(), process.execPath)) {
        assert.match(arg, /^[A-Za-z0-9_@%+=:,./-]+$/, `${arg} needs shell quoting, which is the failure mode this design exists to avoid`);
      }
    });

    it('carries the one variable an Electron binary needs to behave as node', () => {
      const previous = process.env.ELECTRON_RUN_AS_NODE;
      try {
        delete process.env.ELECTRON_RUN_AS_NODE;
        assert.deepStrictEqual(agentEnv(), {});
        process.env.ELECTRON_RUN_AS_NODE = '1';
        assert.deepStrictEqual(agentEnv(), { ELECTRON_RUN_AS_NODE: '1' });
      } finally {
        if (previous === undefined) delete process.env.ELECTRON_RUN_AS_NODE;
        else process.env.ELECTRON_RUN_AS_NODE = previous;
      }
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

  describe('TerminalHandshake', () => {
    const open: TerminalHandshake[] = [];
    const clients: net.Socket[] = [];

    function handshake(): TerminalHandshake {
      const shake = new TerminalHandshake(endpointPath());
      open.push(shake);
      return shake;
    }

    afterEach(() => {
      for (const shake of open.splice(0)) shake.release();
      for (const client of clients.splice(0)) client.destroy();
    });

    it('learns the tty from whatever connects to it', async function () {
      if (os.platform() === 'win32') {
        this.skip();
        return;
      }
      const shake = handshake();
      await shake.listen();

      const client = net.connect(shake.endpoint);
      clients.push(client);
      await new Promise((resolve) => client.once('connect', resolve));
      client.write('/dev/pts/9\n');

      assert.strictEqual(await shake.waitForTty(5000), '/dev/pts/9');
    });

    it('reports no tty when the terminal says it has none, rather than handing gdb a non-path', async function () {
      if (os.platform() === 'win32') {
        this.skip();
        return;
      }
      const shake = handshake();
      await shake.listen();

      const client = net.connect(shake.endpoint);
      clients.push(client);
      await new Promise((resolve) => client.once('connect', resolve));
      client.write('not a tty\n');

      assert.strictEqual(await shake.waitForTty(5000), undefined);
    });

    it('gives up waiting rather than hanging the launch when nothing ever connects', async function () {
      if (os.platform() === 'win32') {
        this.skip();
        return;
      }
      this.timeout(5000);
      const shake = handshake();
      await shake.listen();

      const started = Date.now();
      assert.strictEqual(await shake.waitForTty(200), undefined);
      assert.ok(Date.now() - started < 2000, 'waitForTty did not respect its own timeout');
    });

    it('drops the connection on release, which is how the agent knows the session is over', async function () {
      if (os.platform() === 'win32') {
        this.skip();
        return;
      }
      this.timeout(5000);
      const shake = handshake();
      await shake.listen();

      const client = net.connect(shake.endpoint);
      clients.push(client);
      await new Promise((resolve) => client.once('connect', resolve));
      const closed = new Promise((resolve) => client.once('close', resolve));

      shake.release();
      await closed;
    });

    it('stops a launch that is still waiting when the terminal is closed under it', async function () {
      if (os.platform() === 'win32') {
        this.skip();
        return;
      }
      this.timeout(5000);
      const shake = handshake();
      await shake.listen();

      const client = net.connect(shake.endpoint);
      clients.push(client);
      await new Promise((resolve) => client.once('connect', resolve));

      const waiting = shake.waitForTty(30_000);
      client.destroy();
      // Resolves on the connection dropping, not on the 30s timeout — a closed terminal is an
      // answer, and the launch should fall back to the Debug Console immediately.
      assert.strictEqual(await waiting, undefined);
    });
  });
});
