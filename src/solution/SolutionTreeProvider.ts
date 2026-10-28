import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { DotnetCli } from '../dotnet/cli';
import { readPackageRefs } from '../workspace/projectFiles';
import type { TreeNode } from './model';
import { readProjectInfo } from './projectInfo';
import { loadProjectItems, walkProjectDir } from './projectItems';
import { dedupeNested, FileExistsError, validateDrop } from './commands/files';
import { loadSolution } from './slnParse';
import { getSelectedSolution, getStartupProject, setSelectedSolution } from './state';
import { SolutionTreeCore } from './treeCore';
import { shouldInvalidate, type FsEvent } from './watchFilter';

const WATCH_GLOB = '**/*.{cs,csproj,sln,slnx,props,targets,json,razor,cshtml,xaml,resx}';
const DEBOUNCE_MS = 300;
const ICONS: Partial<Record<TreeNode['kind'], string>> = {
  solution: 'symbol-namespace', solutionFolder: 'folder-library', project: 'project', dependencies: 'references',
  packages: 'package', package: 'package', projectRefs: 'references', projectRef: 'references',
  frameworks: 'symbol-constant', framework: 'symbol-constant', warning: 'warning',
};
const readFile = (p: string) => fsp.readFile(p, 'utf8');

/** The core builds English labels; the fixed ones are translated here, keyed by node kind. */
function labelOf(node: TreeNode): string {
  switch (node.kind) {
    case 'solution': {
      const name = path.basename(node.path ?? '').replace(/\.(sln|slnx)$/i, '');
      const n = node.count ?? 0;
      return n === 1 ? vscode.l10n.t('Solution \'{0}\' ({1} project)', name, n) : vscode.l10n.t('Solution \'{0}\' ({1} projects)', name, n);
    }
    case 'dependencies': return vscode.l10n.t('Dependencies');
    case 'packages': return vscode.l10n.t('Packages');
    case 'projectRefs': return vscode.l10n.t('Projects');
    case 'frameworks': return vscode.l10n.t('Frameworks');
    case 'warning':
      return node.projectPath
        ? vscode.l10n.t('Could not evaluate project — showing files on disk') : vscode.l10n.t('Could not read solution');
    default: return node.label;
  }
}

export class SolutionTreeProvider implements vscode.TreeDataProvider<TreeNode>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<TreeNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly core: SolutionTreeCore;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly pending = new Map<string, boolean>();
  private timer: NodeJS.Timeout | undefined;
  private view: vscode.TreeView<TreeNode> | undefined;

  /** `getCli` resolves lazily; when dotnet is missing the project items fall back to a disk walk. */
  constructor(private readonly ws: vscode.Memento, getCli: () => Promise<Pick<DotnetCli, 'getItems'> | undefined>) {
    const fs = { readdir: (d: string) => fsp.readdir(d, { withFileTypes: true }) };
    this.core = new SolutionTreeCore({
      discover: async () => (await vscode.workspace.findFiles('**/*.{sln,slnx,csproj}', '**/{bin,obj,node_modules}/**')).map((u) => u.fsPath),
      loadSolution: (p) => loadSolution(p, readFile),
      loadProjectInfo: async (p) => readProjectInfo(p, await readFile(p)),
      loadProjectItems: async (p) => {
        const cli = (await getCli()) ?? { getItems: () => Promise.reject(new Error('The .NET SDK was not found')) };
        return loadProjectItems(p, cli, fs);
      },
      loadPackages: async (p) => readPackageRefs(await readFile(p)),
      walk: (d) => walkProjectDir(d, fs),
      fileExists: (p) => fsp.access(p).then(() => true, () => false),
      state: {
        selectedSolution: () => getSelectedSolution(ws),
        startupProject: (s) => getStartupProject(ws, s),
      },
    });
  }

  get treeCore(): SolutionTreeCore { return this.core; }

  /** Drops the cached project items around a changed path now, without waiting for the watcher. */
  invalidatePath(p: string): void {
    const hit = this.core.invalidate(p, true);
    if (hit === null) this.emitter.fire(undefined);
    else if (hit) this.emitter.fire(hit);
    else if (this.core.projectForPath(p)) this.emitter.fire(undefined);
  }

  register(): vscode.Disposable[] {
    this.view = vscode.window.createTreeView('csharpWorkbench.solutionExplorer', {
      treeDataProvider: this, showCollapseAll: true, canSelectMany: true, dragAndDropController: this.dnd(),
    });
    void vscode.commands.executeCommand('setContext', 'csharpWorkbench.showAllFiles', false);
    const toggle = (on: boolean) => () => {
      this.core.setShowAllFiles(on);
      void vscode.commands.executeCommand('setContext', 'csharpWorkbench.showAllFiles', on);
      this.emitter.fire(undefined);
    };
    const watcher = vscode.workspace.createFileSystemWatcher(WATCH_GLOB);
    const folders = vscode.workspace.createFileSystemWatcher('**/*', false, true, false);
    this.disposables.push(
      this.view, this.emitter, watcher, folders,
      watcher.onDidCreate((u) => this.queue(u.fsPath, 'create')),
      watcher.onDidChange((u) => this.queue(u.fsPath, 'change')),
      watcher.onDidDelete((u) => this.queue(u.fsPath, 'delete')),
      folders.onDidCreate((u) => this.queue(u.fsPath, 'create')),
      folders.onDidDelete((u) => this.queue(u.fsPath, 'delete')),
      vscode.window.onDidChangeActiveTextEditor((e) => void this.autoReveal(e)),
      vscode.commands.registerCommand('csharpWorkbench.refresh', () => { this.core.reset(); this.emitter.fire(undefined); }),
      vscode.commands.registerCommand('csharpWorkbench.toggleShowAllFiles', toggle(true)),
      vscode.commands.registerCommand('csharpWorkbench.hideAllFiles', toggle(false)),
      vscode.commands.registerCommand('csharpWorkbench.selectSolution', () => this.selectSolution()),
      { dispose: () => clearTimeout(this.timer) },
    );
    return this.disposables;
  }

  async selectSolution(): Promise<void> {
    const sols = (await this.core.targets()).filter((t) => t.kind !== 'csproj');
    if (sols.length === 0) return;
    const pick = await vscode.window.showQuickPick(
      sols.map((t) => ({ label: t.name, description: vscode.workspace.asRelativePath(t.path), path: t.path })),
      { placeHolder: vscode.l10n.t('Select a solution') },
    );
    if (!pick) return;
    await setSelectedSolution(this.ws, pick.path);
    this.core.reset();
    this.emitter.fire(undefined);
  }

  private dnd(): vscode.TreeDragAndDropController<TreeNode> {
    const mime = 'application/vnd.code.tree.csharpworkbench.solutionexplorer';
    return {
      dragMimeTypes: [mime],
      dropMimeTypes: [mime],
      handleDrag: (nodes, data) => {
        const movable = nodes.filter((n) => (n.kind === 'file' || n.kind === 'folder') && n.path && !/\.(linked|virtual)(\.|$)/.test(n.contextValue));
        if (movable.length > 0) data.set(mime, new vscode.DataTransferItem(movable.map((n) => n.path!)));
      },
      handleDrop: async (target, data) => {
        const sources = dedupeNested((data.get(mime)?.value as string[] | undefined) ?? []);
        if (!sources?.length || !target || !target.path || (target.kind !== 'folder' && target.kind !== 'project')) return;
        const dir = target.kind === 'project' ? path.dirname(target.path) : target.path;
        const err = validateDrop(this.core, sources, dir);
        if (err) {
          void vscode.window.showErrorMessage(err === 'Files can only be moved within the same project.'
            ? vscode.l10n.t('Files can only be moved within the same project.') : vscode.l10n.t('A folder cannot be moved into itself.'));
          return;
        }
        try {
          for (const s of sources) {
            if (path.dirname(s) === dir) continue;
            const dest = path.join(dir, path.basename(s));
            if (await fsp.access(dest).then(() => true, () => false)) throw new FileExistsError(path.basename(s));
            await vscode.workspace.fs.rename(vscode.Uri.file(s), vscode.Uri.file(dest));
          }
        } catch (e) {
          void vscode.window.showErrorMessage(e instanceof FileExistsError
            ? vscode.l10n.t('File already exists: {0}', e.fileName) : e instanceof Error ? e.message : String(e));
        } finally { this.invalidatePath(dir); }
      },
    };
  }

  private queue(fsPath: string, event: FsEvent): void {
    if (!shouldInvalidate(fsPath, event, this.core.showAllFiles)) return;
    const ext = path.extname(fsPath).toLowerCase();
    const structural = event !== 'change';
    if (ext !== '.sln' && ext !== '.slnx' && !this.core.projectForPath(fsPath) && !(structural && ext === '.csproj')) return;
    this.pending.set(fsPath, (this.pending.get(fsPath) ?? false) || structural);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), DEBOUNCE_MS);
  }

  private flush(): void {
    const batch = [...this.pending];
    this.pending.clear();
    const nodes = new Set<TreeNode>();
    for (const [p, structural] of batch) {
      const hit = this.core.invalidate(p, structural);
      if (hit === null) { this.emitter.fire(undefined); return; }
      if (hit) nodes.add(hit);
    }
    for (const n of nodes) this.emitter.fire(n);
  }

  private async autoReveal(editor: vscode.TextEditor | undefined): Promise<void> {
    if (!editor || editor.document.uri.scheme !== 'file' || !this.view?.visible) return;
    if (!vscode.workspace.getConfiguration('csharpWorkbench').get<boolean>('solutionExplorer.autoReveal', true)) return;
    try {
      const node = await this.core.nodeForPath(editor.document.uri.fsPath);
      if (node) await this.view.reveal(node, { select: true, focus: false, expand: true });
    } catch { /* reveal is best-effort */ }
  }

  async getChildren(element?: TreeNode): Promise<TreeNode[]> {
    if (element) return this.core.children(element);
    const roots = await this.core.roots();
    const sols = (await this.core.targets()).filter((t) => t.kind !== 'csproj');
    // Only a loaded .sln/.slnx counts: loose .csproj files hide the solution-only menus (spec §7a).
    void vscode.commands.executeCommand('setContext', 'csharpWorkbench.hasSolution', !!this.core.solutionPath);
    void vscode.commands.executeCommand('setContext', 'csharpWorkbench.multipleSolutions', sols.length > 1);
    return roots;
  }

  getParent(node: TreeNode): TreeNode | undefined { return this.core.getParent(node); }

  getTreeItem(node: TreeNode): vscode.TreeItem {
    const hasKids = node.kind === 'project' || !!node.children?.length;
    const state = node.kind === 'solution' ? vscode.TreeItemCollapsibleState.Expanded
      : hasKids ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None;
    const item = new vscode.TreeItem(labelOf(node), state);
    item.id = node.id;
    item.contextValue = node.contextValue;
    if (node.kind === 'file' || node.kind === 'folder') {
      item.resourceUri = vscode.Uri.file(node.path!);
      if (node.kind === 'folder') item.iconPath = vscode.ThemeIcon.Folder;
      else item.command = { command: 'vscode.open', title: vscode.l10n.t('Open'), arguments: [item.resourceUri] };
    } else {
      const icon = ICONS[node.kind];
      if (icon) item.iconPath = new vscode.ThemeIcon(icon);
    }
    if (node.missing) item.iconPath = new vscode.ThemeIcon('warning');
    item.description = node.contextValue.endsWith('.startup') ? vscode.l10n.t('(startup)')
      : node.missing ? vscode.l10n.t('missing')
      : node.contextValue.endsWith('.excluded') ? vscode.l10n.t('excluded') : node.description;
    if (node.kind === 'warning') item.tooltip = node.description;
    return item;
  }

  dispose(): void { vscode.Disposable.from(...this.disposables).dispose(); }
}
