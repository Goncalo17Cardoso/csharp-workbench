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

const propsOptions = {
  ...webviewOptions,
  entryPoints: ['src/webview/properties/main.ts'],
  outfile: 'dist/webview/properties.js',
};

if (process.argv.includes('--tests')) {
  // Integration tests run inside the VS Code extension host: bundle each *.e2e.test.ts to out/.
  const { globSync } = await import('node:fs');
  await build({
    entryPoints: globSync('test/integration/**/*.e2e.test.ts'),
    outdir: 'out/test/integration',
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['vscode', 'mocha'],
    sourcemap: true,
  });
} else if (process.argv.includes('--watch')) {
  await (await context(options)).watch();
  await (await context(webviewOptions)).watch();
  await (await context(propsOptions)).watch();
} else {
  await build(options);
  await build(webviewOptions);
  await build(propsOptions);
}
