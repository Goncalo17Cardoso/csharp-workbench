// Framework-agnostic: no vitest or mocha imports (reused by the VS Code integration tests).
import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

function dotnet(dotnetPath: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(dotnetPath, args, { cwd, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) =>
      err ? reject(new Error(`dotnet ${args.join(' ')} failed: ${stderr || stdout || err.message}`)) : resolve(stdout),
    );
  });
}

export interface FixtureSolution { sln: string; projects: string[]; props?: string }

/** Creates `<dir>/App.sln` with two net8.0 classlibs (A, B); with cpm also a Directory.Packages.props. */
export async function createFixtureSolution(
  dir: string,
  opts: { cpm: boolean; dotnetPath?: string },
): Promise<FixtureSolution> {
  const dn = opts.dotnetPath ?? 'dotnet';
  await fs.mkdir(dir, { recursive: true });
  // SDK 10 defaults to .slnx; SDK 8 has no --format option (and always writes .sln).
  await dotnet(dn, ['new', 'sln', '--format', 'sln', '-n', 'App'], dir).catch(() =>
    dotnet(dn, ['new', 'sln', '-n', 'App'], dir),
  );
  const projects: string[] = [];
  for (const name of ['A', 'B']) {
    await dotnet(dn, ['new', 'classlib', '-n', name, '-f', 'net8.0'], dir);
    projects.push(path.join(dir, name, `${name}.csproj`));
  }
  const sln = path.join(dir, 'App.sln');
  await dotnet(dn, ['sln', sln, 'add', ...projects], dir);
  let props: string | undefined;
  if (opts.cpm) {
    await dotnet(dn, ['new', 'packagesprops'], dir);
    props = path.join(dir, 'Directory.Packages.props');
  }
  return { sln, projects, props };
}
