// Bundles the language server into a single CommonJS file for fast, dependency-free activation.
// This process is forked by vscode-languageclient from inside the extension host, so it runs
// under whatever Node.js version that specific Electron build embeds — not the end user's system
// Node. Current stable VS Code (1.129.x, mid-2026) embeds Node 24.18; target tracks that, not an
// arbitrary "modern" choice. Bump this in step with VS Code's own Node upgrades, not ahead of them.
const esbuild = require('esbuild');

const watch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: ['src/server.ts'],
  bundle: true,
  outfile: 'dist/server.js',
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  sourcemap: true,
  external: [],
};

async function run() {
  if (watch) {
    const ctx = await esbuild.context(options);
    await ctx.watch();
    console.log('[server] watching for changes...');
  } else {
    await esbuild.build(options);
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
