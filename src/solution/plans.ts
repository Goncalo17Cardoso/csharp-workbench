import { dirname, extname, join, resolve } from 'node:path';
import type { ProjectInfoData, SolutionModel, SolutionProject } from './model';
import { validateName, type NameError } from './commands/files';

/** Pure plans and helpers for the project / solution folder / reference commands; no `vscode` imports. */

export interface Step { op: 'slnAdd' | 'slnRemove' | 'addRef' | 'removeRef' | 'renameFile'; args: string[] }

/** `--solution-folder` value for a folder, e.g. `src/web`. */
export function folderPathOf(model: SolutionModel, folderId: string): string {
  const names: string[] = [];
  const seen = new Set<string>();
  for (let id: string | undefined = folderId; id && !seen.has(id);) {
    seen.add(id);
    const f = model.folders.find((x) => x.id === id);
    if (!f) break;
    names.unshift(f.name);
    id = f.parentId;
  }
  return names.join('/');
}

export function planRenameProject(model: SolutionModel, projectPath: string, newName: string, dependents: string[]): Step[] {
  const neu = join(dirname(projectPath), `${newName}.csproj`);
  const folderId = model.projects.find((p) => p.path === projectPath)?.folderId;
  const folder = folderId ? folderPathOf(model, folderId) : '';
  return [
    { op: 'slnRemove', args: [projectPath] },
    ...dependents.map((d): Step => ({ op: 'removeRef', args: [d, projectPath] })),
    { op: 'renameFile', args: [projectPath, neu] },
    { op: 'slnAdd', args: folder ? [neu, folder] : [neu] },
    ...dependents.map((d): Step => ({ op: 'addRef', args: [d, neu] })),
  ];
}

export function planRemoveFolder(model: SolutionModel, folderId: string): { projectRemovals: string[]; folderIdsBottomUp: string[] } {
  const ids: string[] = []; // pre-order
  const walk = (id: string) => {
    if (ids.includes(id)) return;
    ids.push(id);
    for (const f of model.folders) if (f.parentId === id) walk(f.id);
  };
  walk(folderId);
  const set = new Set(ids);
  return {
    projectRemovals: model.projects.filter((p) => p.folderId && set.has(p.folderId)).map((p) => p.path),
    folderIdsBottomUp: ids.reverse(),
  };
}

const same = (a: string, b: string) => resolve(a) === resolve(b);

export function dependentsOf(infos: ProjectInfoData[], projectPath: string): string[] {
  return infos.filter((i) => i.projectRefs.some((r) => same(r, projectPath))).map((i) => i.path);
}

/** Folder id from a `solutionFolder:<sln>|<id>` tree node id. */
export const solutionFolderId = (nodeId: string, solutionPath: string): string =>
  nodeId.slice(`solutionFolder:${solutionPath}|`.length);

/** Same rules as file names; `exists` tells whether the name collides. */
export const validateProjectName = (name: string, exists: (name: string) => boolean): NameError['code'] | undefined =>
  validateName(name, exists)?.code;

/** Projects the target may reference: not itself, not already referenced, and not referencing it (direct cycle). */
export function referenceCandidates(projects: SolutionProject[], infos: ProjectInfoData[], targetPath: string): SolutionProject[] {
  const own = infos.find((i) => same(i.path, targetPath))?.projectRefs ?? [];
  return projects.filter((p) => {
    if (same(p.path, targetPath) || own.some((r) => same(r, p.path))) return false;
    const info = infos.find((i) => same(i.path, p.path));
    return !info?.projectRefs.some((r) => same(r, targetPath));
  });
}

/** The project file `dotnet new` created: the expected path, else the only .csproj found under the output dir. */
export function locateCsproj(expected: string, files: string[]): string | undefined {
  if (files.includes(expected)) return expected;
  const found = files.filter((f) => extname(f).toLowerCase() === '.csproj');
  return found.length === 1 ? found[0] : undefined;
}

/** Runs steps in order; stops at the first failure (no rollback) and reports its index. */
export async function executePlan(steps: Step[], run: (s: Step) => Promise<void>): Promise<{ failedAt?: number; error?: unknown }> {
  for (let i = 0; i < steps.length; i++) {
    try { await run(steps[i]); } catch (error) { return { failedAt: i, error }; }
  }
  return {};
}
