import type { PackageRef } from '../../../src/core/types';
import { describe, expect, it } from 'vitest';
import type { ProjectInfoData, SolutionModel, TreeNode } from '../../../src/solution/model';
import { buildProjectChildren, buildSolutionNodes } from '../../../src/solution/tree';

const P = '/r/App/App.csproj';
const proj = { path: P, name: 'App' };
const info: ProjectInfoData = { path: P, rootNamespace: 'App', targetFrameworks: ['net8.0'], projectRefs: ['/r/Lib/Lib.csproj'], fileScopedNamespaces: true };
const ev = (...files: Array<string | { fullPath: string; link?: string }>) =>
  ({ evaluated: true, items: files.map((f) => (typeof f === 'string' ? { fullPath: f } : f)) });
const labels = (ns: TreeNode[]) => ns.map((n) => n.label);

describe('buildSolutionNodes', () => {
  const model: SolutionModel = {
    path: '/r/My.sln', kind: 'sln',
    folders: [{ id: 'F2', name: 'zeta' }, { id: 'F1', name: 'Alpha' }, { id: 'F3', name: 'orphan', parentId: '/missing/' }],
    projects: [
      { path: '/r/b.csproj', name: 'b' }, { path: '/r/A.csproj', name: 'A' },
      { path: '/r/c.csproj', name: 'c', folderId: 'F1' },
    ],
  };
  it('solution children: folders before projects, sorted', () => {
    const [sol] = buildSolutionNodes(model, {});
    expect(sol.label).toBe("Solution 'My' (3 projects)");
    expect(sol.count).toBe(3);
    expect(sol.id).toBe('solution:/r/My.sln');
    expect(labels(sol.children!)).toEqual(['Alpha', 'orphan', 'zeta', 'A', 'b']);
    expect(labels(sol.children![0].children!)).toEqual(['c']);
    expect(sol.children![0].id).toBe('solutionFolder:/r/My.sln|F1');
  });
  it('dangling parentId folder is a child of the solution root', () => {
    const [sol] = buildSolutionNodes(model, {});
    expect(sol.children!.some((c) => c.label === 'orphan')).toBe(true);
  });
  it('startup project gets .startup context suffix', () => {
    const [sol] = buildSolutionNodes(model, { startupProject: '/r/b.csproj' });
    const by = Object.fromEntries(sol.children!.filter((c) => c.kind === 'project').map((c) => [c.label, c.contextValue]));
    expect(by).toEqual({ A: 'cw.project', b: 'cw.project.startup' });
  });
});

describe('buildProjectChildren', () => {
  it('project children start with Dependencies', () => {
    const out = buildProjectChildren(proj, info, ev('/r/App/Program.cs'),
      [{ id: 'Serilog', requested: '3.0.0' }, { id: 'X', resolved: '1.0.0' }, { id: 'Y' }], { showAllFiles: false });
    expect(out[0].kind).toBe('dependencies');
    const [pk, pr, fw] = out[0].children!;
    expect(labels([pk, pr, fw])).toEqual(['Packages', 'Projects', 'Frameworks']);
    expect(pk.children!.map((c) => c.description)).toEqual(['3.0.0', '1.0.0', '']);
    expect(pr.children![0]).toMatchObject({ label: 'Lib', id: `projectRef:${P}|/r/Lib/Lib.csproj` });
    expect(fw.children![0].id).toBe(`framework:${P}|net8.0`);
    expect(labels(out.slice(1))).toEqual(['Program.cs']);
  });
  it('folders first, sorted, with nesting and chained nesting', () => {
    const out = buildProjectChildren(proj, info, ev(
      '/r/App/b.cs', '/r/App/Z/x.cs', '/r/App/a.json', '/r/App/a.Development.json', '/r/App/a.Development.local.json', '/r/App/A2.cs',
    ), [], { showAllFiles: false });
    const rest = out.slice(1);
    expect(labels(rest)).toEqual(['Z', 'a.json', 'A2.cs', 'b.cs']);
    expect(rest[0].id).toBe('folder:/r/App/Z');
    expect(labels(rest[1].children!)).toEqual(['a.Development.json', 'a.Development.local.json']);
    expect(rest[1].children!.every((c) => !c.children)).toBe(true);
  });
  it('linked item placed by Link and flagged missing', () => {
    const out = buildProjectChildren(proj, info, ev({ fullPath: '/r/Shared/S.cs', link: 'Linked\\S.cs' }), [],
      { showAllFiles: false, exists: () => false });
    const folder = out[1];
    expect(folder.label).toBe('Linked');
    expect(folder.contextValue).toBe('cw.folder.virtual');
    expect(folder.children![0]).toMatchObject({ label: 'S.cs', missing: true, contextValue: 'cw.file.linked.missing', id: 'file:/r/Shared/S.cs' });
  });
  it('unlinked item outside the project dir sits at the root under its file name', () => {
    const out = buildProjectChildren(proj, info, ev('/r/Shared/Ext.cs'), [], { showAllFiles: false });
    expect(labels(out.slice(1))).toEqual(['Ext.cs']);
    expect(out[1].missing).toBeUndefined();
    expect(out[1].contextValue).toBe('cw.file.linked');
  });
  it('a Link that escapes the project creates no .. node and sits at the root by file name', () => {
    const out = buildProjectChildren(proj, info, ev({ fullPath: '/r/Shared/X.cs', link: '..\\Shared\\X.cs' }), [],
      { showAllFiles: false, exists: () => true });
    const all = (ns: TreeNode[]): TreeNode[] => ns.flatMap((n) => [n, ...all(n.children ?? [])]);
    expect(all(out).filter((n) => n.label === '..' || n.label === '.')).toEqual([]);
    expect(out.slice(1)).toEqual([expect.objectContaining({ label: 'X.cs', kind: 'file', contextValue: 'cw.file.linked', path: '/r/Shared/X.cs' })]);
  });
  it('a Link with . and inner .. segments is normalised', () => {
    const out = buildProjectChildren(proj, info, ev({ fullPath: '/r/Shared/X.cs', link: '.\\A\\..\\B\\.\\X.cs' }), [],
      { showAllFiles: false, exists: () => true });
    expect(labels(out.slice(1))).toEqual(['B']);
    expect(out[1]).toMatchObject({ contextValue: 'cw.folder.virtual', path: '/r/App/B' });
    expect(labels(out[1].children!)).toEqual(['X.cs']);
  });
  it('a folder holding real files stays a plain folder even when it also holds links', () => {
    const out = buildProjectChildren(proj, info, ev('/r/App/Shared/Own.cs', { fullPath: '/r/Shared/S.cs', link: 'Shared/S.cs' }), [],
      { showAllFiles: false, exists: () => true });
    expect(out[1]).toMatchObject({ label: 'Shared', contextValue: 'cw.folder' });
    const by = Object.fromEntries(out[1].children!.map((c) => [c.label, c.contextValue]));
    expect(by).toEqual({ 'Own.cs': 'cw.file', 'S.cs': 'cw.file.linked' });
  });
  it('showAllFiles adds excluded files', () => {
    const args = [proj, info, ev('/r/App/A.cs'), [] as PackageRef[]] as const;
    const files = ['/r/App/A.cs', '/r/App/bin/x.dll'];
    expect(labels(buildProjectChildren(...args, { showAllFiles: false, allFiles: files }).slice(1))).toEqual(['A.cs']);
    const out = buildProjectChildren(...args, { showAllFiles: true, allFiles: files }).slice(1);
    expect(labels(out)).toEqual(['bin', 'A.cs']);
    expect(out[0].children![0]).toMatchObject({ label: 'x.dll', description: 'excluded', contextValue: 'cw.file.excluded' });
  });
  it('unevaluated project shows warning node first', () => {
    const out = buildProjectChildren(proj, info, { evaluated: false, items: [{ fullPath: '/r/App/A.cs' }], error: 'boom' }, [], { showAllFiles: false });
    expect(out[0]).toMatchObject({ kind: 'warning', id: `warning:${P}`, label: 'Could not evaluate project — showing files on disk' });
    expect(out[1].kind).toBe('dependencies');
  });
});
