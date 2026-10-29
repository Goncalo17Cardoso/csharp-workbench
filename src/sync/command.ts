import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { nodeTextFs } from '../core/atomicWrite';
import type { DotnetCli } from '../dotnet/cli';
import type { Output } from '../output';
import type { TreeNode } from '../solution/model';
import { loadProjectItems } from '../solution/projectItems';
import { loadSolution } from '../solution/slnParse';
import type { SolutionTreeProvider } from '../solution/SolutionTreeProvider';
import { chooseText, resolveRootNamespace, syncFileInput, syncItemRole } from './candidates';
import { toWorkspaceEditSpec } from './editSpec';
import { planSync, type SyncInputFile, type SyncPlan } from './plan';

export { toWorkspaceEditSpec } from './editSpec';

interface Deps {
  provider: SolutionTreeProvider;
  output: Output;
  getCli(): Promise<DotnetCli | undefined>;
  /** Test mode only: apply without the refactor preview. Always false in production. */
  skipConfirmation(): boolean;
  /** Test mode only: receives a function that computes the plan without applying it. */
  expose?(plan: (nodeOrPath?: TreeNode | string) => Promise<{ plan: SyncPlan; texts: Map<string, string> } | undefined>): void;
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const readText = (p: string) => fsp.readFile(p, 'utf8');

const labelText = (kind: 'declaration' | 'using' | 'qualified') =>
  kind === 'declaration' ? vscode.l10n.t('Namespace declaration')
    : kind === 'using' ? vscode.l10n.t('Using directive') : vscode.l10n.t('Qualified name');

export function registerSyncCommands(deps: Deps): vscode.Disposable[] {
  const core = deps.provider.treeCore;

  async function collect(scopeProject: string | undefined, solution: string | undefined, cli: DotnetCli, token: vscode.CancellationToken): Promise<{ files: SyncInputFile[]; generated: string[]; dirtyTexts: Set<string> } | undefined> {
    let projects: string[] = [];
    if (solution) {
      try { projects = (await loadSolution(solution, readText)).projects.map((p) => p.path); } catch (e) {
        // A solution that vanished or cannot be read must not block syncing the project the user picked.
        if (!scopeProject) throw e;
        deps.output.info(`${solution}: ${errText(e)}`);
      }
    }
    if (scopeProject && !projects.some((p) => path.resolve(p) === path.resolve(scopeProject))) projects.push(scopeProject);
    const open = new Map(vscode.workspace.textDocuments.filter((d) => d.isDirty && d.uri.scheme === 'file').map((d) => [path.resolve(d.uri.fsPath), d]));
    const files: SyncInputFile[] = [];
    const generated: string[] = [];
    const seen = new Set<string>();
    for (const project of projects) {
      if (token.isCancellationRequested) return undefined;
      const projectDir = path.dirname(project);
      // The evaluated RootNamespace (Directory.Build.props, $(...)); the file name when it cannot be evaluated.
      let evaluated: string | undefined;
      try { evaluated = (await cli.getProperties(project, ['RootNamespace'])).RootNamespace; } catch (e) {
        deps.output.info(`${project}: ${errText(e)}`);
      }
      const rootNamespace = resolveRootNamespace(project, evaluated);
      const items = await loadProjectItems(project, cli, { readdir: (d) => fsp.readdir(d, { withFileTypes: true }) });
      const inScope = !scopeProject || path.resolve(project) === path.resolve(scopeProject);
      for (const item of items.items) {
        const role = syncItemRole(projectDir, item);
        if (role === 'excluded') continue;
        if (token.isCancellationRequested) return undefined;
        if (seen.has(item.fullPath)) continue;
        seen.add(item.fullPath);
        try {
          const text = await chooseText(open.get(path.resolve(item.fullPath))?.getText(), () => nodeTextFs.readFile(item.fullPath));
          const input = syncFileInput(role, { path: item.fullPath, text, projectDir, rootNamespace, inScope });
          files.push(input.file);
          if (input.generated) generated.push(item.fullPath);
        } catch (e) { deps.output.info(`${item.fullPath}: ${errText(e)}`); }
      }
    }
    return { files, generated, dirtyTexts: new Set(open.keys()) };
  }

  deps.expose?.(async (nodeOrPath) => {
    const scope = typeof nodeOrPath === 'string' ? nodeOrPath : nodeOrPath?.kind === 'project' ? nodeOrPath.path : undefined;
    const cli = await deps.getCli();
    if (!cli) return undefined;
    const input = await collect(scope, core.solutionPath, cli, new vscode.CancellationTokenSource().token);
    return input && { plan: planSync(input.files), texts: new Map(input.files.map((f) => [f.path, f.text])) };
  });

  async function sync(node?: TreeNode): Promise<void> {
    const solution = core.solutionPath;
    const scopeProject = node?.kind === 'project' ? node.path : undefined;
    if (!scopeProject && !solution) { void vscode.window.showInformationMessage(vscode.l10n.t('No solution is open.')); return; }
    const cli = await deps.getCli();
    if (!cli) { void vscode.window.showErrorMessage(vscode.l10n.t('The .NET SDK was not found')); return; }
    try {
      const planned = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Synchronizing namespaces'), cancellable: true },
        async (_p, token) => {
          const input = await collect(scopeProject, solution, cli, token);
          if (!input || token.isCancellationRequested) return undefined;
          return { plan: planSync(input.files), generated: input.generated, texts: new Map(input.files.map((f) => [f.path, f.text])) };
        },
      );
      if (!planned) return;
      const { plan, texts, generated } = planned;
      for (const g of generated) deps.output.info(`Sync Namespaces: skipped ${g} (generated)`);
      for (const s of plan.skipped) deps.output.info(`Sync Namespaces: skipped ${s.path} (${s.reason})`);
      for (const a of plan.ambiguous) deps.output.info(`Sync Namespaces: ambiguous ${a.from}.${a.type} -> ${a.targets.join(', ')}`);
      const specs = toWorkspaceEditSpec(plan, texts);
      if (!specs.length) {
        void vscode.window.showInformationMessage(plan.skipped.length || plan.ambiguous.length
          ? vscode.l10n.t('No changes were made; some files were skipped or are ambiguous. See the Output channel.')
          : vscode.l10n.t('Namespaces are already in sync.'));
        return;
      }

      const skip = deps.skipConfirmation();
      const edit = new vscode.WorkspaceEdit();
      for (const s of specs) {
        edit.replace(
          vscode.Uri.file(s.path),
          new vscode.Range(s.range.startLine, s.range.startCol, s.range.endLine, s.range.endCol),
          s.newText,
          { needsConfirmation: !skip, label: labelText(s.kind) },
        );
      }
      if (!(await vscode.workspace.applyEdit(edit, { isRefactoring: true }))) return;

      const build = vscode.l10n.t('Build');
      void Promise.resolve(vscode.window.showInformationMessage(vscode.l10n.t('Namespaces synchronized.'), build)).then((c) => {
        if (c !== build) return;
        const target: TreeNode | { kind: 'solution'; path: string } = scopeProject ? node! : { kind: 'solution', path: solution! };
        void vscode.commands.executeCommand(scopeProject ? 'csharpWorkbench.build' : 'csharpWorkbench.buildSolution', target);
      });
    } catch (e) { void vscode.window.showErrorMessage(errText(e)); }
  }

  return [vscode.commands.registerCommand('csharpWorkbench.syncNamespaces', (n?: TreeNode) => sync(n))];
}
