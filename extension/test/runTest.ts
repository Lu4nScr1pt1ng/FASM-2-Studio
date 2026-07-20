// This file is compiled (via tsconfig.test.json) to extension/out-test/test/runTest.js, so all
// relative paths below are resolved from that compiled location, not from the source tree.
import * as path from 'path';
import { runTests } from '@vscode/test-electron';

async function main(): Promise<void> {
  const extensionDevelopmentPath = path.resolve(__dirname, '..', '..');
  const extensionTestsPath = path.resolve(__dirname, 'suite', 'index');
  const fixtureWorkspace = path.resolve(__dirname, '..', '..', 'test', 'fixtures');

  try {
    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: [fixtureWorkspace, '--disable-extensions'],
    });
  } catch (err) {
    console.error('FASM2 Studio integration tests failed to run:', err);
    process.exit(1);
  }
}

void main();
