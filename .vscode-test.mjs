import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
  files: 'out/test/integration/**/*.e2e.test.js',
  launchArgs: ['--disable-extensions'],
  mocha: { ui: 'bdd', timeout: 180_000 },
});
