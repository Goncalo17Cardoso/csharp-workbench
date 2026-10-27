// Vite cannot run with '#' in the project path, so mirror the repo to a '#'-free temp dir and run vitest there.
import { spawn, spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
let cwd = process.cwd();

if (cwd.includes('#')) {
  const mirror = path.join(os.tmpdir(), 'csharp-workbench-vitest');
  const r = spawnSync('rsync', [
    '-a', '--delete',
    '--exclude', '/.git', '--exclude', '/.superpowers', '--exclude', '/dist',
    '--exclude', '/out', '--exclude', '/.vscode-test',
    cwd + '/', mirror + '/',
  ], { stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
  cwd = mirror;
}

const child = spawn('npx', ['vitest', ...args], { cwd, stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 1));
