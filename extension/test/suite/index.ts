import * as fs from 'fs';
import * as path from 'path';
import Mocha from 'mocha';

export async function run(): Promise<void> {
  const mocha = new Mocha({ ui: 'bdd', color: true, timeout: 30000 });
  const testsRoot = __dirname;

  for (const entry of fs.readdirSync(testsRoot, { recursive: true } as { recursive: true }) as string[]) {
    if (entry.endsWith('.test.js')) {
      mocha.addFile(path.resolve(testsRoot, entry));
    }
  }

  return new Promise((resolve, reject) => {
    try {
      mocha.run((failures) => {
        if (failures > 0) reject(new Error(`${failures} test(s) failed.`));
        else resolve();
      });
    } catch (err) {
      reject(err);
    }
  });
}
