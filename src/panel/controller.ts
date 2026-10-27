import { dirname } from 'node:path';
import type { PackageSource, ProjectInfo, SolutionState, Target } from '../core/types';
import { maxVersion } from '../core/version';
import type { DotnetCli } from '../dotnet/cli';
import { DotnetError } from '../dotnet/exec';
import { detailsFirst, searchAll, versionsAll } from '../nuget/aggregate';
import type { FeedClient } from '../nuget/feeds/types';
import { executePlan, planOperation } from '../ops/operations';
import { loadConfirmedState, loadFastState, type StateFs } from '../state/loadState';
import { buildConsolidateRows, buildInstalledRows, buildUpdateRows } from '../state/viewModel';
import type { ToHost, ToWebview } from './protocol';

export interface ControllerDeps {
  cli: DotnetCli;
  fs: StateFs;
  targets: Target[];
  target: Target;
  projects: ProjectInfo[];
  preselectProject?: string;
  sources: { name: string; warning?: string }[];
  feeds(source: string): { source: PackageSource; client: FeedClient }[];
  post(m: ToWebview): void;
  confirm(summary: string, affected: string[]): Promise<boolean>;
  openOutput(): void;
  switchTarget(path: string): void;
  onPost?(m: ToWebview, t: number): void;
}

export class PanelController {
  private state: SolutionState | undefined;
  private _busy = false;

  constructor(private deps: ControllerDeps) {}

  get busy(): boolean { return this._busy; }

  private post(m: ToWebview): void {
    this.deps.post(m);
    this.deps.onPost?.(m, Date.now());
  }

  private async fail(e: unknown, stderr?: string): Promise<void> {
    const err = e instanceof Error ? e : new Error(String(e));
    const text = stderr ?? (e instanceof DotnetError ? e.stderr : '');
    let message = err.message;
    if (text.includes('PackageSourceMapping')) {
      let first: string | undefined;
      try {
        first = (await this.deps.cli.configPaths(dirname(this.deps.target.path)))[0];
      } catch { /* path unknown */ }
      message += `\nPackage source mapping blocked this package. Add a mapping in ${first ?? 'your nuget.config'}.`;
    }
    this.post({ type: 'busy', label: null });
    this.post({ type: 'error', message, canOpenOutput: true });
  }

  async handle(msg: ToHost): Promise<void> {
    try {
      switch (msg.type) {
        case 'ready':
          this.post({
            type: 'init', targets: this.deps.targets, current: this.deps.target, projects: this.deps.projects,
            sources: this.deps.sources, preselectProject: this.deps.preselectProject,
          });
          await this.load();
          return;
        case 'refresh': return await this.load();
        case 'search': {
          const r = await searchAll(this.deps.feeds(msg.source), msg.query, { prerelease: msg.prerelease, skip: msg.skip, take: 20 });
          this.post({ type: 'searchResults', results: r.results, failures: r.failures, append: msg.skip > 0 });
          return;
        }
        case 'selectPackage': {
          const clients = this.deps.feeds(msg.source);
          const versions = await versionsAll(clients, msg.id, msg.prerelease);
          const details = await detailsFirst(clients, msg.id, maxVersion(versions) ?? '');
          this.post({ type: 'details', details, versions, perProject: this.perProject(msg.id) });
          return;
        }
        case 'selectVersion': {
          const details = await detailsFirst(this.deps.feeds('All'), msg.id, msg.version);
          this.post({ type: 'details', details, versions: [], perProject: this.perProject(msg.id) });
          return;
        }
        case 'run': return await this.run(msg.request);
        case 'switchTarget': this.deps.switchTarget(msg.path); return;
        case 'openOutput': this.deps.openOutput(); return;
      }
    } catch (e) {
      await this.fail(e);
    }
  }

  private perProject(id: string): Record<string, string | null> {
    const row = this.state ? buildInstalledRows(this.state).find((r) => r.id.toLowerCase() === id.toLowerCase()) : undefined;
    return Object.fromEntries(this.deps.projects.map((p) => [p.path, row?.versions[p.path] ?? null]));
  }

  private async load(): Promise<void> {
    const wasBusy = this._busy;
    this._busy = true;
    try {
      const { target, projects, fs, cli } = this.deps;
      const fast = await loadFastState(target, projects, fs);
      this.state = fast;
      this.post({ type: 'installed', rows: buildInstalledRows(fast), confirmed: false });
      const confirmedP = loadConfirmedState(target, fast, cli, fs).then((s) => {
        this.state = s;
        this.post({ type: 'installed', rows: buildInstalledRows(s), confirmed: true });
        this.post({ type: 'consolidate', rows: buildConsolidateRows(s), cpm: !!s.cpm });
      });
      const updatesP = cli.listPackages(target.path, { outdated: true }).then((o) => {
        this.post({ type: 'updates', rows: buildUpdateRows(o) });
      });
      const [a, b] = await Promise.allSettled([confirmedP, updatesP]);
      const failed = a.status === 'rejected' ? a : b.status === 'rejected' ? b : undefined;
      if (failed) throw failed.reason;
    } finally {
      this._busy = wasBusy;
    }
  }

  private async run(request: Parameters<typeof planOperation>[0]): Promise<void> {
    if (this._busy) return;
    this._busy = true;
    try {
      if (!this.state) this.state = await loadFastState(this.deps.target, this.deps.projects, this.deps.fs);
      const plan = planOperation(request, this.state);
      if (!(await this.deps.confirm(plan.summary, plan.affectsAllProjects))) return;
      this.post({ type: 'busy', label: plan.summary });
      const result = await executePlan(plan, this.deps.cli, (done, total) =>
        this.post({ type: 'busy', label: plan.summary, progress: { done, total } }));
      if (!result.ok) {
        const e = new Error(result.error?.message ?? 'Operation failed');
        await this.fail(e, result.error?.stderr);
        return;
      }
      this.post({ type: 'opResult', ok: true, message: plan.summary });
      await this.load();
      this.post({ type: 'busy', label: null });
    } catch (e) {
      await this.fail(e);
    } finally {
      this._busy = false;
    }
  }
}
