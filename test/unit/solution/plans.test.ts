import { describe, expect, it } from 'vitest';
import type { ProjectInfoData, SolutionModel } from '../../../src/solution/model';
import {
  dependentsOf, executePlan, folderPathOf, locateCsproj, planRemoveFolder, planRenameProject, referenceCandidates,
  solutionFolderId, validateProjectName,
} from '../../../src/solution/plans';
import { clearStartupIfRemoved, getStartupProject, moveStartupProject, setStartupProject } from '../../../src/solution/state';

const model: SolutionModel = {
  path: '/s/App.sln', kind: 'sln',
  folders: [
    { id: '{A}', name: 'src' }, { id: '{B}', name: 'web', parentId: '{A}' },
    { id: '{C}', name: 'deep', parentId: '{B}' }, { id: '{D}', name: 'docs' },
  ],
  projects: [
    { path: '/s/src/web/Web/Web.csproj', name: 'Web', folderId: '{B}' },
    { path: '/s/src/Lib/Lib.csproj', name: 'Lib', folderId: '{A}' },
    { path: '/s/src/Deep/Deep.csproj', name: 'Deep', folderId: '{C}' },
    { path: '/s/Other/Other.csproj', name: 'Other' },
  ],
};
const info = (path: string, projectRefs: string[]): ProjectInfoData =>
  ({ path, rootNamespace: 'N', targetFrameworks: [], projectRefs, fileScopedNamespaces: true });

describe('plans', () => {
  it('rename plan order is slnRemove, removeRefs, rename, slnAdd with folder, addRefs', () => {
    const old = '/s/src/web/Web/Web.csproj';
    const neu = '/s/src/web/Web/Site.csproj';
    expect(planRenameProject(model, old, 'Site', ['/s/A/A.csproj', '/s/B/B.csproj'])).toEqual([
      { op: 'slnRemove', args: [old] },
      { op: 'removeRef', args: ['/s/A/A.csproj', old] },
      { op: 'removeRef', args: ['/s/B/B.csproj', old] },
      { op: 'renameFile', args: [old, neu] },
      { op: 'slnAdd', args: [neu, 'src/web'] },
      { op: 'addRef', args: ['/s/A/A.csproj', neu] },
      { op: 'addRef', args: ['/s/B/B.csproj', neu] },
    ]);
  });
  it('rename plan omits the folder for a root project', () => {
    const steps = planRenameProject(model, '/s/Other/Other.csproj', 'X', []);
    expect(steps[2]).toEqual({ op: 'slnAdd', args: ['/s/Other/X.csproj'] });
  });
  it('folderPathOf builds nested path', () => {
    expect(folderPathOf(model, '{B}')).toBe('src/web');
    expect(folderPathOf(model, '{A}')).toBe('src');
  });
  it('planRemoveFolder lists nested projects and folders bottom-up', () => {
    const plan = planRemoveFolder(model, '{A}');
    expect([...plan.projectRemovals].sort()).toEqual(
      ['/s/src/Deep/Deep.csproj', '/s/src/Lib/Lib.csproj', '/s/src/web/Web/Web.csproj']);
    expect(plan.folderIdsBottomUp).toEqual(['{C}', '{B}', '{A}']);
    expect(planRemoveFolder(model, '{D}')).toEqual({ projectRemovals: [], folderIdsBottomUp: ['{D}'] });
  });
  it('dependentsOf finds projects referencing target', () => {
    const infos = [info('/a.csproj', ['/t.csproj']), info('/b.csproj', []), info('/c.csproj', ['/x.csproj', '/t.csproj'])];
    expect(dependentsOf(infos, '/t.csproj')).toEqual(['/a.csproj', '/c.csproj']);
  });
  it('solutionFolderId strips the node id prefix', () => {
    expect(solutionFolderId('solutionFolder:/s/App.sln|{B}', '/s/App.sln')).toBe('{B}');
    expect(solutionFolderId('solutionFolder:/s/App.slnx|/src/', '/s/App.slnx')).toBe('/src/');
  });
});

describe('helpers', () => {
  it('validateProjectName', () => {
    expect(validateProjectName('', () => false)).toBe('empty');
    expect(validateProjectName('a|b', () => false)).toBe('chars');
    expect(validateProjectName('Foo', () => true)).toBe('exists');
    expect(validateProjectName('Foo', () => false)).toBeUndefined();
  });
  it('referenceCandidates excludes self, existing refs and direct cycles', () => {
    const projects = [
      { path: '/t.csproj', name: 'T' }, { path: '/a.csproj', name: 'A' },
      { path: '/b.csproj', name: 'B' }, { path: '/c.csproj', name: 'C' },
    ];
    const infos = [info('/t.csproj', ['/a.csproj']), info('/b.csproj', ['/t.csproj']), info('/c.csproj', [])];
    expect(referenceCandidates(projects, infos, '/t.csproj').map((p) => p.name)).toEqual(['C']);
  });
  it('locateCsproj prefers the expected path, else the single csproj found', () => {
    expect(locateCsproj('/o/N/N.csproj', ['/o/N/N.csproj', '/o/N/x.cs'])).toBe('/o/N/N.csproj');
    expect(locateCsproj('/o/N/N.csproj', ['/o/N/src/Other.csproj', '/o/N/x.cs'])).toBe('/o/N/src/Other.csproj');
    expect(locateCsproj('/o/N/N.csproj', ['/o/a.csproj', '/o/b.csproj'])).toBeUndefined();
    expect(locateCsproj('/o/N/N.csproj', ['/o/x.cs'])).toBeUndefined();
  });
  it('executePlan stops at the first failing step', async () => {
    const ran: number[] = [];
    const steps = [1, 2, 3].map((n) => ({ op: 'addRef' as const, args: [String(n)] }));
    const r = await executePlan(steps, async (s) => { ran.push(+s.args[0]); if (s.args[0] === '2') throw new Error('boom'); });
    expect(ran).toEqual([1, 2]);
    expect(r.failedAt).toBe(1);
    expect((r.error as Error).message).toBe('boom');
    expect((await executePlan(steps, async () => {})).failedAt).toBeUndefined();
  });
});

describe('startup state', () => {
  const fake = () => {
    const m = new Map<string, unknown>();
    return { get: <T>(k: string) => m.get(k) as T | undefined, update: async (k: string, v: unknown) => { m.set(k, v); } };
  };
  it('startup state follows rename and clears on remove', async () => {
    const ws = fake();
    await setStartupProject(ws, '/s/App.sln', '/s/Web/Web.csproj');
    await moveStartupProject(ws, '/s/App.sln', '/s/Other/O.csproj', '/s/Other/P.csproj');
    expect(getStartupProject(ws, '/s/App.sln')).toBe('/s/Web/Web.csproj');
    await moveStartupProject(ws, '/s/App.sln', '/s/Web/Web.csproj', '/s/Web/Site.csproj');
    expect(getStartupProject(ws, '/s/App.sln')).toBe('/s/Web/Site.csproj');
    await clearStartupIfRemoved(ws, '/s/App.sln', ['/s/Lib/Lib.csproj']);
    expect(getStartupProject(ws, '/s/App.sln')).toBe('/s/Web/Site.csproj');
    await clearStartupIfRemoved(ws, '/s/App.sln', ['/s/Web/Site.csproj']);
    expect(getStartupProject(ws, '/s/App.sln')).toBeUndefined();
  });
});
