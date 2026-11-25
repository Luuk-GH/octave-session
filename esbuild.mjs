import * as esbuild from 'esbuild';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

// The Command Window webview (browser code, CodeMirror bundled in).
const webview = await esbuild.context({
  entryPoints: ['src/commandWindow/webview/main.ts'],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  outfile: 'dist/commandWindow.js',
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
});

const ctx = await esbuild.context({
  entryPoints: ['src/extension.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  outfile: 'dist/extension.js',
  external: ['vscode'],
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
});

if (watch) {
  await Promise.all([ctx.watch(), webview.watch()]);
} else {
  await Promise.all([ctx.rebuild(), webview.rebuild()]);
  await Promise.all([ctx.dispose(), webview.dispose()]);
}
