import { describe, expect, it, vi } from 'vitest';
import { loadConfirmedState, loadFastState } from '../../../src/state/loadState';
import type { SolutionState, Target } from '../../../src/core/types';

const target: Target = { kind: 'sln', path: '/s/a.sln', name: 'a' };
const A = { path: '/s/A/A.csproj', name: 'A' };
const B = { path: '/s/B/B.csproj', name: 'B' };
const files: Record<string, string> = {
  '/s/A/A.csproj': '<Project><ItemGroup><PackageReference Include="X" /><PackageReference Include="Y" VersionOverride="2.0.0" /></ItemGroup></Project>',
  '/s/B/B.csproj': '<Project><ItemGroup><PackageReference Include="X" Version="1.0.0" /></ItemGroup></Project>',
  '/s/Directory.Packages.props': '<Project><PropertyGroup><ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally></PropertyGroup><ItemGroup><PackageVersion Include="X" Version="1.0.0" /></ItemGroup></Project>',
};
const mkFs = (extra: string[] = []) => ({
  readFile: async (p: string) => files[p],
  exists: async (p: string) => p in files || extra.includes(p),
});

describe('loadFastState', () => {
  it('reads refs and cpm from files', async () => {
    const s = await loadFastState(target, [A, B], mkFs());
    expect(s.projects[1].packages).toEqual([{ id: 'X', requested: '1.0.0' }]);
    expect(s.cpm?.versions.get('x')).toBe('1.0.0');
  });
  it('has no cpm without projects', async () => {
    expect((await loadFastState(target, [], mkFs())).cpm).toBeUndefined();
  });
});

describe('loadConfirmedState', () => {
  const fast = (): SolutionState => ({
    target,
    projects: [
      { project: A, packages: [{ id: 'Y', versionOverride: '2.0.0' }] },
      { project: B, packages: [{ id: 'X', requested: '1.0.0' }] },
    ],
  });
  const mkCli = () => ({
    restore: vi.fn(async () => {}),
    listPackages: vi.fn(async () => [{ project: A, packages: [{ id: 'y', resolved: '2.0.0' }] }]),
  });
  const assets = ['/s/A/obj/project.assets.json', '/s/B/obj/project.assets.json'];

  it('runs restore only when project.assets.json missing', async () => {
    const cli = mkCli();
    await loadConfirmedState(target, fast(), cli as any, mkFs(assets.slice(0, 1)));
    expect(cli.restore).toHaveBeenCalledTimes(1);
    const cli2 = mkCli();
    await loadConfirmedState(target, fast(), cli2 as any, mkFs(assets));
    expect(cli2.restore).not.toHaveBeenCalled();
  });

  it('merges cli results, keeps versionOverride and missing projects', async () => {
    const s = await loadConfirmedState(target, fast(), mkCli() as any, mkFs(assets));
    expect(s.projects[0].packages).toEqual([{ id: 'y', resolved: '2.0.0', versionOverride: '2.0.0' }]);
    expect(s.projects[1].packages).toEqual([{ id: 'X', requested: '1.0.0' }]);
  });

  it('propagates errors', async () => {
    const cli = mkCli();
    cli.listPackages.mockRejectedValue(new Error('boom'));
    await expect(loadConfirmedState(target, fast(), cli as any, mkFs(assets))).rejects.toThrow('boom');
  });
});
