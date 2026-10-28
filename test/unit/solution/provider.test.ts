import { describe, expect, it, vi } from 'vitest';
import type { ProjectItems, SolutionModel } from '../../../src/solution/model';
import { SolutionTreeCore, type TreeCoreDeps } from '../../../src/solution/treeCore';

const SLN = '/w/App.sln';
const proj = (n: string) => ({ path: `/w/${n}/${n}.csproj`, name: n });

function make(opts: { n?: number; files?: string[]; sln?: boolean; selected?: string; startup?: string } = {}) {
  const n = opts.n ?? 2;
  const projects = Array.from({ length: n }, (_, i) => proj(`P${i}`));
  const model: SolutionModel = { path: SLN, kind: 'sln', folders: [], projects };
  const deps = {
    discover: vi.fn(async () => (opts.sln === false ? projects.map((p) => p.path) : [SLN, '/w/Other.sln'])),
    loadSolution: vi.fn(async (_p: string) => model),
    loadProjectInfo: vi.fn(async (p: string) => ({ path: p, rootNamespace: 'x', targetFrameworks: ['net8.0'], projectRefs: [], fileScopedNamespaces: true })),
    loadProjectItems: vi.fn(async (p: string): Promise<ProjectItems> => ({
      items: (opts.files ?? ['Program.cs', 'Sub/Deep.cs']).map((f) => ({ fullPath: p.replace(/[^/]+$/, '') + f })), evaluated: true,
    })),
    loadPackages: vi.fn(async () => []),
    walk: vi.fn(async () => []),
    fileExists: vi.fn(async () => true),
    state: { selectedSolution: () => opts.selected, startupProject: () => opts.startup },
  } satisfies TreeCoreDeps;
  return { core: new SolutionTreeCore(deps), deps, projects };
}

describe('SolutionTreeCore', () => {
  it('roots show selected solution, falling back to first', async () => {
    const a = make({ selected: '/w/Other.sln' });
    await a.core.roots();
    expect(a.deps.loadSolution).toHaveBeenCalledWith('/w/Other.sln');
    const b = make({ selected: '/nope.sln' });
    await b.core.roots();
    expect(b.deps.loadSolution).toHaveBeenCalledWith(SLN);
  });

  it('no solution shows loose projects', async () => {
    const { core } = make({ sln: false, n: 2 });
    const r = await core.roots();
    expect(r.map((x) => x.kind)).toEqual(['project', 'project']);
  });

  it('solutionPath (the hasSolution context key) is set only when a solution is loaded', async () => {
    const loose = make({ sln: false });
    await loose.core.roots();
    expect(loose.core.solutionPath).toBeUndefined();
    const withSln = make();
    await withSln.core.roots();
    expect(withSln.core.solutionPath).toBe(SLN);
  });

  it('project children load lazily once', async () => {
    const { core, deps } = make({ n: 20 });
    const [sol] = await core.roots();
    expect(deps.loadProjectItems).not.toHaveBeenCalled();
    const projects = (await core.children(sol)).filter((x) => x.kind === 'project');
    expect(projects).toHaveLength(20);
    expect(deps.loadProjectItems).not.toHaveBeenCalled();
    await core.children(projects[0]);
    await core.children(projects[0]);
    await core.children(projects[1]);
    expect(deps.loadProjectItems).toHaveBeenCalledTimes(2);
  });

  it('invalidate of a .cs path reloads only its project', async () => {
    const { core, deps, projects } = make();
    const [sol] = await core.roots();
    const [p0, p1] = (await core.children(sol)).filter((x) => x.kind === 'project');
    await core.children(p0); await core.children(p1);
    const hit = core.invalidate('/w/P0/Program.cs');
    expect(hit).toBe(p0);
    await core.children(p0); await core.children(p1);
    expect(deps.loadProjectItems).toHaveBeenCalledTimes(3);
    expect(deps.loadSolution).toHaveBeenCalledTimes(1);
    expect(core.invalidate('/elsewhere/x.cs')).toBeUndefined();
    expect(projects).toHaveLength(2);
  });

  it('invalidate of the .sln reloads the solution', async () => {
    const { core, deps } = make();
    await core.roots();
    expect(core.invalidate(SLN)).toBeNull();
    await core.roots();
    expect(deps.loadSolution).toHaveBeenCalledTimes(2);
    expect(core.invalidate('/w/P0/P0.csproj', true)).toBeNull();
  });

  it('nodeForPath finds a nested file', async () => {
    const { core } = make();
    const node = await core.nodeForPath('/w/P0/Sub/Deep.cs');
    expect(node?.kind).toBe('file');
    expect(node?.label).toBe('Deep.cs');
    const parent = core.getParent(node!);
    expect(parent?.kind).toBe('folder');
    expect(core.getParent(parent!)?.kind).toBe('project');
  });

  it('startup project from state marks node', async () => {
    const { core } = make({ startup: '/w/P1/P1.csproj' });
    const [sol] = await core.roots();
    const ps = (await core.children(sol)).filter((x) => x.kind === 'project');
    expect(ps.find((x) => x.label === 'P1')?.contextValue).toBe('cw.project.startup');
    expect(ps.find((x) => x.label === 'P0')?.contextValue).toBe('cw.project');
  });

  it('concurrent roots() share one build and identical nodes', async () => {
    const { core, deps } = make();
    const [a, b] = await Promise.all([core.roots(), core.roots()]);
    expect(a).toBe(b);
    expect(deps.loadSolution).toHaveBeenCalledTimes(1);
    expect(deps.discover).toHaveBeenCalledTimes(1);
    await core.targets();
    expect(deps.discover).toHaveBeenCalledTimes(1);
  });

  it('concurrent children() for one project share one load', async () => {
    const { core, deps } = make();
    const [sol] = await core.roots();
    const p0 = (await core.children(sol)).find((x) => x.kind === 'project')!;
    const [a, b] = await Promise.all([core.children(p0), core.children(p0)]);
    expect(a).toBe(b);
    expect(deps.loadProjectItems).toHaveBeenCalledTimes(1);
  });

  it('an invalidation during a load does not cache stale data', async () => {
    const { core, deps } = make();
    const [sol] = await core.roots();
    const p0 = (await core.children(sol)).find((x) => x.kind === 'project')!;
    const first = core.children(p0);
    core.invalidate('/w/P0/Program.cs');
    const second = await core.children(p0);
    await first;
    expect(await core.children(p0)).toBe(second);
    expect(deps.loadProjectItems).toHaveBeenCalledTimes(2);
  });

  it('getParent resolves a node under Dependencies', async () => {
    const { core, deps } = make();
    deps.loadPackages.mockResolvedValue([{ id: 'Serilog', requested: '1.0.0' }] as never);
    const [sol] = await core.roots();
    const p0 = (await core.children(sol)).find((x) => x.kind === 'project')!;
    const dep = (await core.children(p0)).find((x) => x.kind === 'dependencies')!;
    const pkgs = dep.children!.find((x) => x.kind === 'packages')!;
    const pkg = pkgs.children![0];
    expect(core.getParent(pkg)).toBe(pkgs);
    expect(core.getParent(pkgs)).toBe(dep);
    expect(core.getParent(dep)).toBe(p0);
  });
});
