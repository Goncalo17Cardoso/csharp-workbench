import { randomUUID } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { DotnetCli } from '../../dotnet/cli';
import { confirmAction } from '../confirm';
import type { ProjectInfoData, SolutionModel, TreeNode } from '../model';
import {
  dependentsOf, executePlan, folderPathOf, locateCsproj, planRemoveFolder, planRenameProject, referenceCandidates,
  solutionFolderId, validateProjectName, type Step,
} from '../plans';
import { presetPaths, presetString } from '../presets';
import { removeFolderFlow } from '../removeFolder';
import { readProjectInfo } from '../projectInfo';
import { addFolder, removeEmptyFolder, renameFolder, validateFolderName } from '../slnFolders';
import { loadSolution } from '../slnParse';
import { nodeSolutionFs, writeSolutionAtomically } from '../slnWriter';
import type { SolutionTreeProvider } from '../SolutionTreeProvider';
import { clearStartupIfRemoved, moveStartupProject } from '../state';
import { TemplateCatalog } from '../templateCatalog';
import { isSamePathIgnoreCase } from './files';

interface Deps {
  provider: SolutionTreeProvider;
  ws: vscode.Memento;
  getCli(): Promise<DotnetCli | undefined>;
  showOutput(): void;
}

const exists = (p: string) => fsp.access(p).then(() => true, () => false);
const readText = (p: string) => fsp.readFile(p, 'utf8');
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const projName = (p: string) => path.basename(p).replace(/\.csproj$/i, '');

async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...await listFiles(p));
    else out.push(p);
  }
  return out;
}

const nameError = (code: string | undefined): string | undefined =>
  code === 'empty' ? vscode.l10n.t('A name is required.')
    : code === 'chars' ? vscode.l10n.t('A name cannot contain any of: / \\ : * ? " < > |')
      : code === 'exists' ? vscode.l10n.t('A project or folder with this name already exists.') : undefined;

export function registerSolutionCommands(deps: Deps): vscode.Disposable[] {
  const { provider, ws } = deps;
  const core = provider.treeCore;
  let catalog: TemplateCatalog | undefined;

  const selection = (node?: TreeNode, nodes?: TreeNode[]) => (nodes?.length ? nodes : node ? [node] : []);
  const fail = (e: unknown) => void vscode.window.showErrorMessage(errText(e));
  const reload = () => void vscode.commands.executeCommand('csharpWorkbench.refresh');

  async function need(): Promise<{ cli: DotnetCli; sln: string } | undefined> {
    const cli = await deps.getCli();
    const sln = core.solutionPath;
    if (!cli) { fail(new Error(vscode.l10n.t('The .NET SDK was not found'))); return undefined; }
    if (!sln) { fail(new Error(vscode.l10n.t('No solution is open.'))); return undefined; }
    return { cli, sln };
  }

  const infoOf = async (p: string): Promise<ProjectInfoData> =>
    readProjectInfo(p, await readText(p));
  const infosOf = async (model: SolutionModel): Promise<ProjectInfoData[]> => {
    const out: ProjectInfoData[] = [];
    for (const p of model.projects) { try { out.push(await infoOf(p.path)); } catch { /* missing project: no refs */ } }
    return out;
  };

  /** Edits the solution text in place through the validated solution-folder writer (slnWriter.ts). */
  async function editSolution(cli: DotnetCli, sln: string, edit: (text: string, kind: SolutionModel['kind']) => string): Promise<void> {
    const text = await nodeSolutionFs.readFile(sln);
    const kind = sln.toLowerCase().endsWith('.slnx') ? 'slnx' : 'sln';
    await writeSolutionAtomically(sln, edit(text, kind), { ...nodeSolutionFs, validate: async () => { await cli.slnList(sln); } }, text);
  }

  const folderIdOf = (sln: string, n: TreeNode) => solutionFolderId(n.id, sln);

  // ---- projects -----------------------------------------------------------------------------

  async function addNewProject(node?: TreeNode, presetShortArg?: unknown, presetNameArg?: unknown): Promise<void> {
    const ctx = await need();
    if (!ctx || !node) return;
    const { cli, sln } = ctx;
    const presetShort = presetString(presetShortArg);
    const presetName = presetString(presetNameArg);
    const solDir = path.dirname(sln);
    catalog ??= new TemplateCatalog(cli);
    let list;
    try { list = await catalog.list('project'); } catch (e) { deps.showOutput(); fail(e); return; }
    const pick = presetShort !== undefined ? { shortName: presetShort } : await vscode.window.showQuickPick(
      list.filter((t) => t.languages.length === 0 || t.languages.includes('C#'))
        .map((t) => ({ label: t.name, description: t.shortNames.join(', '), shortName: t.shortNames[0] }))
        .filter((t) => t.shortName),
      { placeHolder: vscode.l10n.t('Select a project template'), matchOnDescription: true },
    );
    if (!pick) return;
    const name = presetName ?? await vscode.window.showInputBox({
      prompt: vscode.l10n.t('Project name'),
      validateInput: async (v) => {
        const taken = await exists(path.join(solDir, v));
        return nameError(validateProjectName(v, () => taken));
      },
    });
    if (!name) return;
    const outDir = path.join(solDir, name);
    try {
      const model = await loadSolution(sln, readText);
      const folder = node.kind === 'solutionFolder' ? folderPathOf(model, folderIdOf(sln, node)) : undefined;
      await cli.newTemplate(pick.shortName, ['-n', name, '-o', outDir], solDir);
      const proj = locateCsproj(path.join(outDir, `${name}.csproj`), await listFiles(outDir));
      if (!proj) throw new Error(vscode.l10n.t('The template did not create a project file in {0}.', outDir));
      await cli.slnAdd(sln, proj, folder);
    } catch (e) { deps.showOutput(); fail(e); } finally { reload(); }
  }

  async function addExistingProject(node?: TreeNode): Promise<void> {
    const ctx = await need();
    if (!ctx || !node) return;
    const picks = await vscode.window.showOpenDialog({
      canSelectMany: true, canSelectFolders: false, openLabel: vscode.l10n.t('Add'),
      filters: { [vscode.l10n.t('C# project')]: ['csproj'] },
    });
    if (!picks?.length) return;
    try {
      const model = await loadSolution(ctx.sln, readText);
      const folder = node.kind === 'solutionFolder' ? folderPathOf(model, folderIdOf(ctx.sln, node)) : undefined;
      for (const u of picks) await ctx.cli.slnAdd(ctx.sln, u.fsPath, folder);
    } catch (e) { deps.showOutput(); fail(e); } finally { reload(); }
  }

  async function removeFromSolution(node?: TreeNode, nodes?: TreeNode[]): Promise<void> {
    const ctx = await need();
    const sel = selection(node, nodes).filter((n) => n.kind === 'project' && n.path);
    if (!ctx || sel.length === 0) return;
    const msg = sel.length === 1
      ? vscode.l10n.t('Remove {0} from the solution?', sel[0].label) : vscode.l10n.t('Remove {0} projects from the solution?', sel.length);
    if (!(await confirmAction(msg, vscode.l10n.t('The project files stay on disk.'), vscode.l10n.t('Remove')))) return;
    const removed: string[] = [];
    try {
      for (const n of sel) { await ctx.cli.slnRemove(ctx.sln, n.path!); removed.push(n.path!); }
    } catch (e) { deps.showOutput(); fail(e); } finally {
      await clearStartupIfRemoved(ws, ctx.sln, removed);
      reload();
    }
  }

  async function renameProject(node?: TreeNode): Promise<void> {
    const ctx = await need();
    if (!ctx || node?.kind !== 'project' || !node.path) return;
    const old = node.path;
    const dir = path.dirname(old);
    const oldName = projName(old);
    const name = await vscode.window.showInputBox({
      value: oldName, prompt: vscode.l10n.t('Project name'),
      validateInput: async (v) => {
        if (v === oldName) return undefined;
        const target = path.join(dir, `${v}.csproj`);
        const taken = !isSamePathIgnoreCase(old, target) && await exists(target);
        return nameError(validateProjectName(v, () => taken));
      },
    });
    if (!name || name === oldName) return;
    const neu = path.join(dir, `${name}.csproj`);
    try {
      const model = await loadSolution(ctx.sln, readText);
      const steps = planRenameProject(model, old, name, dependentsOf(await infosOf(model), old));
      const run = async (s: Step) => {
        if (s.op === 'slnRemove') await ctx.cli.slnRemove(ctx.sln, s.args[0]);
        else if (s.op === 'removeRef') await ctx.cli.removeReference(s.args[0], s.args[1]);
        else if (s.op === 'renameFile') await fsp.rename(s.args[0], s.args[1]);
        else if (s.op === 'slnAdd') await ctx.cli.slnAdd(ctx.sln, s.args[0], s.args[1]);
        else await ctx.cli.addReference(s.args[0], s.args[1]);
      };
      const res = await executePlan(steps, run);
      if (res.failedAt !== undefined) {
        deps.showOutput();
        const failed = steps[res.failedAt];
        fail(new Error(`${vscode.l10n.t('Rename failed at step {0} of {1} ({2} {3}): {4}', res.failedAt + 1, steps.length, failed.op, path.basename(failed.args[0]), errText(res.error))} ${vscode.l10n.t('The solution may be partially updated; check it and re-add the project if needed.')}`));
      }
    } catch (e) { deps.showOutput(); fail(e); } finally {
      if (!(await exists(old)) && await exists(neu)) await moveStartupProject(ws, ctx.sln, old, neu);
      reload();
    }
  }

  // ---- solution folders ---------------------------------------------------------------------

  async function newSolutionFolder(node?: TreeNode, presetNameArg?: unknown): Promise<void> {
    const ctx = await need();
    if (!ctx || !node) return;
    let model: SolutionModel;
    try { model = await loadSolution(ctx.sln, readText); } catch (e) { fail(e); return; }
    const parentId = node.kind === 'solutionFolder' ? folderIdOf(ctx.sln, node) : undefined;
    const siblings = model.folders.filter((f) => f.parentId === parentId).map((f) => f.name);
    const name = presetString(presetNameArg) ?? await vscode.window.showInputBox({
      prompt: vscode.l10n.t('Solution folder name'), validateInput: (v) => validateFolderName(v, siblings) && vscode.l10n.t('Enter a unique name without any of: / \\ : * ? " < > |'),
    });
    if (!name) return;
    try {
      await editSolution(ctx.cli, ctx.sln, (t, kind) => addFolder(t, kind, name, parentId, () => randomUUID()));
    } catch (e) { fail(e); } finally { reload(); }
  }

  async function renameSolutionFolder(node?: TreeNode, presetNameArg?: unknown): Promise<void> {
    const ctx = await need();
    if (!ctx || node?.kind !== 'solutionFolder') return;
    let model: SolutionModel;
    try { model = await loadSolution(ctx.sln, readText); } catch (e) { fail(e); return; }
    const id = folderIdOf(ctx.sln, node);
    const parentId = model.folders.find((f) => f.id === id)?.parentId;
    const siblings = model.folders.filter((f) => f.parentId === parentId && f.id !== id).map((f) => f.name);
    const name = presetString(presetNameArg) ?? await vscode.window.showInputBox({
      value: node.label, prompt: vscode.l10n.t('Solution folder name'),
      validateInput: (v) => validateFolderName(v, siblings) && vscode.l10n.t('Enter a unique name without any of: / \\ : * ? " < > |'),
    });
    if (!name || name === node.label) return;
    try {
      await editSolution(ctx.cli, ctx.sln, (t, kind) => renameFolder(t, kind, id, name));
    } catch (e) { fail(e); } finally { reload(); }
  }

  async function removeSolutionFolder(node?: TreeNode): Promise<void> {
    const ctx = await need();
    if (!ctx || node?.kind !== 'solutionFolder') return;
    const { cli, sln } = ctx;
    try {
      const model = await loadSolution(sln, readText);
      const id = folderIdOf(sln, node);
      const plan = planRemoveFolder(model, id);
      const names = plan.projectRemovals.map(projName);
      const ok = await confirmAction(
        vscode.l10n.t('Remove solution folder {0}?', node.label),
        names.length ? vscode.l10n.t('These projects are removed from the solution (files stay on disk):\n{0}', names.join('\n')) : undefined,
        vscode.l10n.t('Remove'),
      );
      if (!ok) return;
      const removed: string[] = [];
      try {
        await removeFolderFlow(id, {
          slnRemove: (p) => cli.slnRemove(sln, p), load: () => loadSolution(sln, readText),
          edit: (change) => editSolution(cli, sln, change), onProjectRemoved: (p) => removed.push(p),
        });
      } finally { await clearStartupIfRemoved(ws, sln, removed); }
    } catch (e) { deps.showOutput(); fail(e); } finally { reload(); }
  }

  // ---- references ---------------------------------------------------------------------------

  async function addProjectReference(node?: TreeNode, presetPathsArg?: unknown): Promise<void> {
    const ctx = await need();
    const target = node?.projectPath;
    if (!ctx || !target) return;
    try {
      const model = await loadSolution(ctx.sln, readText);
      const cands = referenceCandidates(model.projects, await infosOf(model), target);
      if (cands.length === 0) { void vscode.window.showInformationMessage(vscode.l10n.t('No other projects can be referenced.')); return; }
      const picks = presetPaths(presetPathsArg) ? presetPaths(presetPathsArg)!.map((p) => ({ path: p })) : await vscode.window.showQuickPick(
        cands.map((p) => ({ label: p.name, description: vscode.workspace.asRelativePath(p.path), path: p.path })),
        { canPickMany: true, placeHolder: vscode.l10n.t('Select projects to reference') },
      );
      if (!picks?.length) return;
      for (const p of picks) await ctx.cli.addReference(target, p.path);
    } catch (e) { deps.showOutput(); fail(e); } finally { provider.invalidatePath(target); }
  }

  async function removeProjectReference(node?: TreeNode, nodes?: TreeNode[]): Promise<void> {
    const cli = await deps.getCli();
    const sel = selection(node, nodes).filter((n) => n.kind === 'projectRef' && n.path && n.projectPath);
    if (!cli || sel.length === 0) return;
    const msg = sel.length === 1
      ? vscode.l10n.t('Remove reference to {0}?', sel[0].label) : vscode.l10n.t('Remove {0} project references?', sel.length);
    if (!(await confirmAction(msg, undefined, vscode.l10n.t('Remove')))) return;
    try {
      for (const n of sel) await cli.removeReference(n.projectPath!, n.path!);
    } catch (e) { deps.showOutput(); fail(e); } finally { for (const n of sel) provider.invalidatePath(n.projectPath!); }
  }

  // ---- packages -----------------------------------------------------------------------------

  const openManager = (target: string | undefined) =>
    target ? vscode.commands.executeCommand('csharpWorkbench.manageNuget', vscode.Uri.file(target)) : undefined;

  async function removePackage(node?: TreeNode, nodes?: TreeNode[]): Promise<void> {
    const cli = await deps.getCli();
    const sel = selection(node, nodes).filter((n) => n.kind === 'package' && n.projectPath);
    if (!cli || sel.length === 0) return;
    const msg = sel.length === 1
      ? vscode.l10n.t('Remove package {0}?', sel[0].label) : vscode.l10n.t('Remove {0} packages?', sel.length);
    if (!(await confirmAction(msg, undefined, vscode.l10n.t('Remove')))) return;
    try {
      for (const n of sel) await cli.removePackage(n.projectPath!, n.label);
    } catch (e) { deps.showOutput(); fail(e); } finally { for (const n of sel) provider.invalidatePath(n.projectPath!); }
  }

  const reg = (id: string, fn: (...a: never[]) => unknown) => vscode.commands.registerCommand(`csharpWorkbench.${id}`, fn as (...a: unknown[]) => unknown);
  return [
    reg('addNewProject', addNewProject),
    reg('addExistingProject', addExistingProject),
    reg('removeFromSolution', removeFromSolution),
    reg('renameProject', renameProject),
    reg('newSolutionFolder', newSolutionFolder),
    reg('renameSolutionFolder', renameSolutionFolder),
    reg('removeSolutionFolder', removeSolutionFolder),
    reg('addProjectReference', addProjectReference),
    reg('removeProjectReference', removeProjectReference),
    reg('manageNugetForProject', (n?: TreeNode) => openManager(n?.projectPath ?? n?.path)),
    reg('manageNugetForSolution', () => openManager(core.solutionPath)),
    reg('addNugetPackage', (n?: TreeNode) => openManager(n?.projectPath ?? n?.path)),
    reg('updatePackage', (n?: TreeNode) => openManager(n?.projectPath)),
    reg('removePackage', removePackage),
  ];
}
