import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { DotnetCli } from '../../dotnet/cli';
import type { TreeNode } from '../model';
import { readProjectInfo } from '../projectInfo';
import { createEndWaiter, debugConfigFor, dotnetTask, runTfm, targetPathStep, type TaskKind } from '../runCore';
import { loadSolution } from '../slnParse';
import type { SolutionTreeProvider } from '../SolutionTreeProvider';
import { getStartupProject, setStartupProject } from '../state';

export { debugConfigFor, dotnetTask } from '../runCore';

interface Deps {
  provider: SolutionTreeProvider;
  ws: vscode.Memento;
  getCli(): Promise<DotnetCli | undefined>;
  resolveDotnet(): Promise<string | undefined>;
}

const CSHARP_EXT = 'ms-dotnettools.csharp';
const readText = (p: string) => fsp.readFile(p, 'utf8');
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const projName = (p: string) => path.basename(p).replace(/\.csproj$/i, '');

export function registerRunCommands(deps: Deps): vscode.Disposable[] {
  const { provider, ws } = deps;
  const core = provider.treeCore;
  const fail = (e: unknown) => void vscode.window.showErrorMessage(errText(e));

  /** Runs a dotnet task; resolves with the process exit code (undefined if it never ran or was killed). */
  async function runTask(kind: TaskKind, target: string, wait: boolean, tfm?: string): Promise<number | undefined> {
    const dotnet = await deps.resolveDotnet();
    if (!dotnet) { fail(new Error(vscode.l10n.t('The .NET SDK was not found'))); return undefined; }
    const { name, args } = dotnetTask(kind, target, dotnet, tfm);
    const task = new vscode.Task(
      { type: 'csharpWorkbench', kind, target }, vscode.TaskScope.Workspace, name, 'C# Workbench',
      new vscode.ProcessExecution(dotnet, args, { cwd: path.dirname(target) }), ['$msCompile'],
    );
    if (kind !== 'run') task.group = vscode.TaskGroup.Build;
    if (!wait) { await vscode.tasks.executeTask(task); return 0; }
    const waiter = createEndWaiter<vscode.TaskExecution>((fn, ms) => setTimeout(fn, ms), (t) => clearTimeout(t as NodeJS.Timeout), 500);
    const sub1 = vscode.tasks.onDidEndTaskProcess((e) => waiter.onProcessEnd(e.execution, e.exitCode));
    const sub2 = vscode.tasks.onDidEndTask((e) => waiter.onTaskEnd(e.execution));
    const sub = { dispose: () => { sub1.dispose(); sub2.dispose(); waiter.dispose(); } };
    try {
      waiter.setExecution(await vscode.tasks.executeTask(task));
      return await waiter.promise;
    } finally { sub.dispose(); }
  }

  const solutionPath = () => core.solutionPath;

  async function pickStartup(): Promise<string | undefined> {
    const sln = solutionPath();
    if (!sln) { void vscode.window.showInformationMessage(vscode.l10n.t('No solution is open.')); return undefined; }
    let model;
    try { model = await loadSolution(sln, readText); } catch (e) { fail(e); return undefined; }
    const cur = getStartupProject(ws, sln);
    if (cur && model.projects.some((p) => p.path === cur)) return cur;
    if (cur) await setStartupProject(ws, sln, undefined);
    const pick = await vscode.window.showQuickPick(
      model.projects.map((p) => ({ label: p.name, description: vscode.workspace.asRelativePath(p.path), path: p.path })),
      { placeHolder: vscode.l10n.t('Select the startup project') },
    );
    if (!pick) return undefined;
    await setStartupProject(ws, sln, pick.path);
    void vscode.commands.executeCommand('csharpWorkbench.refresh');
    return pick.path;
  }

  async function resolveTargetPath(project: string): Promise<{ target: string; tfm?: string } | undefined> {
    const cli = await deps.getCli();
    if (!cli) { fail(new Error(vscode.l10n.t('The .NET SDK was not found'))); return undefined; }
    const step = targetPathStep(await cli.getProperty(project, 'TargetPath'), (await tfmsOf(project)));
    if (step.kind === 'path') return { target: step.path };
    if (step.kind === 'fail') return undefined;
    const again = targetPathStep(await cli.getProperty(project, 'TargetPath', { TargetFramework: step.tfm }), []);
    return again.kind === 'path' ? { target: again.path, tfm: step.tfm } : undefined;
  }
  const tfmsOf = async (project: string) => readProjectInfo(project, await readText(project)).targetFrameworks;

  /** Builds and returns the program path, or undefined when the build or the evaluation failed. */
  async function buildForDebug(project: string): Promise<string | undefined> {
    try {
      const resolved = await resolveTargetPath(project);
      if (!resolved) { fail(new Error(vscode.l10n.t('Could not determine the output path of {0}.', projName(project)))); return undefined; }
      const code = await runTask('build', project, true, resolved.tfm);
      if (code !== 0) return undefined;
      return resolved.target;
    } catch (e) { fail(e); return undefined; }
  }

  async function runProject(project: string | undefined): Promise<void> {
    if (!project) return;
    try {
      const tfm = runTfm(await tfmsOf(project));
      await runTask('run', project, false, tfm);
    } catch (e) { fail(e); }
  }

  async function debugProject(project: string | undefined): Promise<void> {
    if (!project) return;
    if (!vscode.extensions.getExtension(CSHARP_EXT)) {
      const install = vscode.l10n.t('Install C# extension');
      const c = await vscode.window.showWarningMessage(
        vscode.l10n.t('Debugging needs the C# extension (ms-dotnettools.csharp).'), install);
      if (c === install) await vscode.commands.executeCommand('workbench.extensions.installExtension', CSHARP_EXT);
      return;
    }
    const program = await buildForDebug(project);
    if (!program) return;
    const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(project));
    let started = false;
    try {
      started = await vscode.debug.startDebugging(folder, debugConfigFor(project, program, projName(project)));
    } catch (e) { fail(e); return; }
    if (!started) {
      const run = vscode.l10n.t('Run');
      const c = await vscode.window.showWarningMessage(
        vscode.l10n.t('The .NET debugger is not available in this editor. Use Run instead.'), run);
      if (c === run) await runProject(project);
    }
  }

  const projectOf = (n?: TreeNode) => (n?.kind === 'project' ? n.path : undefined);
  const solutionOf = (n?: TreeNode) => (n?.kind === 'solution' ? n.path : undefined);
  const taskCmd = (kind: TaskKind) => async (n?: TreeNode) => {
    const target = projectOf(n) ?? solutionOf(n);
    if (!target) return;
    try { await runTask(kind, target, false); } catch (e) { fail(e); }
  };

  const reg = (id: string, fn: (...a: never[]) => unknown) => vscode.commands.registerCommand(`csharpWorkbench.${id}`, fn as (...a: unknown[]) => unknown);

  const provider2: vscode.DebugConfigurationProvider = {
    provideDebugConfigurations() {
      const sln = solutionPath();
      const proj = sln ? getStartupProject(ws, sln) : undefined;
      if (!proj) return [];
      return [{ ...debugConfigFor(proj, '', projName(proj)), program: '', csharpWorkbenchProject: proj }];
    },
    async resolveDebugConfigurationWithSubstitutedVariables(_f, config) {
      const proj = config.csharpWorkbenchProject as string | undefined;
      if (!proj) return config;
      const program = await buildForDebug(proj);
      return program ? { ...config, program } : undefined;
    },
  };

  return [
    reg('build', taskCmd('build')),
    reg('buildSolution', taskCmd('build')),
    reg('rebuildSolution', taskCmd('rebuild')),
    reg('cleanSolution', taskCmd('clean')),
    reg('rebuild', taskCmd('rebuild')),
    reg('clean', taskCmd('clean')),
    reg('run', (n?: TreeNode) => runProject(projectOf(n))),
    reg('debug', (n?: TreeNode) => debugProject(projectOf(n))),
    reg('setStartupProject', async (n?: TreeNode) => {
      const p = projectOf(n); const sln = solutionPath();
      if (!p || !sln) return;
      await setStartupProject(ws, sln, p);
      void vscode.commands.executeCommand('csharpWorkbench.refresh');
    }),
    reg('runStartup', async () => runProject(await pickStartup())),
    reg('debugStartup', async () => debugProject(await pickStartup())),
    vscode.debug.registerDebugConfigurationProvider('coreclr', provider2, vscode.DebugConfigurationProviderTriggerKind.Dynamic),
  ];
}
