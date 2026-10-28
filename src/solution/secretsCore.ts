import * as path from 'node:path';

export interface SecretsDeps {
  /** Returns the project's UserSecretsId (empty/undefined when absent). */
  readProject(project: string): Promise<string | undefined>;
  init(project: string): Promise<void>;
  exists(p: string): Promise<boolean>;
  mkdirp(dir: string): Promise<void>;
  writeFile(p: string, content: string): Promise<void>;
}

export const secretsPath = (home: string, id: string): string =>
  path.join(home, '.microsoft', 'usersecrets', id, 'secrets.json');

/** Makes sure the project has a UserSecretsId and its secrets.json exists; returns the file path. */
export async function ensureSecrets(project: string, deps: SecretsDeps, home: string): Promise<string> {
  let id = await deps.readProject(project);
  if (!id) {
    await deps.init(project);
    id = await deps.readProject(project);
    if (!id) throw new Error('UserSecretsId was not added to the project.');
  }
  const file = secretsPath(home, id);
  if (!(await deps.exists(file))) {
    await deps.mkdirp(path.dirname(file));
    await deps.writeFile(file, '{}\n');
  }
  return file;
}
