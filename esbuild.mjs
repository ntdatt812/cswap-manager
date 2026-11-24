import * as esbuild from 'esbuild';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const shared = {
  bundle: true,
  sourcemap: !production,
  sourcesContent: false,
  minify: production,
  logLevel: 'info',
};

/** @type {import('esbuild').BuildOptions[]} */
const builds = [
  {
    ...shared,
    entryPoints: ['src/extension.ts'],
    format: 'cjs',
    platform: 'node',
    target: 'node20',
    outfile: 'dist/extension.js',
    external: ['vscode'],
  },
  {
    // The dashboard webview runs in a browser context with a strict CSP (nonce'd script only).
    ...shared,
    entryPoints: ['src/webview/dashboard.ts'],
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    outfile: 'dist/webview/dashboard.js',
  },
];

if (watch) {
  const contexts = await Promise.all(builds.map((options) => esbuild.context(options)));
  await Promise.all(contexts.map((context) => context.watch()));
} else {
  await Promise.all(builds.map((options) => esbuild.build(options)));
}
