import type { DotnetCli } from '../dotnet/cli';
import { DotnetError } from '../dotnet/exec';
import { compareVersions } from '../core/version';
import type { SolutionState } from '../core/types';

export type OperationKind = 'install' | 'update' | 'uninstall' | 'consolidate';
export interface OperationRequest { kind: OperationKind; packageId: string; version?: string; projects: string[] }
export type CliStep =
  | { op: 'add'; project: string; id: string; version: string }
  | { op: 'remove'; project: string; id: string };
export interface OperationPlan { steps: CliStep[]; affectsAllProjects: string[]; summary: string }
export interface OperationResult { ok: boolean; completed: number; error?: { message: string; stderr: string } }

const plural = (n: number) => `${n} project${n === 1 ? '' : 's'}`;

export function planOperation(req: OperationRequest, state: SolutionState): OperationPlan {
  const { kind, packageId: id } = req;
  const lid = id.toLowerCase();
  if (kind !== 'uninstall' && !req.version) throw new Error(`Version is required for ${kind}`);
  const version = req.version as string;

  const find = (p: SolutionState['projects'][number]) => p.packages.find((r) => r.id.toLowerCase() === lid);
  const referencing = state.projects.filter((p) => find(p));
  const refPaths = referencing.map((p) => p.project.path);
  const sortedRefs = [...refPaths].sort();
  const add = (project: string): CliStep => ({ op: 'add', project, id, version });
  const remove = (project: string): CliStep => ({ op: 'remove', project, id });
  const cpm = state.cpm;
  const central = cpm?.versions.get(lid);

  let steps: CliStep[] = [];
  let affects: string[] = [];
  let count: number;

  if (kind === 'uninstall') {
    steps = req.projects.filter((p) => refPaths.includes(p)).map(remove);
    count = steps.length;
  } else if (!cpm) {
    if (kind === 'consolidate') {
      const touched = referencing.filter((p) => {
        const v = find(p)!.requested ?? find(p)!.resolved;
        return !v || compareVersions(v, version) !== 0;
      });
      steps = touched.map((p) => add(p.project.path));
      count = steps.length;
    } else {
      steps = req.projects.map(add);
      count = steps.length;
    }
  } else if (kind === 'install') {
    steps = req.projects.map(add);
    if (central !== undefined && central !== version) {
      affects = [...new Set([...refPaths, ...req.projects])].sort();
    }
    count = steps.length;
  } else if (kind === 'update') {
    const target = referencing.find((p) => req.projects.includes(p.project.path)) ?? referencing[0];
    if (target) steps = [add(target.project.path)];
    affects = sortedRefs;
    count = affects.length;
  } else {
    const noOverride = referencing.find((p) => !find(p)!.versionOverride);
    if (central !== version && noOverride) steps.push(add(noOverride.project.path));
    for (const p of referencing) {
      if (find(p)!.versionOverride) steps.push(remove(p.project.path), add(p.project.path));
    }
    affects = sortedRefs;
    count = affects.length;
  }

  const summary =
    kind === 'install' ? `Install ${id} ${version} in ${plural(count)}`
    : kind === 'update' ? `Update ${id} to ${version} in ${plural(count)}${cpm ? ' (central version)' : ''}`
    : kind === 'uninstall' ? `Uninstall ${id} from ${plural(count)}`
    : `Consolidate ${id} to ${version} in ${plural(count)}`;
  return { steps, affectsAllProjects: affects, summary };
}

export async function executePlan(
  plan: OperationPlan,
  cli: DotnetCli,
  onProgress: (done: number, total: number) => void,
): Promise<OperationResult> {
  const total = plan.steps.length;
  let completed = 0;
  try {
    for (const s of plan.steps) {
      if (s.op === 'add') await cli.addPackage(s.project, s.id, s.version);
      else await cli.removePackage(s.project, s.id);
      completed++;
      onProgress(completed, total);
    }
    return { ok: true, completed };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, completed, error: { message, stderr: e instanceof DotnetError ? e.stderr : '' } };
  }
}
