// Bundles the debug adapter into a single CommonJS file. Runs as its own process (spawned by the
// extension via a DebugAdapterExecutable), same reasoning as server/esbuild.js re: target.
const esbuild = require('esbuild');

const watch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: ['src/adapter.ts'],
  bundle: true,
  outfile: 'dist/adapter.js',
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
    console.log('[debug] watching for changes...');
  } else {
    await esbuild.build(options);
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
