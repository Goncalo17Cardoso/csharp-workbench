// Builds the extension and the e2e tests, then runs `vscode-test`.
// @vscode/test-cli mangles '#' in paths (as Vite does), so mirror the repo to a '#'-free temp dir first.
import { spawn, spawnSync } from 'node:child_process';

let cwd = process.cwd();
if (cwd.includes('#')) {
  const mirror = '/tmp/cswvt' // short: VS Code IPC socket paths are limited to ~100 chars;
  const r = spawnSync('rsync', [
    '-a', '--delete', '--exclude', '/.git', '--exclude', '/.superpowers', '--exclude', '/out', '--exclude', '/.vscode-test',
    cwd + '/', mirror + '/',
  ], { stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
  cwd = mirror;
}
if (!process.env.CSW_TEST_DOTNET) {
  const w = spawnSync('which', ['dotnet'], { encoding: 'utf8' });
  if (w.status === 0) process.env.CSW_TEST_DOTNET = w.stdout.trim();
}
for (const script of ['build', 'build:test']) {
  const r = spawnSync('npm', ['run', script], { cwd, stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
}
const child = spawn('npx', ['vscode-test', ...process.argv.slice(2)], { cwd, stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 1));
