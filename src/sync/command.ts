import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { nodeTextFs } from '../core/atomicWrite';
import type { DotnetCli } from '../dotnet/cli';
import type { Output } from '../output';
import type { TreeNode } from '../solution/model';
import { readProjectInfo } from '../solution/projectInfo';
import { loadProjectItems } from '../solution/projectItems';
import { loadSolution } from '../solution/slnParse';
import type { SolutionTreeProvider } from '../solution/SolutionTreeProvider';
import { toWorkspaceEditSpec } from './editSpec';
import { planSync, type SyncInputFile } from './plan';

export { toWorkspaceEditSpec } from './editSpec';

interface Deps {
  provider: SolutionTreeProvider;
  output: Output;
  getCli(): Promise<DotnetCli | undefined>;
  /** Test mode only: apply without the refactor preview. Always false in production. */
  skipConfirmation(): boolean;
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const readText = (p: string) => fsp.readFile(p, 'utf8');

/** A compile item that belongs to the project: not linked, inside its directory, not under bin/ or obj/. */
export function isSyncCandidate(projectDir: string, item: { fullPath: string; link?: string }): boolean {
  if (item.link || !item.fullPath.toLowerCase().endsWith('.cs')) return false;
  const rel = path.relative(projectDir, item.fullPath);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return false;
  return !rel.split(/[\\/]/).slice(0, -1).some((s) => s === 'bin' || s === 'obj');
}

const labelText = (label: string) => {
  switch (label) {
    case 'Namespace declaration': return vscode.l10n.t('Namespace declaration');
    case 'Using directive': return vscode.l10n.t('Using directive');
    default: return vscode.l10n.t('Qualified name');
  }
};

export function registerSyncCommands(deps: Deps): vscode.Disposable[] {
  const core = deps.provider.treeCore;

  async function collect(scopeProject: string | undefined, solution: string | undefined, cli: DotnetCli, token: vscode.CancellationToken): Promise<{ files: SyncInputFile[]; dirtyTexts: Set<string> } | undefined> {
    const projects = solution ? (await loadSolution(solution, readText)).projects.map((p) => p.path) : [];
    if (scopeProject && !projects.includes(scopeProject)) projects.push(scopeProject);
    const open = new Map(vscode.workspace.textDocuments.filter((d) => d.isDirty && d.uri.scheme === 'file').map((d) => [d.uri.fsPath, d]));
    const files: SyncInputFile[] = [];
    const seen = new Set<string>();
    for (const project of projects) {
      if (token.isCancellationRequested) return undefined;
      const projectDir = path.dirname(project);
      let rootNamespace: string;
      try { rootNamespace = readProjectInfo(project, await readText(project)).rootNamespace; } catch (e) {
        deps.output.info(`${project}: ${errText(e)}`);
        continue;
      }
      const items = await loadProjectItems(project, cli, { readdir: (d) => fsp.readdir(d, { withFileTypes: true }) });
      const inScope = !scopeProject || project === scopeProject;
      for (const item of items.items.filter((i) => isSyncCandidate(projectDir, i))) {
        if (token.isCancellationRequested) return undefined;
        if (seen.has(item.fullPath)) continue;
        seen.add(item.fullPath);
        try {
          const doc = open.get(item.fullPath);
          const text = doc ? doc.getText() : await nodeTextFs.readFile(item.fullPath);
          files.push({ path: item.fullPath, text, projectDir, rootNamespace, inScope });
        } catch (e) { deps.output.info(`${item.fullPath}: ${errText(e)}`); }
      }
    }
    return { files, dirtyTexts: new Set(open.keys()) };
  }

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
          return { plan: planSync(input.files), texts: new Map(input.files.map((f) => [f.path, f.text])) };
        },
      );
      if (!planned) return;
      const { plan, texts } = planned;
      const specs = toWorkspaceEditSpec(plan, texts);
      if (!specs.length) { void vscode.window.showInformationMessage(vscode.l10n.t('Namespaces are already in sync.')); return; }

      const skip = deps.skipConfirmation();
      const edit = new vscode.WorkspaceEdit();
      for (const s of specs) {
        edit.replace(
          vscode.Uri.file(s.path),
          new vscode.Range(s.range.startLine, s.range.startCol, s.range.endLine, s.range.endCol),
          s.newText,
          { needsConfirmation: !skip, label: labelText(s.label) },
        );
      }
      if (!(await vscode.workspace.applyEdit(edit, { isRefactoring: true }))) return;

      for (const s of plan.skipped) deps.output.info(`Sync Namespaces: skipped ${s.path} (${s.reason})`);
      for (const a of plan.ambiguous) deps.output.info(`Sync Namespaces: ambiguous ${a.from}.${a.type} -> ${a.targets.join(', ')}`);
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
