import { dirname, join } from 'path';
import type { DotnetCli } from '../dotnet/cli';
import type { ProjectInfo, ProjectPackages, SolutionState, Target } from '../core/types';
import { findCentralPackagesFile, readCpm, readPackageRefs } from '../workspace/projectFiles';

export interface StateFs {
  readFile(p: string): Promise<string>;
  exists(p: string): Promise<boolean>;
}

/** Fast pass: files only. */
export async function loadFastState(
  target: Target,
  projects: ProjectInfo[],
  fs: StateFs,
): Promise<SolutionState> {
  const loaded: ProjectPackages[] = [];
  for (const project of projects) {
    loaded.push({ project, packages: readPackageRefs(await fs.readFile(project.path)) });
  }
  let cpm: SolutionState['cpm'];
  if (projects.length) {
    const props = await findCentralPackagesFile(dirname(projects[0].path), fs.exists, '/');
    if (props) cpm = readCpm(await fs.readFile(props), props);
  }
  return { target, projects: loaded, cpm };
}

/** Confirmed pass: restore if needed, then `dotnet list package`. Errors propagate. */
export async function loadConfirmedState(
  target: Target,
  fast: SolutionState,
  cli: Pick<DotnetCli, 'listPackages' | 'restore'>,
  fs: StateFs,
): Promise<SolutionState> {
  let needsRestore = false;
  for (const p of fast.projects) {
    if (!(await fs.exists(join(dirname(p.project.path), 'obj', 'project.assets.json')))) {
      needsRestore = true;
      break;
    }
  }
  if (needsRestore) await cli.restore(target.path);
  const listed = new Map((await cli.listPackages(target.path)).map((p) => [p.project.path, p]));
  const projects = fast.projects.map((fp) => {
    const hit = listed.get(fp.project.path);
    if (!hit) return fp;
    const overrides = new Map(
      fp.packages.filter((r) => r.versionOverride).map((r) => [r.id.toLowerCase(), r.versionOverride!]),
    );
    return {
      project: fp.project,
      packages: hit.packages.map((r) => {
        const vo = overrides.get(r.id.toLowerCase());
        return vo ? { ...r, versionOverride: vo } : r;
      }),
    };
  });
  return { target, projects, cpm: fast.cpm };
}
