import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { getActiveProfileName, setActiveProfileName } from '../launch/activeProfile';
import { nodeTextFs } from '../core/atomicWrite';
import type { DotnetCli } from '../dotnet/cli';
import type { TreeNode } from '../solution/model';
import { confirmAction } from '../solution/confirm';
import { loadSolution } from '../solution/slnParse';
import type { SolutionTreeProvider } from '../solution/SolutionTreeProvider';
import { PropertiesController } from './controller';
import { scanCsproj } from './csprojScan';
import { PropertiesPanel } from './PropertiesPanel';

interface Deps {
  ws: vscode.Memento;
  extensionUri: vscode.Uri;
  provider: SolutionTreeProvider;
  getCli(): Promise<DotnetCli | undefined>;
}

interface Open { panel?: PropertiesPanel; controller?: PropertiesController }

const readText = (p: string) => fsp.readFile(p, 'utf8');
const projName = (p: string) => path.basename(p).replace(/\.[a-z]+proj$/i, '');

export function registerPropertiesCommands(deps: Deps): vscode.Disposable[] {
  const open = new Map<string, Open>(); // one panel per project path

  async function pickProject(): Promise<string | undefined> {
    const sln = deps.provider.treeCore.solutionPath;
    if (!sln) { void vscode.window.showInformationMessage(vscode.l10n.t('No solution is open.')); return undefined; }
    const model = await loadSolution(sln, readText);
    const pick = await vscode.window.showQuickPick(
      model.projects.map((p) => ({ label: p.name, description: vscode.workspace.asRelativePath(p.path), path: p.path })),
      { placeHolder: vscode.l10n.t('Select a project') },
    );
    return pick?.path;
  }

  async function openAt(project: string, property: string): Promise<void> {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(project));
    const last = scanCsproj(doc.getText()).occurrences.filter((o) => o.name === property).at(-1);
    const pos = doc.positionAt(last?.start ?? 0);
    await vscode.window.showTextDocument(doc, { selection: new vscode.Range(pos, pos) });
  }

  async function openProperties(node?: TreeNode): Promise<void> {
    const project = node?.kind === 'project' ? node.path : await pickProject();
    if (!project) return;
    if (open.has(project)) { open.get(project)!.panel?.reveal(); return; }
    open.set(project, {}); // placeholder before the first await: a second invocation must not open another panel
    const cli = await deps.getCli();
    if (!cli) {
      open.delete(project);
      void vscode.window.showErrorMessage(vscode.l10n.t('The .NET SDK was not found'));
      return;
    }

    const controller: PropertiesController = new PropertiesController(project, {
      readText,
      getProperties: (p, names) => cli.getProperties(p, names),
      writer: nodeTextFs,
      launch: {
        read: async (p) => {
          try { return await fsp.readFile(p, 'utf8'); } catch (e) {
            if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
            throw e;
          }
        },
        create: async (p, text) => {
          await fsp.mkdir(path.dirname(p), { recursive: true });
          await fsp.writeFile(p, text, { encoding: 'utf8', flag: 'wx' });
        },
        confirmDelete: (name) => confirmAction(vscode.l10n.t('Delete profile {0}?', name), undefined, vscode.l10n.t('Delete')),
        getActive: () => getActiveProfileName(deps.ws, project),
        setActive: async (name) => {
          await setActiveProfileName(deps.ws, project, name);
          void vscode.commands.executeCommand('csharpWorkbench.refresh');
        },
      },
      post: (m) => panel.post(m),
      onSecrets: () => void vscode.commands.executeCommand('csharpWorkbench.manageUserSecrets', { kind: 'project', path: project }),
      openAt: (property) => void openAt(project, property),
      t: (message, ...args) => vscode.l10n.t(message, ...args),
    });
    const panel: PropertiesPanel = new PropertiesPanel(
      deps.extensionUri,
      vscode.l10n.t('{0} Properties', projName(project)),
      (m) => void controller.handle(m),
      () => {
        open.delete(project);
        watcher.dispose();
        if (controller.dirty) {
          void vscode.window.showWarningMessage(
            vscode.l10n.t('Save changes to the properties of {0}?', projName(project)),
            { modal: true }, vscode.l10n.t('Save'), vscode.l10n.t('Don\'t Save'),
          ).then(async (choice) => {
            if (choice !== vscode.l10n.t('Save')) return;
            if (!(await controller.saveCurrent())) {
              void vscode.window.showErrorMessage(vscode.l10n.t('The changes to {0} were not saved.', projName(project)));
            }
          });
        }
      },
    );
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(path.dirname(project)), path.basename(project)),
    );
    const changed = () => controller.onFileChanged();
    watcher.onDidChange(changed);
    watcher.onDidCreate(changed);
    watcher.onDidDelete(changed);
    open.set(project, { panel, controller });
  }

  return [
    vscode.commands.registerCommand('csharpWorkbench.projectProperties', (n?: TreeNode) => openProperties(n)),
    vscode.commands.registerCommand('csharpWorkbench.projectProperties.save', () => {
      for (const o of open.values()) if (o.panel?.active) void o.controller?.saveCurrent();
    }),
  ];
}
