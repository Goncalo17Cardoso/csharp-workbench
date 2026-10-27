import { describe, expect, it } from 'vitest';
import { buildConsolidateRows, buildInstalledRows, buildUpdateRows } from '../../../src/state/viewModel';
import type { SolutionState } from '../../../src/core/types';

const P = (n: string) => `/s/${n}.csproj`;
const proj = (n: string, packages: any[]) => ({ project: { path: P(n), name: n }, packages });
const mk = (projects: SolutionState['projects'], cpm?: Record<string, string>): SolutionState => ({
  target: { kind: 'sln', path: '/s/a.sln', name: 'a' }, projects,
  cpm: cpm ? { propsPath: '/s/Directory.Packages.props', versions: new Map(Object.entries(cpm)) } : undefined,
});

describe('view model', () => {
  it('groups same id across projects case-insensitively', () => {
    const rows = buildInstalledRows(mk([
      proj('B', [{ id: 'serilog', resolved: '3.0.0' }, { id: 'Alpha', requested: '1.0.0' }]),
      proj('A', [{ id: 'Serilog', resolved: '2.0.0' }]),
    ]));
    expect(rows.map((r) => r.id)).toEqual(['Alpha', 'serilog']);
    expect(rows[1].versions).toEqual({ [P('B')]: '3.0.0', [P('A')]: '2.0.0' });
  });

  it('multi-target shows joined distinct versions', () => {
    const [row] = buildInstalledRows(mk([proj('A', [
      { id: 'X', resolved: '1.0.0', framework: 'net8.0' },
      { id: 'X', resolved: '2.0.0', framework: 'net9.0' },
      { id: 'X', resolved: '2.0.0', framework: 'net10.0' },
    ])]));
    expect(row.versions[P('A')]).toBe('1.0.0, 2.0.0');
  });

  it('installed rows carry central version and overrides', () => {
    const [row] = buildInstalledRows(mk([
      proj('B', [{ id: 'X', resolved: '2.0.0', versionOverride: '2.0.0' }]),
      proj('A', [{ id: 'X', resolved: '1.0.0' }]),
    ], { x: '1.0.0' }));
    expect(row.central).toBe('1.0.0');
    expect(row.overrides).toEqual([P('B')]);
  });

  it('updates merge projects and pick latest', () => {
    const rows = buildUpdateRows([
      proj('B', [{ id: 'X', resolved: '1.0.0', latest: '3.0.0' }, { id: 'Same', resolved: '1.0.0', latest: '1.0.0' }]),
      proj('A', [{ id: 'x', requested: '2.0.0', latest: '2.5.0' }]),
    ]);
    expect(rows).toEqual([{ id: 'X', current: ['1.0.0', '2.0.0'], latest: '3.0.0', projects: [P('A'), P('B')] }]);
  });

  it('consolidate lists only packages with differing versions', () => {
    const rows = buildConsolidateRows(mk([
      proj('A', [{ id: 'X', resolved: '1.0.0' }, { id: 'Y', resolved: '1.0.0' }]),
      proj('B', [{ id: 'x', resolved: '1.10.0' }, { id: 'Y', resolved: '1.0.0' }]),
    ]));
    expect(rows).toEqual([{ id: 'X', versions: { [P('A')]: '1.0.0', [P('B')]: '1.10.0' }, target: '1.10.0' }]);
  });

  it('consolidate under cpm lists only overrides', () => {
    const rows = buildConsolidateRows(mk([
      proj('A', [{ id: 'X', resolved: '1.0.0' }, { id: 'Y', resolved: '1.0.0' }]),
      proj('B', [{ id: 'X', resolved: '2.0.0', versionOverride: '2.0.0' }, { id: 'Y', resolved: '1.0.0' }]),
    ], { x: '1.0.0', y: '1.0.0' }));
    expect(rows.map((r) => r.id)).toEqual(['X']);
    expect(rows[0].target).toBe('2.0.0');
  });
});
