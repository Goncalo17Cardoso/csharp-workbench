import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { DotnetCli } from '../../dotnet/cli';
import { confirmAction } from '../confirm';
import { presetString } from '../presets';
import type { CodeKind } from '../codeTemplates';
import type { ProjectInfoData, TreeNode } from '../model';
import { namespaceFor } from '../naming';
import { readProjectInfo } from '../projectInfo';
import { TemplateCatalog } from '../templateCatalog';
import type { SolutionTreeProvider } from '../SolutionTreeProvider';
import {
  canPasteInto, copyName, dedupeNested, FileExistsError, isSamePathIgnoreCase, type NameError, createBuiltIn, createFromCatalog, ensureNotExists, newItemChoices, validateName,
} from './files';

interface Deps {
  provider: SolutionTreeProvider;
  getCli(): Promise<DotnetCli | undefined>;
  showOutput(): void;
}

const tName = (e: NameError) =>
  e.code === 'empty' ? vscode.l10n.t('A name is required.')
    : e.code === 'chars' ? vscode.l10n.t('A name cannot contain any of: / \\ : * ? " < > |')
      : vscode.l10n.t('File already exists: {0}', e.name);
const errText = (e: unknown) =>
  e instanceof FileExistsError ? vscode.l10n.t('File already exists: {0}', e.fileName) : e instanceof Error ? e.message : String(e);

const tLabel = (l: string) => ({
  Code: vscode.l10n.t('Code'), Templates: vscode.l10n.t('Templates'), Class: vscode.l10n.t('Class'),
  Interface: vscode.l10n.t('Interface'), Enum: vscode.l10n.t('Enum'), Record: vscode.l10n.t('Record'),
  Struct: vscode.l10n.t('Struct'),
} as Record<string, string>)[l] ?? l;

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
  const folderOf = (n: TreeNode) => n.kind === 'file' ? path.dirname(n.path!) : n.kind === 'project' || n.kind === 'solution' ? path.dirname(n.path!) : n.path!;
  const projectOf = (p: string) => core.projectForPath(p);
  const fail = (e: unknown) => void vscode.window.showErrorMessage(errText(e));
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
      validateInput: async (v) => {
        const err = validateName(v, () => false);
        if (err) return tName(err);
        return await exists(path.join(folder, ext && !v.toLowerCase().endsWith(ext) ? v + ext : v))
          ? tName({ code: 'exists', name: v }) : undefined;
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

  async function addFromCatalog(node: TreeNode, shortName: string, preset?: string): Promise<void> {
    const folder = folderOf(node);
    const proj = projectOf(folder);
    const cli = await deps.getCli();
    if (!proj || !cli) { fail(new Error(vscode.l10n.t('The .NET SDK was not found'))); return; }
    catalog ??= new TemplateCatalog(cli);
    const name = preset ?? await vscode.window.showInputBox({
      prompt: vscode.l10n.t('Name'),
      validateInput: (v) => { const e = validateName(v, () => false); return e ? tName(e) : undefined; },
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

  /** `shortName` and `name` let the Test-mode API answer the prompts programmatically. */
  async function newItem(node?: TreeNode, shortNameArg?: unknown, nameArg?: unknown): Promise<void> {
    if (!node) return;
    const shortName = presetString(shortNameArg);
    if (shortName !== undefined) { await addFromCatalog(node, shortName, presetString(nameArg)); return; }
    const cli = await deps.getCli();
    const qp = vscode.window.createQuickPick<vscode.QuickPickItem & { choice?: ReturnType<typeof newItemChoices>[number] }>();
    qp.placeholder = vscode.l10n.t('Select an item template');
    const toItems = (list: Parameters<typeof newItemChoices>[0]) => newItemChoices(list).map((c) => ({
      label: c.kind === 'template' ? c.label : tLabel(c.label),
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
    } catch (e) { fail(e); } finally { touch(folder); }
  }

  async function rename(node?: TreeNode): Promise<void> {
    if (!node?.path) return;
    const old = path.basename(node.path);
    const dir = path.dirname(node.path);
    const name = await vscode.window.showInputBox({
      value: old, valueSelection: [0, old.length - path.extname(old).length],
      validateInput: async (v) => {
        if (v === old) return undefined;
        const e = validateName(v, () => false);
        if (e) return tName(e);
        const t = path.join(dir, v);
        return !isSamePathIgnoreCase(node.path!, t) && await exists(t) ? tName({ code: 'exists', name: v }) : undefined;
      },
    });
    if (!name || name === old) return;
    try {
      await vscode.workspace.fs.rename(vscode.Uri.file(node.path), vscode.Uri.file(path.join(dir, name)));
    } catch (e) { fail(e); } finally { touch(dir); }
  }

  async function del(node?: TreeNode, nodes?: TreeNode[]): Promise<void> {
    const keep = new Set(dedupeNested(selection(node, nodes).filter((n) => n.path).map((n) => n.path!)));
    const sel = selection(node, nodes).filter((n) => n.path && keep.delete(n.path));
    if (sel.length === 0) return;
    const msg = sel.length === 1
      ? vscode.l10n.t('Delete {0}?', sel[0].label) : vscode.l10n.t('Delete {0} items?', sel.length);
    if (!(await confirmAction(msg, vscode.l10n.t('Items are moved to the Trash.'), vscode.l10n.t('Delete')))) return;
    try {
      for (const n of sel) await vscode.workspace.fs.delete(vscode.Uri.file(n.path!), { recursive: true, useTrash: true });
    } catch (e) { fail(e); } finally { for (const n of sel) touch(n.path!); }
  }

  const copy = (node?: TreeNode, nodes?: TreeNode[]) => {
    clipboard = selection(node, nodes).map((n) => n.path!).filter(Boolean);
  };

  async function paste(node?: TreeNode): Promise<void> {
    if (!node || clipboard.length === 0) return;
    const folder = folderOf(node);
    if (!canPasteInto(clipboard, folder)) { fail(new Error(vscode.l10n.t('A folder cannot be pasted into itself.'))); return; }
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
    reg('newClass', (n?: TreeNode, name?: unknown) => n && addBuiltIn(n, 'class', presetString(name))),
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
