import * as path from 'node:path';

export interface SecretsDeps {
  /** Returns the project's UserSecretsId (empty/undefined when absent). */
  readProject(project: string): Promise<string | undefined>;
  init(project: string): Promise<void>;
  exists(p: string): Promise<boolean>;
  mkdirp(dir: string, mode: number): Promise<void>;
  /** Must fail if the file already exists (exclusive create). */
  writeFile(p: string, content: string, mode: number): Promise<void>;
}

export const secretsPath = (home: string, id: string): string => {
  if (!id || /[\\/\0]|\.\./.test(id)) throw new Error(`Invalid UserSecretsId: ${id}`);
  const root = path.join(home, '.microsoft', 'usersecrets');
  const file = path.join(root, id, 'secrets.json');
  if (!file.startsWith(root + path.sep)) throw new Error(`Invalid UserSecretsId: ${id}`);
  return file;
};

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
    await deps.mkdirp(path.dirname(file), 0o700);
    await deps.writeFile(file, '{}\n', 0o600);
  }
  return file;
}
