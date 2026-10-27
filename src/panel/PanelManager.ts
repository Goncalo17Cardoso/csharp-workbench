import * as fs from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import * as vscode from 'vscode';
import type { ProjectInfo, Target } from '../core/types';
import type { DotnetCli } from '../dotnet/cli';
import { loadEffectiveConfig } from '../nuget/config';
import { createFeedClient } from '../nuget/feeds';
import { createHttp } from '../nuget/http';
import { NugetPanel } from './NugetPanel';
import { PanelController } from './controller';
import type { ToHost, ToWebview } from './protocol';

/** Test-only hooks; production code never sets them. */
export interface PanelTestHooks {
  onPost?: (m: ToWebview, t: number) => void;
  confirmOverride?: () => Promise<boolean>;
}

interface Entry { panel: NugetPanel; controller: PanelController; watchers: vscode.Disposable[] }

export class PanelManager {
  private panels = new Map<string, Entry>();
  private opening = new Set<string>();

  constructor(
    private extensionUri: vscode.Uri,
    private cli: DotnetCli,
    private openOutput: () => void,
    private getTargets: () => Target[],
    private hooks: PanelTestHooks = {},
  ) {}

  /** Routes a message to the open panel's controller for a target (used by the integration tests). */
  async send(targetPath: string, msg: ToHost): Promise<void> {
    const e = this.panels.get(targetPath);
    if (!e) throw new Error(`No open panel for ${targetPath}`);
    await e.controller.handle(msg);
  }

  open(target: Target, opts: { preselectProject?: string } = {}): void {
    const existing = this.panels.get(target.path);
    if (existing) { existing.panel.reveal(); return; }
    if (this.opening.has(target.path)) return;
    this.opening.add(target.path);
    void this.create(target, opts)
      .catch((e) =>
        vscode.window.showErrorMessage(vscode.l10n.t('Could not open the NuGet manager: {0}', e instanceof Error ? e.message : String(e))))
      .finally(() => this.opening.delete(target.path));
  }

  dispose(): void {
    for (const e of [...this.panels.values()]) e.panel.dispose();
  }

  private async projectsOf(target: Target): Promise<ProjectInfo[]> {
    if (target.kind === 'csproj') return [{ path: target.path, name: basename(target.path).replace(/\.csproj$/i, '') }];
    return this.cli.slnList(target.path);
  }

  private async create(target: Target, opts: { preselectProject?: string }): Promise<void> {
    const projects = await this.projectsOf(target);
    const readFile = (p: string) => fs.readFile(p, 'utf8');
    const config = await loadEffectiveConfig(dirname(target.path), this.cli, readFile, process.env);
    const localFs = {
      readdir: (p: string) => fs.readdir(p),
      readFile: (p: string) => fs.readFile(p),
      stat: (p: string) => fs.stat(p),
    };
    const clients = config.sources.map((source) => ({
      source,
      client: createFeedClient(source, { http: createHttp(source), fs: localFs }),
    }));

    const controller = new PanelController({
      cli: this.cli,
      fs: { readFile, exists: (p) => fs.access(p).then(() => true, () => false) },
      targets: this.getTargets(), target, projects,
      preselectProject: opts.preselectProject,
      sources: config.sources.map((s) => ({ name: s.name, warning: s.warning })),
      feeds: (name) => (name === 'All' ? clients : clients.filter((c) => c.source.name === name)),
      post: (m) => entry.panel.post(m),
      onPost: (m, t) => this.hooks.onPost?.(m, t),
      confirm: async (summary, affected) =>
        this.hooks.confirmOverride ? this.hooks.confirmOverride() : (await vscode.window.showWarningMessage(
          summary,
          {
            modal: true,
            detail: affected.length
              ? vscode.l10n.t('This changes the central version used by:\n') + affected.join('\n')
              : undefined,
          },
          vscode.l10n.t('Apply'),
        )) === vscode.l10n.t('Apply'),
      openOutput: this.openOutput,
      switchTarget: (path) => {
        const next = this.getTargets().find((t) => t.path === path);
        if (!next) return;
        entry.panel.dispose();
        this.open(next);
      },
    });

    const panel = new NugetPanel(
      this.extensionUri,
      vscode.l10n.t('NuGet: {0}', target.name),
      (m) => void controller.handle(m),
      () => {
        entry.watchers.forEach((w) => w.dispose());
        this.panels.delete(target.path);
      },
    );
    const entry: Entry = { panel, controller, watchers: [] };
    this.panels.set(target.path, entry);

    let timer: NodeJS.Timeout | undefined;
    const trigger = () => {
      if (controller.busy) return;
      clearTimeout(timer);
      timer = setTimeout(() => { if (!controller.busy) void controller.handle({ type: 'refresh' }); }, 500);
    };
    for (const glob of ['**/*.csproj', '**/Directory.Packages.props', '**/[Nn]u[Gg]et.[Cc]onfig']) {
      const w = vscode.workspace.createFileSystemWatcher(glob);
      entry.watchers.push(w, w.onDidChange(trigger), w.onDidCreate(trigger), w.onDidDelete(trigger),
        { dispose: () => clearTimeout(timer) });
    }
  }
}
