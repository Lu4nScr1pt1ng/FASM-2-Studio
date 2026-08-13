// The whole contract of this notice is "at most once", and it is enforced across two stores: a
// synchronous latch for the calls that arrive in the same tick, and a persisted flag for the ones
// that arrive in a later session. Both are asserted here against a Memento the test owns, so the
// result does not depend on whether the machine running the tests happens to have an assembler
// installed (which is what decides whether the real extension has already shown it).
import * as assert from 'assert';
import * as vscode from 'vscode';
import { MISSING_COMPILER_NOTICE_KEY, showMissingCompilerNoticeOnce } from '../../src/missingCompilerNotice';

/** A stand-in for context.globalState. `setKeysForSync` is part of the interface and unused here. */
function fakeMemento(initial: Record<string, unknown> = {}): vscode.Memento {
  const store = new Map<string, unknown>(Object.entries(initial));
  return {
    keys: () => [...store.keys()],
    get: <T>(key: string, fallback?: T) => (store.has(key) ? (store.get(key) as T) : (fallback as T)),
    update: async (key: string, value: unknown) => {
      store.set(key, value);
    },
  } as vscode.Memento;
}

describe('the missing-assembler notice shows at most once', () => {
  let originalShowInformationMessage: typeof vscode.window.showInformationMessage;

  beforeEach(() => {
    originalShowInformationMessage = vscode.window.showInformationMessage;
    // Returning undefined is a dismissal, which is the case that matters: it must still count.
    vscode.window.showInformationMessage = (async () => undefined) as typeof vscode.window.showInformationMessage;
  });

  afterEach(() => {
    vscode.window.showInformationMessage = originalShowInformationMessage;
  });

  it('shows the first time and records that it did', async () => {
    const state = fakeMemento();

    assert.strictEqual(await showMissingCompilerNoticeOnce(state), true);
    assert.strictEqual(state.get(MISSING_COMPILER_NOTICE_KEY), true);
  });

  it('stays quiet on every later call', async () => {
    const state = fakeMemento();

    await showMissingCompilerNoticeOnce(state);
    assert.strictEqual(await showMissingCompilerNoticeOnce(state), false);
    assert.strictEqual(await showMissingCompilerNoticeOnce(state), false);
  });

  it('stays quiet when a previous session already showed it', async () => {
    const state = fakeMemento({ [MISSING_COMPILER_NOTICE_KEY]: true });

    assert.strictEqual(await showMissingCompilerNoticeOnce(state), false);
  });

  it('shows only once for calls that overlap, before the flag has been written', async () => {
    const state = fakeMemento();

    // Two status bar renders in one tick — an editor switch and a settings change, say — both
    // reaching the "no compiler" branch before either has finished recording anything.
    const results = await Promise.all([showMissingCompilerNoticeOnce(state), showMissingCompilerNoticeOnce(state)]);

    assert.deepStrictEqual(results.filter(Boolean).length, 1);
  });
});
