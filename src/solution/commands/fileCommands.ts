import { existsSync } from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { DotnetCli } from '../../dotnet/cli';
import { confirmAction } from '../confirm';
import type { CodeKind } from '../codeTemplates';
import type { ProjectInfoData, TreeNode } from '../model';
import { namespaceFor } from '../naming';
import { readProjectInfo } from '../projectInfo';
import { TemplateCatalog } from '../templateCatalog';
import type { SolutionTreeProvider } from '../SolutionTreeProvider';
import {
  copyName, createBuiltIn, createFromCatalog, ensureNotExists, newItemChoices, validateName,
} from './files';

interface Deps {
  provider: SolutionTreeProvider;
  getCli(): Promise<DotnetCli | undefined>;
  showOutput(): void;
}

const exists = (p: string) => fsp.access(p).then(() => true, () => false);

async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...await listFiles(p));
    else out.push(p);
  }
  return out;
}

export function registerFileCommands(deps: Deps): vscode.Disposable[] {
  const { provider } = deps;
  const core = provider.treeCore;
  let clipboard: string[] = [];
  let catalog: TemplateCatalog | undefined;

  const selection = (node?: TreeNode, nodes?: TreeNode[]) => (nodes?.length ? nodes : node ? [node] : []);
  const folderOf = (n: TreeNode) => n.kind === 'file' ? path.dirname(n.path!) : n.kind === 'project' ? path.dirname(n.path!) : n.path!;
  const projectOf = (p: string) => core.projectForPath(p);
  const fail = (e: unknown) => void vscode.window.showErrorMessage(e instanceof Error ? e.message : String(e));
  const touch = (p: string) => provider.invalidatePath(p);
  const open = (p: string) => vscode.window.showTextDocument(vscode.Uri.file(p));

  async function infoFor(projectPath: string): Promise<ProjectInfoData> {
    try { return readProjectInfo(projectPath, await fsp.readFile(projectPath, 'utf8')); } catch {
      return { path: projectPath, rootNamespace: path.basename(projectPath, path.extname(projectPath)), targetFrameworks: [], projectRefs: [], fileScopedNamespaces: false };
    }
  }

  async function askName(folder: string, prompt: string, ext: string): Promise<string | undefined> {
    return vscode.window.showInputBox({
      prompt, placeHolder: ext ? vscode.l10n.t('Name (default extension {0})', ext) : undefined,
      validateInput: (v) => {
        const err = validateName(v, (n) => existsSync(path.join(folder, ext && !n.toLowerCase().endsWith(ext) ? n + ext : n)));
        return err ? vscode.l10n.t(err) : undefined;
      },
    });
  }

  async function addBuiltIn(node: TreeNode, kind: CodeKind, preset?: string): Promise<void> {
    const folder = folderOf(node);
    const proj = projectOf(folder);
    if (!proj) return;
    const name = preset ?? await askName(folder, vscode.l10n.t('Name'), '.cs');
    if (!name) return;
    try {
      const file = await createBuiltIn(
        { exists, write: (p, c) => fsp.writeFile(p, c, { flag: 'wx' }) },
        kind, name, folder, path.dirname(proj.path), await infoFor(proj.path),
      );
      touch(file);
      await open(file);
    } catch (e) { fail(e); }
  }

  async function addFromCatalog(node: TreeNode, shortName: string): Promise<void> {
    const folder = folderOf(node);
    const proj = projectOf(folder);
    const cli = await deps.getCli();
    if (!proj || !cli) { fail(new Error(vscode.l10n.t('The .NET SDK was not found'))); return; }
    const name = await vscode.window.showInputBox({
      prompt: vscode.l10n.t('Name'),
      validateInput: (v) => { const e = validateName(v, () => false); return e ? vscode.l10n.t(e) : undefined; },
    });
    if (!name) return;
    const info = await infoFor(proj.path);
    try {
      const created = await createFromCatalog(
        { cli, options: (s) => catalog!.options(s), listFiles },
        shortName, name, folder, namespaceFor(info.rootNamespace, path.dirname(proj.path), folder), proj.path,
      );
      touch(folder);
      if (created.length === 0) {
        deps.showOutput();
        fail(new Error(vscode.l10n.t('The template produced no files.')));
        return;
      }
      for (const f of created) await open(f);
    } catch (e) { deps.showOutput(); fail(e); }
  }

  async function newItem(node?: TreeNode): Promise<void> {
    if (!node) return;
    const cli = await deps.getCli();
    const qp = vscode.window.createQuickPick<vscode.QuickPickItem & { choice?: ReturnType<typeof newItemChoices>[number] }>();
    qp.placeholder = vscode.l10n.t('Select an item template');
    const toItems = (list: Parameters<typeof newItemChoices>[0]) => newItemChoices(list).map((c) => ({
      label: c.kind === 'separator' ? (c.label === 'Code' ? vscode.l10n.t('Code') : vscode.l10n.t('Templates')) : c.label,
      kind: c.kind === 'separator' ? vscode.QuickPickItemKind.Separator : undefined,
      description: c.kind === 'template' ? c.description : undefined, choice: c,
    }));
    qp.items = toItems([]);
    if (cli) {
      catalog ??= new TemplateCatalog(cli);
      qp.busy = true;
      catalog.list('item').then((l) => { qp.items = toItems(l); }, () => { /* built-ins stay */ }).finally(() => { qp.busy = false; });
    }
    const picked = await new Promise<(typeof qp.items)[number] | undefined>((resolve) => {
      qp.onDidAccept(() => { resolve(qp.selectedItems[0]); qp.hide(); });
      qp.onDidHide(() => { resolve(undefined); qp.dispose(); });
      qp.show();
    });
    const c = picked?.choice;
    if (!c || c.kind === 'separator') return;
    if (c.kind === 'builtin') await addBuiltIn(node, c.code);
    else await addFromCatalog(node, c.shortName);
  }

  async function newFolder(node?: TreeNode): Promise<void> {
    if (!node) return;
    const parent = folderOf(node);
    const name = await askName(parent, vscode.l10n.t('Folder name'), '');
    if (!name) return;
    try {
      const dir = path.join(parent, name);
      await ensureNotExists(dir, exists);
      await vscode.workspace.fs.createDirectory(vscode.Uri.file(dir));
      touch(dir);
    } catch (e) { fail(e); }
  }

  async function addExisting(node?: TreeNode): Promise<void> {
    if (!node) return;
    const folder = folderOf(node);
    const picks = await vscode.window.showOpenDialog({ canSelectMany: true, canSelectFolders: false, openLabel: vscode.l10n.t('Add') });
    if (!picks?.length) return;
    try {
      for (const u of picks) {
        const target = path.join(folder, path.basename(u.fsPath));
        await ensureNotExists(target, exists);
        await vscode.workspace.fs.copy(u, vscode.Uri.file(target));
      }
      touch(folder);
    } catch (e) { fail(e); }
  }

  async function rename(node?: TreeNode): Promise<void> {
    if (!node?.path) return;
    const old = path.basename(node.path);
    const dir = path.dirname(node.path);
    const name = await vscode.window.showInputBox({
      value: old, valueSelection: [0, old.length - path.extname(old).length],
      validateInput: (v) => {
        if (v === old) return undefined;
        const e = validateName(v, (n) => existsSync(path.join(dir, n)));
        return e ? vscode.l10n.t(e) : undefined;
      },
    });
    if (!name || name === old) return;
    try {
      await vscode.workspace.fs.rename(vscode.Uri.file(node.path), vscode.Uri.file(path.join(dir, name)));
      touch(dir);
    } catch (e) { fail(e); }
  }

  async function del(node?: TreeNode, nodes?: TreeNode[]): Promise<void> {
    const sel = selection(node, nodes).filter((n) => n.path);
    if (sel.length === 0) return;
    const msg = sel.length === 1
      ? vscode.l10n.t('Delete {0}?', sel[0].label) : vscode.l10n.t('Delete {0} items?', sel.length);
    if (!(await confirmAction(msg, vscode.l10n.t('Items are moved to the Trash.'), vscode.l10n.t('Delete')))) return;
    try {
      for (const n of sel) await vscode.workspace.fs.delete(vscode.Uri.file(n.path!), { recursive: true, useTrash: true });
      for (const n of sel) touch(n.path!);
    } catch (e) { fail(e); }
  }

  const copy = (node?: TreeNode, nodes?: TreeNode[]) => {
    clipboard = selection(node, nodes).map((n) => n.path!).filter(Boolean);
  };

  async function paste(node?: TreeNode): Promise<void> {
    if (!node || clipboard.length === 0) return;
    const folder = folderOf(node);
    try {
      const names = new Set((await fsp.readdir(folder)));
      for (const src of clipboard) {
        const name = copyName(names, path.basename(src));
        names.add(name);
        await vscode.workspace.fs.copy(vscode.Uri.file(src), vscode.Uri.file(path.join(folder, name)));
      }
      touch(folder);
    } catch (e) { fail(e); }
  }

  const reg = (id: string, fn: (...a: never[]) => unknown) => vscode.commands.registerCommand(`csharpWorkbench.${id}`, fn as (...a: unknown[]) => unknown);
  return [
    reg('newItem', newItem),
    reg('newClass', (n?: TreeNode) => n && addBuiltIn(n, 'class')),
    reg('newInterface', (n?: TreeNode) => n && addBuiltIn(n, 'interface')),
    reg('newFolder', newFolder),
    reg('addExistingItem', addExisting),
    reg('rename', rename),
    reg('delete', del),
    reg('copy', copy),
    reg('paste', paste),
    reg('copyPath', async (n?: TreeNode, ns?: TreeNode[]) => {
      await vscode.env.clipboard.writeText(selection(n, ns).map((x) => x.path).filter(Boolean).join('\n'));
    }),
    reg('revealInFinder', (n?: TreeNode) => n?.path && vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(n.path))),
    reg('openInTerminal', (n?: TreeNode) => {
      if (n) vscode.window.createTerminal({ cwd: folderOf(n) }).show();
    }),
  ];
}
