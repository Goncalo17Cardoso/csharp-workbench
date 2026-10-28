import { dirname, extname, relative, resolve, isAbsolute } from 'node:path';
import type { PackageRef, Target } from '../core/types';
import { selectTargets } from '../workspace/targets';
import type { ProjectInfoData, ProjectItems, SolutionModel, SolutionProject, TreeNode } from './model';
import { buildProjectChildren, buildSolutionNodes } from './tree';

export interface TreeCoreDeps {
  /** All sln/slnx/csproj files in the workspace. */
  discover(): Promise<string[]>;
  loadSolution(path: string): Promise<SolutionModel>;
  loadProjectInfo(projectPath: string): Promise<ProjectInfoData>;
  loadProjectItems(projectPath: string): Promise<ProjectItems>;
  loadPackages(projectPath: string): Promise<PackageRef[]>;
  walk(dir: string): Promise<string[]>;
  fileExists(path: string): Promise<boolean>;
  state: { selectedSolution(): string | undefined; startupProject(solutionPath: string): string | undefined };
}

/** What a watcher event affects: null = the whole tree, a node = that node only, undefined = nothing. */
export type Invalidation = TreeNode | null | undefined;

const norm = (p: string) => p.replace(/\\/g, '/');
const inside = (dir: string, p: string) => {
  const r = relative(dir, p);
  return r === '' || (!r.startsWith('..') && !isAbsolute(r));
};

export class SolutionTreeCore {
  private showAll = false;
  private model: SolutionModel | undefined;
  private projects: SolutionProject[] = [];
  private rootsPromise: Promise<TreeNode[]> | undefined;
  private targetsPromise: Promise<Target[]> | undefined;
  private readonly cache = new Map<string, Promise<TreeNode[]>>();
  private readonly projectNodes = new Map<string, TreeNode>();
  private readonly parents = new Map<TreeNode, TreeNode>();

  constructor(private readonly deps: TreeCoreDeps) {}

  get showAllFiles(): boolean { return this.showAll; }
  get solutionPath(): string | undefined { return this.model?.path; }

  targets(): Promise<Target[]> {
    this.targetsPromise ??= this.deps.discover().then(selectTargets);
    this.targetsPromise.catch(() => { this.targetsPromise = undefined; });
    return this.targetsPromise;
  }

  roots(): Promise<TreeNode[]> {
    if (!this.rootsPromise) {
      const mine: Promise<TreeNode[]> = this.buildRoots(() => this.rootsPromise === mine);
      this.rootsPromise = mine;
      mine.catch(() => { if (this.rootsPromise === mine) this.rootsPromise = undefined; });
    }
    return this.rootsPromise;
  }

  private async buildRoots(isCurrent: () => boolean): Promise<TreeNode[]> {
    await Promise.resolve(); // let roots() publish this promise before isCurrent() is consulted
    const targets = await this.targets();
    const sols = targets.filter((t) => t.kind !== 'csproj');
    let nodes: TreeNode[] = [];
    let model: SolutionModel | undefined;
    let projects: SolutionProject[] = [];
    if (sols.length > 0) {
      const chosen = sols.find((s) => s.path === this.deps.state.selectedSolution()) ?? sols[0];
      try {
        model = await this.deps.loadSolution(chosen.path);
        projects = model.projects;
        nodes = buildSolutionNodes(model, { startupProject: this.deps.state.startupProject(chosen.path) });
      } catch (e) {
        nodes = [{
          id: `warning:${chosen.path}`, kind: 'warning', contextValue: 'cw.warning', path: chosen.path,
          label: 'Could not read solution', description: e instanceof Error ? e.message : String(e),
        }];
      }
    } else {
      projects = targets.map((t) => ({ path: t.path, name: t.name }));
      nodes = projects.map((p) => ({
        id: `project:${p.path}`, kind: 'project' as const, label: p.name, path: p.path,
        projectPath: p.path, contextValue: 'cw.project',
      }));
    }
    if (!isCurrent()) return nodes; // superseded by a reset: do not touch shared state
    this.parents.clear();
    this.projectNodes.clear();
    this.model = model;
    this.projects = projects;
    for (const n of nodes) this.register(n);
    return nodes;
  }

  private register(n: TreeNode): void {
    if (n.kind === 'project' && n.projectPath) this.projectNodes.set(n.projectPath, n);
    for (const c of n.children ?? []) { this.parents.set(c, n); this.register(c); }
  }

  async children(node: TreeNode): Promise<TreeNode[]> {
    if (node.kind === 'project' && node.projectPath) {
      let p = this.cache.get(node.projectPath);
      if (!p) {
        p = this.loadProject(node);
        this.cache.set(node.projectPath, p);
        const key = node.projectPath;
        p.catch(() => { if (this.cache.get(key) === p) this.cache.delete(key); });
      }
      return p;
    }
    return node.children ?? [];
  }

  getParent(node: TreeNode): TreeNode | undefined { return this.parents.get(node); }

  private async loadProject(node: TreeNode): Promise<TreeNode[]> {
    const pp = node.projectPath!;
    const project = this.projects.find((p) => p.path === pp) ?? { path: pp, name: node.label };
    const fallbackInfo: ProjectInfoData = {
      path: pp, rootNamespace: node.label, targetFrameworks: [], projectRefs: [], fileScopedNamespaces: false,
    };
    const [info, items, packages] = await Promise.all([
      this.deps.loadProjectInfo(pp).catch(() => fallbackInfo),
      this.deps.loadProjectItems(pp),
      this.deps.loadPackages(pp).catch(() => [] as PackageRef[]),
    ]);
    // Unevaluated items already come from the disk walk; walk again only to list excluded files.
    const allFiles = this.showAll ? (await this.deps.walk(dirname(pp)).catch(() => [])).map((f) => norm(resolve(f))) : [];
    const linked = items.items.filter((i) => i.link);
    const present = new Set<string>();
    await Promise.all(linked.map(async (i) => { if (await this.deps.fileExists(i.fullPath)) present.add(i.fullPath); }));
    const kids = buildProjectChildren(project, info, items, packages, {
      showAllFiles: this.showAll, allFiles, exists: (p) => present.has(p),
    });
    for (const c of kids) { this.parents.set(c, node); this.register(c); }
    return kids;
  }

  setShowAllFiles(b: boolean): void {
    this.showAll = b;
    this.cache.clear();
  }

  /** Forces a full reload on the next roots(). */
  reset(): void {
    this.rootsPromise = undefined;
    this.targetsPromise = undefined;
    this.cache.clear();
  }

  projectForPath(p: string): SolutionProject | undefined {
    let best: SolutionProject | undefined;
    for (const pr of this.projects) {
      if (pr.path === p || inside(dirname(pr.path), p)) {
        if (!best || dirname(pr.path).length > dirname(best.path).length) best = pr;
      }
    }
    return best;
  }

  /** `structural` marks a file create/delete, which matters for .csproj files. */
  invalidate(p: string, structural = false): Invalidation {
    const ext = extname(p).toLowerCase();
    if (ext === '.sln' || ext === '.slnx' || (ext === '.csproj' && structural)) {
      this.reset();
      return null;
    }
    const pr = this.projectForPath(p);
    if (!pr) return undefined;
    this.cache.delete(pr.path);
    return this.projectNodes.get(pr.path);
  }

  async nodeForPath(p: string): Promise<TreeNode | undefined> {
    await this.roots();
    const pr = this.projectForPath(p);
    if (!pr) return undefined;
    const projNode = this.projectNodes.get(pr.path);
    if (!projNode) return undefined;
    if (pr.path === p) return projNode;
    const find = (nodes: TreeNode[]): TreeNode | undefined => {
      for (const n of nodes) {
        if (n.path === p && (n.kind === 'file' || n.kind === 'folder')) return n;
        const hit = n.children && find(n.children);
        if (hit) return hit;
      }
      return undefined;
    };
    return find(await this.children(projNode));
  }
}
