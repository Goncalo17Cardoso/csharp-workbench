import { describe, expect, it } from 'vitest';
import { ensureSecrets, secretsPath } from '../../../src/solution/secretsCore';

function fakes(opts: { ids: Array<string | undefined>; exists?: boolean }) {
  const calls: string[] = [];
  const written: Record<string, string> = {};
  let reads = 0;
  const deps = {
    readProject: async () => opts.ids[Math.min(reads++, opts.ids.length - 1)],
    init: async (p: string) => { calls.push(`init:${p}`); },
    exists: async () => opts.exists ?? false,
    mkdirp: async (d: string, mode: number) => { calls.push(`mkdir:${d}:${mode.toString(8)}`); },
    writeFile: async (p: string, s: string, mode: number) => { written[p] = s; calls.push(`mode:${mode.toString(8)}`); },
  };
  return { deps, calls, written };
}

describe('secretsPath', () => {
  it('builds the user-secrets location', () =>
    expect(secretsPath('/home/u', 'abc')).toBe('/home/u/.microsoft/usersecrets/abc/secrets.json'));
});

describe('ensureSecrets', () => {
  it('does not init when the id exists', async () => {
    const f = fakes({ ids: ['abc'], exists: true });
    const p = await ensureSecrets('/p/a.csproj', f.deps, '/home/u');
    expect(p).toBe('/home/u/.microsoft/usersecrets/abc/secrets.json');
    expect(f.calls).toEqual([]);
  });
  it('inits then re-reads when the id is missing', async () => {
    const f = fakes({ ids: [undefined, 'new'], exists: true });
    const p = await ensureSecrets('/p/a.csproj', f.deps, '/home/u');
    expect(f.calls).toEqual(['init:/p/a.csproj']);
    expect(p).toContain('/new/');
  });
  it('creates {} file when missing', async () => {
    const f = fakes({ ids: ['abc'] });
    const p = await ensureSecrets('/p/a.csproj', f.deps, '/home/u');
    expect(f.calls).toEqual(['mkdir:/home/u/.microsoft/usersecrets/abc:700', 'mode:600']);
    expect(f.written[p]).toBe('{}\n');
  });
  it('never overwrites an existing file', async () => {
    const f = fakes({ ids: ['abc'], exists: true });
    await ensureSecrets('/p/a.csproj', f.deps, '/home/u');
    expect(f.written).toEqual({});
  });
  it('throws when init did not add the id', async () => {
    const f = fakes({ ids: [undefined] });
    await expect(ensureSecrets('/p/a.csproj', f.deps, '/h')).rejects.toThrow('UserSecretsId was not added to the project.');
  });
  it.each(['../../x', 'a/b', 'a\\b', 'a\0b'])('rejects hostile id %j', async (id) => {
    const f = fakes({ ids: [id] });
    await expect(ensureSecrets('/p/a.csproj', f.deps, '/h')).rejects.toThrow('Invalid UserSecretsId');
    expect(f.calls).toEqual([]);
  });
});
