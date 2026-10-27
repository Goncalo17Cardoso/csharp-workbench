import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Target } from './core/types';
import { compareVersions } from './core/version';
import { DotnetCli } from './dotnet/cli';
import { nodeExec } from './dotnet/exec';
import { findDotnet } from './dotnet/locate';
import { createOutput } from './output';
import { PanelManager, type PanelTestHooks } from './panel/PanelManager';
import type { ToHost } from './panel/protocol';
import { selectTargets } from './workspace/targets';

/** Returned from activate() for the integration tests; production code never sets the hooks. */
export interface ExtensionApi extends PanelTestHooks {
  send(targetPath: string, msg: ToHost): Promise<void>;
}

const exists = (p: string) => fsp.access(p).then(() => true, () => false);
const MIN_SLNX_SDK = '9.0.200';

export function activate(context: vscode.ExtensionContext): ExtensionApi {
  const channel = vscode.window.createOutputChannel('C# Workbench');
  context.subscriptions.push(channel);
  const output = createOutput(channel);
  const api: ExtensionApi = {
    send: (targetPath, msg) => {
      if (!manager) return Promise.reject(new Error('NuGet manager is not open'));
      return manager.send(targetPath, msg);
    },
  };

  let manager: PanelManager | undefined;
  let managerDotnet: string | undefined;
  let cli: DotnetCli | undefined;
  let targets: Target[] = [];

  async function resolveDotnet(): Promise<string | undefined> {
    const configuredPath = vscode.workspace.getConfiguration('csharpWorkbench').get<string>('dotnetPath') || undefined;
    const found = await findDotnet({ configuredPath, pathEnv: process.env.PATH ?? '', home: os.homedir(), exists });
    if (found && !process.env.DOTNET_ROOT) {
      try {
        process.env.DOTNET_ROOT = path.dirname(await fsp.realpath(found));
      } catch { /* leave unset; dotnet finds its own root */ }
    }
    return found;
  }

  async function ensureManager(): Promise<PanelManager | undefined> {
    const dotnet = await resolveDotnet();
    if (!dotnet) {
      const install = vscode.l10n.t('Install .NET SDK');
      void vscode.window
        .showErrorMessage(vscode.l10n.t('The .NET SDK was not found. Install it or set csharpWorkbench.dotnetPath.'), install)
        .then((choice) => {
          if (choice === install) void vscode.env.openExternal(vscode.Uri.parse('https://dotnet.microsoft.com/download'));
        });
      return undefined;
    }
    if (!manager || managerDotnet !== dotnet) {
      manager?.dispose();
      cli = new DotnetCli(nodeExec, dotnet, output);
      managerDotnet = dotnet;
      manager = new PanelManager(context.extensionUri, cli, () => channel.show(true), () => targets, api);
    }
    return manager;
  }

  async function discover(): Promise<Target[]> {
    const uris = await vscode.workspace.findFiles('**/*.{sln,slnx,csproj}', '**/{bin,obj,node_modules}/**');
    return selectTargets(uris.map((u) => u.fsPath));
  }

  async function checkSlnxSdk(target: Target): Promise<boolean> {
    if (target.kind !== 'slnx' || !cli) return true;
    try {
      const v = await cli.sdkVersion(path.dirname(target.path));
      if (compareVersions(v, MIN_SLNX_SDK) >= 0) return true;
      void vscode.window.showErrorMessage(
        vscode.l10n.t('.slnx solutions need .NET SDK {0} or newer (found {1}).', MIN_SLNX_SDK, v));
      return false;
    } catch (e) {
      void vscode.window.showErrorMessage(e instanceof Error ? e.message : String(e));
      return false;
    }
  }

  async function manageNuget(uri?: vscode.Uri): Promise<void> {
    const mgr = await ensureManager();
    if (!mgr || !cli) return;
    targets = await discover();
    let target: Target | undefined;
    let preselectProject: string | undefined;
    const file = uri?.fsPath;
    const ext = file ? path.extname(file).toLowerCase() : '';

    if (file && ext === '.csproj') {
      for (const sol of targets.filter((t) => t.kind !== 'csproj')) {
        try {
          if ((await cli.slnList(sol.path)).some((p) => p.path === file)) { target = sol; preselectProject = file; break; }
        } catch { /* unreadable solution: try the next one */ }
      }
      target ??= { kind: 'csproj', path: file, name: path.basename(file, '.csproj') };
    } else if (file && (ext === '.sln' || ext === '.slnx')) {
      target = { kind: ext === '.sln' ? 'sln' : 'slnx', path: file, name: path.basename(file, ext) };
    } else if (targets.length === 1) {
      target = targets[0];
    } else if (targets.length > 1) {
      const pick = await vscode.window.showQuickPick(
        targets.map((t) => ({ label: t.name, description: vscode.workspace.asRelativePath(t.path), target: t })),
        { placeHolder: vscode.l10n.t('Select a solution or project') },
      );
      target = pick?.target;
    } else {
      void vscode.window.showInformationMessage(vscode.l10n.t('No solution or project found in the workspace.'));
      return;
    }
    if (!target) return;
    if (!targets.some((t) => t.path === target!.path)) targets = [...targets, target];
    if (!(await checkSlnxSdk(target))) return;
    mgr.open(target, { preselectProject });
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('csharpWorkbench.manageNuget', (uri?: vscode.Uri) => manageNuget(uri)),
    { dispose: () => manager?.dispose() },
  );
  return api;
}

export function deactivate(): void {}
