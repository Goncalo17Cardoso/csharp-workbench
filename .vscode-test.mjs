import { mkdirSync } from 'node:fs';
import { defineConfig } from '@vscode/test-cli';

// The Solution Explorer e2e tests build their fixtures inside this workspace folder (kept short and '#'-free).
const workspaceFolder = '/tmp/cswws';
mkdirSync(workspaceFolder, { recursive: true });

export default defineConfig({
  files: 'out/test/integration/**/*.e2e.test.js',
  workspaceFolder,
  launchArgs: ['--disable-extensions'],
  mocha: { ui: 'bdd', timeout: 180_000 },
});
