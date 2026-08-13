// The status bar menu's ordering, which is the whole reason it is a pure function: the first entry
// is what a click lands on, so "what is currently broken comes first" is a behaviour worth pinning
// down rather than re-deriving from the rendered list.
import * as assert from 'assert';
import { menuItems, TOGGLE_DIAGNOSTICS_ACTION } from '../../src/statusBarMenuItems';

const HEALTHY = {
  dialect: 'fasm2' as const,
  compilerPath: '/usr/bin/fasm2',
  diagnosticsEnabled: true,
  diagnosticsIssue: undefined,
  indexingIssue: undefined,
};

describe('status bar menu', () => {
  it('leads with the dialect when nothing is wrong', () => {
    assert.strictEqual(menuItems(HEALTHY)[0].action, 'fasm2Studio.selectDialect');
  });

  it('leads with the compiler when there is none, since nothing else can work without it', () => {
    const items = menuItems({ ...HEALTHY, compilerPath: undefined });
    assert.strictEqual(items[0].action, 'fasm2Studio.selectCompiler');
    assert.match(items[0].label, /Find a compiler/);
  });

  it('leads with live error checking when the server reported it is not running', () => {
    const items = menuItems({ ...HEALTHY, diagnosticsIssue: 'compile timed out' });
    assert.strictEqual(items[0].action, TOGGLE_DIAGNOSTICS_ACTION);
    assert.match(items[0].description!, /compile timed out/);
  });

  it('offers the toggle in the direction that changes something', () => {
    assert.match(menuItems(HEALTHY).find((i) => i.action === TOGGLE_DIAGNOSTICS_ACTION)!.label, /Turn off/);
    assert.match(
      menuItems({ ...HEALTHY, diagnosticsEnabled: false }).find((i) => i.action === TOGGLE_DIAGNOSTICS_ACTION)!.label,
      /Turn on/,
    );
  });

  it('leads with the restart when the workspace index did not finish, since that is what rebuilds it', () => {
    const items = menuItems({ ...HEALTHY, indexingIssue: 'the scan was interrupted' });
    assert.strictEqual(items[0].action, 'fasm2Studio.restartLanguageServer');
    assert.match(items[0].description!, /the scan was interrupted/);
  });

  it('offers the restart exactly once when it has been promoted to the front', () => {
    const actions = menuItems({ ...HEALTHY, indexingIssue: 'interrupted' }).map((i) => i.action);
    assert.strictEqual(actions.filter((a) => a === 'fasm2Studio.restartLanguageServer').length, 1);
  });

  it('ranks a broken compiler above a stale index, since nothing builds without one', () => {
    const items = menuItems({ ...HEALTHY, compilerPath: undefined, indexingIssue: 'interrupted' });
    assert.strictEqual(items[0].action, 'fasm2Studio.selectCompiler');
  });

  it('always offers every entry, whatever the state', () => {
    for (const state of [
      HEALTHY,
      { ...HEALTHY, compilerPath: undefined },
      { ...HEALTHY, diagnosticsIssue: 'no compiler' },
      { ...HEALTHY, indexingIssue: 'interrupted' },
    ]) {
      const actions = menuItems(state).map((i) => i.action);
      assert.deepStrictEqual([...actions].sort(), [
        TOGGLE_DIAGNOSTICS_ACTION,
        'fasm2Studio.restartLanguageServer',
        'fasm2Studio.selectCompiler',
        'fasm2Studio.selectDialect',
        'fasm2Studio.showOutput',
        'fasm2Studio.reportIssue',
      ].sort());
    }
  });
});
