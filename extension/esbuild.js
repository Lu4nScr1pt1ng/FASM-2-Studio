// Bundles the extension host code. "vscode" stays external (provided by the host at runtime);
// everything else, including the language client, is inlined so the packaged VSIX needs no
// node_modules and activates identically on every OS/architecture VS Code itself supports.
//
// The language server is a separate workspace package (../server) built to its own dist/; vsce
// only packages files inside this extension/ folder, so the server bundle is copied in here as
// part of the build rather than referenced by a sibling-folder path.
//
// target tracks VS Code's own embedded Node (24.18 as of stable 1.129.x, mid-2026), the actual
// runtime this code executes under — see the matching comment in server/esbuild.js.
const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const watch = process.argv.includes('--watch');

function copyServerBundle() {
  const serverDist = path.join(__dirname, '..', 'server', 'dist');
  const outDir = path.join(__dirname, 'dist');
  if (!fs.existsSync(path.join(serverDist, 'server.js'))) {
    throw new Error('server bundle not found — run `npm run build --workspace server` first');
  }
  fs.mkdirSync(outDir, { recursive: true });
  for (const file of ['server.js', 'server.js.map']) {
    fs.copyFileSync(path.join(serverDist, file), path.join(outDir, file));
  }
}

// Same reasoning as copyServerBundle: the debug adapter is a separate workspace package built to
// its own dist/, so its bundle (and the listing.inc it injects into debug builds via fasm2's -i
// flag) are copied in here rather than referenced by a sibling-folder path.
function copyDebugAdapterBundle() {
  const debugDist = path.join(__dirname, '..', 'debug', 'dist');
  const debugSupportSrc = path.join(__dirname, '..', 'debug', 'debug-support');
  const outDir = path.join(__dirname, 'dist');
  if (!fs.existsSync(path.join(debugDist, 'adapter.js'))) {
    throw new Error('debug adapter bundle not found — run `npm run build --workspace debug` first');
  }
  fs.mkdirSync(outDir, { recursive: true });
  for (const file of ['adapter.js', 'adapter.js.map']) {
    fs.copyFileSync(path.join(debugDist, file), path.join(outDir, file));
  }
  const debugSupportOut = path.join(outDir, 'debug-support');
  fs.mkdirSync(debugSupportOut, { recursive: true });
  for (const file of ['listing.inc', 'NOTICE.md', 'LICENSE-fasm.txt']) {
    fs.copyFileSync(path.join(debugSupportSrc, file), path.join(debugSupportOut, file));
  }
}

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  sourcemap: true,
  external: ['vscode'],
};

async function run() {
  if (watch) {
    copyServerBundle();
    copyDebugAdapterBundle();
    const ctx = await esbuild.context(options);
    await ctx.watch();
    console.log('[extension] watching for changes...');
  } else {
    await esbuild.build(options);
    copyServerBundle();
    copyDebugAdapterBundle();
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
