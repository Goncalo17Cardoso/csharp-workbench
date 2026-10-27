import { describe, expect, it, vi } from 'vitest';
import { PanelController } from '../../../src/panel/controller';
import type { ToWebview } from '../../../src/panel/protocol';
import { DotnetError } from '../../../src/dotnet/exec';
import type { FeedClient } from '../../../src/nuget/feeds/types';

const target = { kind: 'sln' as const, path: '/s/a.sln', name: 'a' };
const projects = [{ path: '/s/A/A.csproj', name: 'A' }];
const csproj = '<Project><ItemGroup><PackageReference Include="Serilog" Version="3.0.0" /></ItemGroup></Project>';

function setup(over: { cli?: Record<string, unknown>; confirm?: boolean; client?: Partial<FeedClient> } = {}) {
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
    post: (m) => posts.push(m), confirm, openOutput: vi.fn(), switchTarget: vi.fn(),
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
    const { c, cli, confirm } = setup({ confirm: false });
    await c.handle({ type: 'ready' });
    cli.addPackage.mockClear();
    await c.handle({ type: 'run', request: { kind: 'update', packageId: 'Serilog', version: '4.0.0', projects: [projects[0].path] } });
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('Update Serilog'), expect.any(Array));
    expect(cli.addPackage).not.toHaveBeenCalled();
    expect(cli.removePackage).not.toHaveBeenCalled();
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
    const err = new DotnetError('x', [], 1, '', 'error NU1100: PackageSourceMapping blocked');
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

  it('run during an in-flight load reports instead of dropping silently', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const { c, posts, cli } = setup({ cli: { listPackages: vi.fn(async () => { await gate; return []; }) } });
    const loading = c.handle({ type: 'ready' });
    await new Promise((r) => setTimeout(r, 0));
    await c.handle({ type: 'run', request: { kind: 'install', packageId: 'X', version: '1.0.0', projects: [projects[0].path] } });
    expect(posts).toContainEqual({ type: 'opResult', ok: false, message: 'Another operation is in progress.' });
    expect(cli.addPackage).not.toHaveBeenCalled();
    release();
    await loading;
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
