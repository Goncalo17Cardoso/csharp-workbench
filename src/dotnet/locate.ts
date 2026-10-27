import * as path from 'node:path';

export interface LocateDeps {
  configuredPath?: string;
  pathEnv: string;
  home: string;
  exists(p: string): Promise<boolean>;
}

export async function findDotnet(deps: LocateDeps): Promise<string | undefined> {
  const candidates: string[] = [];
  if (deps.configuredPath) candidates.push(deps.configuredPath);
  for (const dir of deps.pathEnv.split(':')) {
    if (dir) candidates.push(path.posix.join(dir, 'dotnet'));
  }
  candidates.push(
    '/usr/local/share/dotnet/dotnet',
    '/usr/share/dotnet/dotnet',
    path.posix.join(deps.home, '.dotnet', 'dotnet'),
    '/opt/homebrew/bin/dotnet',
  );
  for (const c of candidates) {
    if (await deps.exists(c)) return c;
  }
  return undefined;
}
