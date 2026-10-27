import { describe, expect, it, vi } from 'vitest';
import { executePlan, planOperation, type OperationPlan } from '../../../src/ops/operations';
import { DotnetError } from '../../../src/dotnet/exec';
import type { SolutionState } from '../../../src/core/types';

const proj = (n: string, pkgs: { id: string; requested?: string; versionOverride?: string }[]) => ({
  project: { path: `/s/${n}.csproj`, name: n }, packages: pkgs,
});
const P = (n: string) => `/s/${n}.csproj`;
const mk = (projects: SolutionState['projects'], cpm?: Record<string, string>): SolutionState => ({
  target: { kind: 'sln', path: '/s/a.sln', name: 'a' }, projects,
  cpm: cpm ? { propsPath: '/s/Directory.Packages.props', versions: new Map(Object.entries(cpm)) } : undefined,
});

describe('planOperation', () => {
  it('install without cpm adds to each selected project', () => {
    const s = mk([proj('A', []), proj('B', []), proj('C', [])]);
    const p = planOperation({ kind: 'install', packageId: 'Serilog', version: '4.0.0', projects: [P('A'), P('C')] }, s);
    expect(p.steps).toEqual([
      { op: 'add', project: P('A'), id: 'Serilog', version: '4.0.0' },
      { op: 'add', project: P('C'), id: 'Serilog', version: '4.0.0' },
    ]);
    expect(p.affectsAllProjects).toEqual([]);
    expect(p.summary).toBe('Install Serilog 4.0.0 in 2 projects');
  });
  it('requires a version', () => {
    expect(() => planOperation({ kind: 'update', packageId: 'X', projects: [] }, mk([]))).toThrow('Version is required for update');
  });
  it('update with cpm issues a single add and lists all referencing projects as affected', () => {
    const s = mk([proj('B', [{ id: 'Serilog' }]), proj('A', [{ id: 'Serilog' }]), proj('C', [])], { serilog: '3.0.0' });
    const p = planOperation({ kind: 'update', packageId: 'Serilog', version: '4.2.0', projects: [P('A')] }, s);
    expect(p.steps).toEqual([{ op: 'add', project: P('A'), id: 'Serilog', version: '4.2.0' }]);
    expect(p.affectsAllProjects).toEqual([P('A'), P('B')]);
    expect(p.summary).toBe('Update Serilog to 4.2.0 in 2 projects (central version)');
  });
  it('install with cpm and different central version marks all referencing projects affected', () => {
    const s = mk([proj('A', [{ id: 'Serilog' }]), proj('B', [])], { serilog: '3.0.0' });
    const p = planOperation({ kind: 'install', packageId: 'Serilog', version: '4.0.0', projects: [P('B')] }, s);
    expect(p.steps).toHaveLength(1);
    expect(p.affectsAllProjects).toEqual([P('A'), P('B')]);
    const same = planOperation({ kind: 'install', packageId: 'Serilog', version: '3.0.0', projects: [P('B')] }, s);
    expect(same.affectsAllProjects).toEqual([]);
  });
  it('consolidate without cpm only touches projects on other versions', () => {
    const s = mk([proj('A', [{ id: 'Serilog', requested: '4.0.0' }]), proj('B', [{ id: 'Serilog', requested: '3.0.0' }])]);
    const p = planOperation({ kind: 'consolidate', packageId: 'Serilog', version: '4.0.0', projects: [P('A'), P('B')] }, s);
    expect(p.steps).toEqual([{ op: 'add', project: P('B'), id: 'Serilog', version: '4.0.0' }]);
    expect(p.summary).toBe('Consolidate Serilog to 4.0.0 in 1 project');
  });
  it('consolidate with cpm removes and re-adds projects with VersionOverride', () => {
    const s = mk([proj('A', [{ id: 'Serilog' }]), proj('B', [{ id: 'Serilog', versionOverride: '3.0.0' }])], { serilog: '3.5.0' });
    const p = planOperation({ kind: 'consolidate', packageId: 'Serilog', version: '4.0.0', projects: [P('A'), P('B')] }, s);
    expect(p.steps).toEqual([
      { op: 'add', project: P('A'), id: 'Serilog', version: '4.0.0' },
      { op: 'remove', project: P('B'), id: 'Serilog' },
      { op: 'add', project: P('B'), id: 'Serilog', version: '4.0.0' },
    ]);
    expect(p.affectsAllProjects).toEqual([P('A'), P('B')]);
  });
  it('consolidate without cpm leaves unselected projects alone', () => {
    const s = mk([proj('A', [{ id: 'Serilog', requested: '3.0.0' }]), proj('B', [{ id: 'Serilog', requested: '3.0.0' }])]);
    const p = planOperation({ kind: 'consolidate', packageId: 'Serilog', version: '4.0.0', projects: [P('A')] }, s);
    expect(p.steps).toEqual([{ op: 'add', project: P('A'), id: 'Serilog', version: '4.0.0' }]);
  });
  it('consolidate with cpm leaves unselected override projects alone', () => {
    const s = mk([proj('A', [{ id: 'Serilog' }]), proj('B', [{ id: 'Serilog', versionOverride: '3.0.0' }])], { serilog: '4.0.0' });
    const p = planOperation({ kind: 'consolidate', packageId: 'Serilog', version: '4.0.0', projects: [P('A')] }, s);
    expect(p.steps).toEqual([]);
  });
  it('uninstall removes from selected projects only', () => {
    const s = mk([proj('A', [{ id: 'Serilog' }]), proj('B', [{ id: 'Serilog' }]), proj('C', [])]);
    const p = planOperation({ kind: 'uninstall', packageId: 'Serilog', projects: [P('A'), P('C')] }, s);
    expect(p.steps).toEqual([{ op: 'remove', project: P('A'), id: 'Serilog' }]);
    expect(p.summary).toBe('Uninstall Serilog from 1 project');
  });
  it('package id match is case-insensitive', () => {
    const s = mk([proj('A', [{ id: 'Serilog' }])]);
    const p = planOperation({ kind: 'uninstall', packageId: 'serilog', projects: [P('A')] }, s);
    expect(p.steps).toEqual([{ op: 'remove', project: P('A'), id: 'serilog' }]);
  });
});

describe('executePlan', () => {
  it('stops at first failure and returns stderr', async () => {
    const plan: OperationPlan = {
      steps: [
        { op: 'add', project: 'a', id: 'X', version: '1' },
        { op: 'remove', project: 'b', id: 'X' },
        { op: 'remove', project: 'c', id: 'X' },
      ], affectsAllProjects: [], summary: '',
    };
    const cli = {
      addPackage: vi.fn().mockResolvedValue(undefined),
      removePackage: vi.fn().mockRejectedValue(new DotnetError('boom', [], 1, '', 'bad stderr')),
    };
    const onProgress = vi.fn();
    const r = await executePlan(plan, cli as never, onProgress);
    expect(r).toEqual({ ok: false, completed: 1, error: { message: 'boom', stderr: 'bad stderr' } });
    expect(onProgress).toHaveBeenCalledTimes(1);
    expect(onProgress).toHaveBeenCalledWith(1, 3);
    expect(cli.removePackage).toHaveBeenCalledTimes(1);
  });
  it('succeeds and reports non-dotnet errors with empty stderr', async () => {
    const plan: OperationPlan = { steps: [{ op: 'remove', project: 'a', id: 'X' }], affectsAllProjects: [], summary: '' };
    const ok = await executePlan(plan, { removePackage: vi.fn().mockResolvedValue(undefined) } as never, () => {});
    expect(ok).toEqual({ ok: true, completed: 1 });
    const bad = await executePlan(plan, { removePackage: vi.fn().mockRejectedValue(new Error('x')) } as never, () => {});
    expect(bad).toEqual({ ok: false, completed: 0, error: { message: 'x', stderr: '' } });
  });
});
