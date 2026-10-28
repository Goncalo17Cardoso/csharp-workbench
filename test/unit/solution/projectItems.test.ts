import { mkdtemp, mkdir, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { DotnetError } from '../../../src/dotnet/exec';
import { loadProjectItems, walkProjectDir, type WalkFs } from '../../../src/solution/projectItems';

const fs: WalkFs = { readdir: (d) => readdir(d, { withFileTypes: true }) };
let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cw My App #1-'));
  for (const d of ['bin', 'obj', 'src', '.vs', 'node_modules', '.git']) await mkdir(join(dir, d));
  for (const f of ['a.csproj', 'a.csproj.user', 'src/B.cs', 'bin/x.dll', 'obj/y.json', '.vs/z', 'node_modules/n.js', '.git/h'])
    await writeFile(join(dir, f), '');
  await mkdir(join(dir, 'real'));
  await symlink(join(dir, 'real'), join(dir, 'linkdir'));
});
afterAll(() => rm(dir, { recursive: true, force: true }));

describe('walkProjectDir', () => {
  it('walk skips bin, obj and .user files', async () => {
    const got = (await walkProjectDir(dir, fs)).map((p) => p.slice(dir.length + 1)).sort();
    expect(got).toEqual(['a.csproj', 'src/B.cs']);
  });
});

describe('loadProjectItems', () => {
  it('uses evaluated items when getItems succeeds', async () => {
    const json = readFileSync('test/fixtures/cli/getitem.json', 'utf8');
    const r = await loadProjectItems('/work/Lib/Lib.csproj', { getItems: async () => json }, fs);
    expect(r.evaluated).toBe(true);
    expect(r.items).toEqual([
      { fullPath: '/work/Lib/Class1.cs' },
      { fullPath: '/work/Shared/Shared.cs', link: 'Shared/Shared.cs' },
      { fullPath: '/work/Lib/getitem.json' },
    ]);
  });
  it('falls back to disk walk with error when evaluation fails', async () => {
    const cli = { getItems: async () => { throw new DotnetError('boom', [], 1, '', ''); } };
    const r = await loadProjectItems(join(dir, 'a.csproj'), cli, fs);
    expect(r.evaluated).toBe(false);
    expect(r.error).toContain('boom');
    expect(r.items.map((i) => i.fullPath.slice(dir.length + 1)).sort()).toEqual(['a.csproj', 'src/B.cs']);
  });
});
