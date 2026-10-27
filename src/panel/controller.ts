import { dirname } from 'node:path';
import type { PackageSource, ProjectInfo, SolutionState, Target } from '../core/types';
import { isPrerelease, maxVersion } from '../core/version';
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
  private loads = 0;
  private running = false;
  private versions: { id: string; source: string; versions: string[] } | undefined;

  constructor(private deps: ControllerDeps) {}

  get busy(): boolean { return this.running || this.loads > 0; }

  private post(m: ToWebview): void {
    this.deps.post(m);
    this.deps.onPost?.(m, Date.now());
  }

  /** Error text shown to the user; adds the source-mapping hint when dotnet's output mentions it. */
  private async errorText(message: string, output: string): Promise<string> {
    if (!`${output}\n${message}`.includes('PackageSourceMapping')) return message;
    let first: string | undefined;
    try {
      first = (await this.deps.cli.configPaths(dirname(this.deps.target.path)))[0];
    } catch { /* path unknown */ }
    return `${message}\nPackage source mapping blocked this package. Add a mapping in ${first ?? 'your nuget.config'}.`;
  }

  private async fail(e: unknown, output?: string): Promise<void> {
    const err = e instanceof Error ? e : new Error(String(e));
    const text = output ?? (e instanceof DotnetError ? `${e.stderr}\n${e.stdout}` : '');
    this.postError(await this.errorText(err.message, text));
  }

  private postError(message: string): void {
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
          this.versions = { id: msg.id.toLowerCase(), source: msg.source, versions };
          const version = msg.version && versions.includes(msg.version) ? msg.version : maxVersion(versions) ?? '';
          const details = await detailsFirst(clients, msg.id, version);
          this.post({ type: 'details', details, versions, ...this.installedIn(msg.id) });
          return;
        }
        case 'selectVersion': {
          // Resend the list from the last selectPackage so the dropdown keeps every version.
          const cached = this.versions?.id === msg.id.toLowerCase() ? this.versions : undefined;
          const clients = this.deps.feeds(cached?.source ?? 'All');
          const versions = cached?.versions ?? await versionsAll(clients, msg.id, isPrerelease(msg.version));
          const details = await detailsFirst(clients, msg.id, msg.version);
          this.post({ type: 'details', details, versions, ...this.installedIn(msg.id) });
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

  /** Version per project (null when not referenced) and the projects that use a VersionOverride. */
  private installedIn(id: string): { perProject: Record<string, string | null>; overrides: string[] } {
    const row = this.state ? buildInstalledRows(this.state).find((r) => r.id.toLowerCase() === id.toLowerCase()) : undefined;
    const version = (p: string): string | null => {
      if (!row || !(p in row.versions)) return null;
      return row.versions[p] || row.central || null;
    };
    return {
      perProject: Object.fromEntries(this.deps.projects.map((p) => [p.path, version(p.path)])),
      overrides: row?.overrides ?? [],
    };
  }

  private idleWaiters: (() => void)[] = [];

  /** Resolves once no load is in flight. */
  private async loadsIdle(): Promise<void> {
    while (this.loads > 0) await new Promise<void>((r) => this.idleWaiters.push(r));
  }

  private async load(): Promise<void> {
    this.loads++;
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
      this.loads--;
      if (this.loads === 0) this.idleWaiters.splice(0).forEach((r) => r());
    }
  }

  /**
   * Runs one operation. Loads in flight are awaited (not rejected); another run in flight is rejected.
   * The final messages are posted after `running` is cleared and the post-operation reload finished,
   * so a webview that sends the next run on `opResult` is never refused.
   */
  private async run(request: Parameters<typeof planOperation>[0]): Promise<void> {
    if (this.running) {
      this.post({ type: 'opResult', ok: false, message: 'Another operation is in progress.' });
      return;
    }
    this.running = true;
    let final: () => Promise<void> | void;
    try {
      final = await this.execute(request);
    } catch (e) {
      final = () => this.fail(e);
    } finally {
      this.running = false;
    }
    await final();
  }

  /** Does the work of `run` and returns what to post once the run is over. */
  private async execute(request: Parameters<typeof planOperation>[0]): Promise<() => Promise<void> | void> {
    await this.loadsIdle();
    if (!this.state) this.state = await loadFastState(this.deps.target, this.deps.projects, this.deps.fs);
    const plan = planOperation(request, this.state);
    if (!(await this.deps.confirm(plan.summary, plan.affectsAllProjects))) {
      return () => this.post({ type: 'opResult', ok: false, message: 'Cancelled.' });
    }
    this.post({ type: 'busy', label: plan.summary });
    const result = await executePlan(plan, this.deps.cli, (done, total) =>
      this.post({ type: 'busy', label: plan.summary, progress: { done, total } }));
    if (!result.ok) {
      // Some steps may have changed project files: show the real state before reporting.
      try { await this.load(); } catch { /* the operation error is what the user needs */ }
      const total = plan.steps.length;
      let message = result.error?.message ?? 'Operation failed';
      if (result.completed > 0) message += `\n${result.completed} of ${total} steps completed.`;
      const text = await this.errorText(message, `${result.error?.stderr ?? ''}\n${result.error?.stdout ?? ''}`);
      return () => this.postError(text);
    }
    await this.load();
    return () => {
      this.post({ type: 'busy', label: null });
      this.post({ type: 'opResult', ok: true, message: plan.summary });
    };
  }
}
