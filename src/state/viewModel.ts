import { compareVersions, maxVersion } from '../core/version';
import type { PackageRef, ProjectPackages, SolutionState } from '../core/types';

export interface InstalledRow { id: string; versions: Record<string, string>; central?: string; overrides: string[] }
export interface UpdateRow { id: string; current: string[]; latest: string; projects: string[] }
export interface ConsolidateRow { id: string; versions: Record<string, string>; target: string }

const byId = (a: { id: string }, b: { id: string }) =>
  a.id.toLowerCase().localeCompare(b.id.toLowerCase());
const current = (r: PackageRef) => r.versionOverride ?? r.resolved ?? r.requested ?? '';
const distinct = (xs: string[]) => [...new Set(xs)];

/** Groups refs by lowercase id; display id comes from the first project that has it. */
function group(projects: ProjectPackages[]) {
  const map = new Map<string, { id: string; refs: { path: string; ref: PackageRef }[] }>();
  for (const p of projects) {
    for (const ref of p.packages) {
      const key = ref.id.toLowerCase();
      let g = map.get(key);
      if (!g) map.set(key, (g = { id: ref.id, refs: [] }));
      g.refs.push({ path: p.project.path, ref });
    }
  }
  return [...map.entries()].map(([key, g]) => ({ key, ...g }));
}

function versionsByProject(refs: { path: string; ref: PackageRef }[]): Record<string, string> {
  const per = new Map<string, string[]>();
  for (const { path, ref } of refs) per.set(path, [...(per.get(path) ?? []), current(ref)]);
  return Object.fromEntries([...per].map(([path, vs]) => [path, distinct(vs).join(', ')]));
}

export function buildInstalledRows(state: SolutionState): InstalledRow[] {
  return group(state.projects)
    .map((g) => ({
      id: g.id,
      versions: versionsByProject(g.refs),
      central: state.cpm?.versions.get(g.key),
      overrides: distinct(g.refs.filter((r) => r.ref.versionOverride).map((r) => r.path)).sort(),
    }))
    .sort(byId);
}

export function buildUpdateRows(outdated: ProjectPackages[]): UpdateRow[] {
  const rows: UpdateRow[] = [];
  for (const g of group(outdated)) {
    const hits = g.refs.filter(({ ref }) => ref.latest && compareVersions(ref.latest, current(ref)) > 0);
    if (!hits.length) continue;
    rows.push({
      id: g.id,
      current: distinct(hits.map((h) => current(h.ref))).sort(),
      latest: maxVersion(hits.map((h) => h.ref.latest!))!,
      projects: distinct(hits.map((h) => h.path)).sort(),
    });
  }
  return rows.sort(byId);
}

export function buildConsolidateRows(state: SolutionState): ConsolidateRow[] {
  const rows: ConsolidateRow[] = [];
  for (const g of group(state.projects)) {
    const versions = versionsByProject(g.refs);
    const all = distinct(Object.values(versions).flatMap((v) => v.split(', ')).filter(Boolean));
    const include = state.cpm
      ? g.refs.some((r) => r.ref.versionOverride)
      : all.length > 1;
    if (!include) continue;
    rows.push({ id: g.id, versions, target: maxVersion(all) ?? '' });
  }
  return rows.sort(byId);
}
