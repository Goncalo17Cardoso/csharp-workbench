import { describe, expect, it, vi } from 'vitest';
import { PanelController } from '../../../src/panel/controller';
import type { ToWebview } from '../../../src/panel/protocol';
import { DotnetError } from '../../../src/dotnet/exec';
import type { FeedClient } from '../../../src/nuget/feeds/types';

const target = { kind: 'sln' as const, path: '/s/a.sln', name: 'a' };
const projects = [{ path: '/s/A/A.csproj', name: 'A' }];
const csproj = '<Project><ItemGroup><PackageReference Include="Serilog" Version="3.0.0" /></ItemGroup></Project>';

function setup(over: { cli?: Record<string, unknown>; confirm?: boolean; client?: Partial<FeedClient>; onPost?: (m: ToWebview) => void } = {}) {
  const posts: ToWebview[] = [];
  const cli = {
    restore: vi.fn(async () => {}),
    listPackages: vi.fn(async () => [{ project: projects[0], packages: [{ id: 'Serilog', resolved: '3.0.0', latest: '4.0.0' }] }]),
    addPackage: vi.fn(async () => {}),
    removePackage: vi.fn(async () => {}),
    configPaths: vi.fn(async () => ['/s/nuget.config']),
    ...over.cli,
  };
  const client = { search: vi.fn(async () => []), versions: vi.fn(async () => ['1.0.0']), details: vi.fn(async () => ({ id: 'X', version: '1.0.0', description: '', dependencies: [] })), ...over.client } as unknown as FeedClient;
  const confirm = vi.fn(async () => over.confirm ?? true);
  const c = new PanelController({
    cli: cli as never,
    fs: { readFile: async () => csproj, exists: async () => true },
    targets: [target], target, projects,
    sources: [{ name: 'nuget.org' }],
    feeds: () => [{ source: { name: 'nuget.org', url: 'u', kind: 'v3' }, client }],
    post: (m) => { posts.push(m); over.onPost?.(m); }, confirm, openOutput: vi.fn(), switchTarget: vi.fn(),
  });
  return { c, cli, posts, confirm, client };
}
const types = (p: ToWebview[]) => p.map((m) => m.type);

describe('PanelController', () => {
  it('ready posts init then unconfirmed installed then confirmed', async () => {
    const { c, posts } = setup();
    await c.handle({ type: 'ready' });
    expect(types(posts).slice(0, 2)).toEqual(['init', 'installed']);
    expect((posts[1] as { confirmed: boolean }).confirmed).toBe(false);
    expect(posts.some((m) => m.type === 'installed' && m.confirmed)).toBe(true);
    expect(types(posts)).toContain('updates');
    expect(types(posts)).toContain('consolidate');
  });

  it('run asks confirmation with affected projects and aborts when declined', async () => {
    const { c, cli, confirm, posts } = setup({ confirm: false });
    await c.handle({ type: 'ready' });
    cli.addPackage.mockClear();
    posts.length = 0;
    await c.handle({ type: 'run', request: { kind: 'update', packageId: 'Serilog', version: '4.0.0', projects: [projects[0].path] } });
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('Update Serilog'), expect.any(Array));
    expect(cli.addPackage).not.toHaveBeenCalled();
    expect(cli.removePackage).not.toHaveBeenCalled();
    expect(posts.filter((m) => m.type === 'opResult')).toEqual([{ type: 'opResult', ok: false, message: 'Cancelled.' }]);
  });

  it('failed operation clears busy and posts error with canOpenOutput', async () => {
    const { c, posts } = setup({ cli: { addPackage: vi.fn(async () => { throw new DotnetError('boom', [], 1, '', 'bad'); }) } });
    await c.handle({ type: 'ready' });
    posts.length = 0;
    await c.handle({ type: 'run', request: { kind: 'install', packageId: 'X', version: '1.0.0', projects: [projects[0].path] } });
    const seq = posts.filter((m) => m.type === 'busy' || m.type === 'error');
    expect((seq[0] as { label: string }).label).toBeTruthy();
    const i = seq.findIndex((m) => m.type === 'busy' && m.label === null);
    expect(seq[i + 1]).toMatchObject({ type: 'error', canOpenOutput: true });
    expect(c.busy).toBe(false);
  });

  it('search reports source failures alongside results', async () => {
    const { c, posts } = setup({ client: { search: vi.fn(async () => { throw new Error('401'); }) } });
    await c.handle({ type: 'search', query: 'x', prerelease: false, source: 'All', skip: 0 });
    expect(posts[0]).toMatchObject({ type: 'searchResults', append: false, failures: [{ source: 'nuget.org' }] });
  });

  it('source mapping failure names the nuget.config to fix', async () => {
    // `dotnet add package` prints NU1100 on stdout, not stderr.
    const err = new DotnetError('x', [], 1, 'error NU1100: Unable to resolve. PackageSourceMapping is enabled, the following source(s) were not considered: nuget.org.', '');
    const { c, posts } = setup({ cli: { addPackage: vi.fn(async () => { throw err; }) } });
    await c.handle({ type: 'ready' });
    await c.handle({ type: 'run', request: { kind: 'install', packageId: 'X', version: '1.0.0', projects: [projects[0].path] } });
    const e = posts.find((m) => m.type === 'error') as { message: string };
    expect(e.message).toContain('Package source mapping blocked this package. Add a mapping in /s/nuget.config.');
  });

  it('restore failure on load posts error and keeps unconfirmed installed visible', async () => {
    const { c, posts } = setup({ cli: { listPackages: vi.fn(async () => { throw new DotnetError('x', [], 1, '', 'restore failed'); }) } });
    await c.handle({ type: 'ready' });
    expect(posts.filter((m) => m.type === 'installed')).toHaveLength(1);
    const n = types(posts);
    expect(n.slice(-2)).toEqual(['busy', 'error']);
    expect(posts[posts.length - 1]).toMatchObject({ canOpenOutput: true });
  });

  it('run during an in-flight load waits for it, then executes', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const { c, posts, cli } = setup({ cli: { listPackages: vi.fn(async () => { await gate; return []; }) } });
    const loading = c.handle({ type: 'ready' });
    await new Promise((r) => setTimeout(r, 0));
    const running = c.handle({ type: 'run', request: { kind: 'install', packageId: 'X', version: '1.0.0', projects: [projects[0].path] } });
    await new Promise((r) => setTimeout(r, 0));
    expect(cli.addPackage).not.toHaveBeenCalled();
    release();
    await loading;
    await running;
    expect(cli.addPackage).toHaveBeenCalledTimes(1);
    expect(posts.filter((m) => m.type === 'opResult')).toEqual([{ type: 'opResult', ok: true, message: 'Install X 1.0.0 in 1 project' }]);
  });

  it('run while another run is in flight is rejected', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const { c, posts, cli } = setup({ cli: { addPackage: vi.fn(async () => { await gate; }) } });
    await c.handle({ type: 'ready' });
    const req = { type: 'run' as const, request: { kind: 'install' as const, packageId: 'X', version: '1.0.0', projects: [projects[0].path] } };
    const first = c.handle(req);
    await new Promise((r) => setTimeout(r, 0));
    await c.handle(req);
    expect(posts).toContainEqual({ type: 'opResult', ok: false, message: 'Another operation is in progress.' });
    release();
    await first;
    expect(cli.addPackage).toHaveBeenCalledTimes(1);
  });

  it('sequential runs sent on each opResult (like UpdateSequence) all execute', async () => {
    const slowList = vi.fn(() => new Promise((r) => setTimeout(() => r([{ project: projects[0], packages: [{ id: 'Serilog', resolved: '3.0.0', latest: '4.0.0' }] }]), 5)));
    const run = (id: string) => ({ type: 'run' as const, request: { kind: 'update' as const, packageId: id, version: '4.0.0', projects: [projects[0].path] } });
    const queue = [run('Serilog'), run('Serilog')];
    let done!: () => void;
    const finished = new Promise<void>((r) => { done = r; });
    const results: ToWebview[] = [];
    const { c, cli, posts } = setup({
      cli: { listPackages: slowList },
      onPost: (m) => {
        if (m.type !== 'opResult' && m.type !== 'error') return;
        results.push(m);
        const next = m.type === 'opResult' && m.ok ? queue.shift() : undefined;
        if (next) setTimeout(() => void c.handle(next), 0); else done();
      },
    });
    await c.handle({ type: 'ready' });
    void c.handle(run('Serilog'));
    await finished;
    expect(results).toHaveLength(3);
    expect(results.every((m) => m.type === 'opResult' && m.ok)).toBe(true);
    expect(cli.addPackage).toHaveBeenCalledTimes(3);
    // opResult is posted only after the post-operation reload finished.
    const last = posts.map((m) => m.type).lastIndexOf('opResult');
    const lastInstalled = posts.map((m) => (m.type === 'installed' && m.confirmed ? 'ci' : '')).lastIndexOf('ci');
    expect(lastInstalled).toBeLessThan(last);
  });

  it('partial failure reloads and reports how many steps completed', async () => {
    let n = 0;
    const { c, posts, cli } = setup({ cli: { addPackage: vi.fn(async () => { if (++n === 2) throw new DotnetError('boom', [], 1, '', 'bad'); }) } });
    await c.handle({ type: 'ready' });
    cli.listPackages.mockClear();
    posts.length = 0;
    await c.handle({ type: 'run', request: { kind: 'install', packageId: 'X', version: '1.0.0', projects: ['/s/A/A.csproj', '/s/B/B.csproj'] } });
    expect(cli.listPackages).toHaveBeenCalled();
    const iInstalled = posts.findIndex((m) => m.type === 'installed');
    const iError = posts.findIndex((m) => m.type === 'error');
    expect(iInstalled).toBeGreaterThan(-1);
    expect(iInstalled).toBeLessThan(iError);
    expect((posts[iError] as { message: string }).message).toContain('1 of 2 steps completed.');
    expect(c.busy).toBe(false);
  });

  it('failure with no completed step does not mention steps', async () => {
    const { c, posts } = setup({ cli: { addPackage: vi.fn(async () => { throw new DotnetError('boom', [], 1, '', 'bad'); }) } });
    await c.handle({ type: 'ready' });
    await c.handle({ type: 'run', request: { kind: 'install', packageId: 'X', version: '1.0.0', projects: [projects[0].path] } });
    const e = posts.find((m) => m.type === 'error') as { message: string };
    expect(e.message).toBe('boom');
  });

  it('selectVersion resends the full versions list for that package', async () => {
    const { c, posts, client } = setup({ client: { versions: vi.fn(async () => ['1.0.0', '2.0.0']) } });
    await c.handle({ type: 'ready' });
    await c.handle({ type: 'selectPackage', id: 'Serilog', prerelease: false, source: 'All' });
    posts.length = 0;
    await c.handle({ type: 'selectVersion', id: 'Serilog', version: '1.0.0' });
    expect(posts[0]).toMatchObject({ type: 'details', versions: ['2.0.0', '1.0.0'], perProject: { [projects[0].path]: '3.0.0' } });
    expect(client.details).toHaveBeenLastCalledWith('Serilog', '1.0.0');
  });

  it('selectPackage with a version asks details for that version', async () => {
    const { c, client } = setup({ client: { versions: vi.fn(async () => ['1.0.0', '2.0.0']) } });
    await c.handle({ type: 'selectPackage', id: 'Serilog', prerelease: false, source: 'All', version: '1.0.0' });
    expect(client.details).toHaveBeenLastCalledWith('Serilog', '1.0.0');
    await c.handle({ type: 'selectPackage', id: 'Serilog', prerelease: false, source: 'All', version: '9.9.9' });
    expect(client.details).toHaveBeenLastCalledWith('Serilog', '2.0.0');
  });

  it('details carry VersionOverride projects and their override version (cpm)', async () => {
    const files: Record<string, string> = {
      '/s/A/A.csproj': '<Project><ItemGroup><PackageReference Include="Serilog" /></ItemGroup></Project>',
      '/s/B/B.csproj': '<Project><ItemGroup><PackageReference Include="Serilog" VersionOverride="2.0.0" /></ItemGroup></Project>',
      '/s/Directory.Packages.props': '<Project><PropertyGroup><ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally></PropertyGroup><ItemGroup><PackageVersion Include="Serilog" Version="3.0.0" /></ItemGroup></Project>',
    };
    const two = [{ path: '/s/A/A.csproj', name: 'A' }, { path: '/s/B/B.csproj', name: 'B' }];
    const posts: ToWebview[] = [];
    const client = { versions: vi.fn(async () => ['3.0.0']), details: vi.fn(async () => ({ id: 'Serilog', version: '3.0.0', description: '', dependencies: [] })) } as unknown as FeedClient;
    const c = new PanelController({
      cli: { listPackages: vi.fn(async () => { throw new Error('offline'); }), restore: vi.fn(), configPaths: vi.fn() } as never,
      fs: { readFile: async (p) => files[p], exists: async (p) => p in files },
      targets: [target], target, projects: two, sources: [],
      feeds: () => [{ source: { name: 'n', url: 'u', kind: 'v3' }, client }],
      post: (m) => posts.push(m), confirm: vi.fn(), openOutput: vi.fn(), switchTarget: vi.fn(),
    });
    await c.handle({ type: 'refresh' });
    await c.handle({ type: 'selectPackage', id: 'serilog', prerelease: false, source: 'All' });
    expect(posts.find((m) => m.type === 'details')).toMatchObject({
      perProject: { '/s/A/A.csproj': '3.0.0', '/s/B/B.csproj': '2.0.0' },
      overrides: ['/s/B/B.csproj'],
    });
  });

  it('busy stays true until both overlapping loads finish', async () => {
    const gates: (() => void)[] = [];
    const { c } = setup({ cli: { listPackages: vi.fn((_p: string, o?: { outdated?: boolean }) => (o?.outdated ? new Promise((r) => gates.push(() => r([]))) : Promise.resolve([]))) } });
    const a = c.handle({ type: 'refresh' });
    const b = c.handle({ type: 'refresh' });
    await new Promise((r) => setTimeout(r, 0));
    expect(gates).toHaveLength(2);
    gates[0](); await a;
    expect(c.busy).toBe(true);
    gates[1](); await b;
    expect(c.busy).toBe(false);
  });
});
