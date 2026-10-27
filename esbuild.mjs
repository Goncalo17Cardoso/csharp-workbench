import { build, context } from 'esbuild';

const options = {
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.js',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['vscode'],
  sourcemap: true,
};

const webviewOptions = {
  entryPoints: ['src/webview/main.ts'],
  outfile: 'dist/webview/main.js',
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'es2022',
  sourcemap: true,
};

if (process.argv.includes('--watch')) {
  await (await context(options)).watch();
  await (await context(webviewOptions)).watch();
} else {
  await build(options);
  await build(webviewOptions);
}
