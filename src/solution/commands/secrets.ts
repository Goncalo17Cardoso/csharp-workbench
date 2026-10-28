import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as vscode from 'vscode';
import type { DotnetCli } from '../../dotnet/cli';
import type { TreeNode } from '../model';
import { readProjectInfo } from '../projectInfo';
import { ensureSecrets } from '../secretsCore';

interface Deps { getCli(): Promise<DotnetCli | undefined> }

export function registerSecretsCommands(deps: Deps): vscode.Disposable[] {
  return [vscode.commands.registerCommand('csharpWorkbench.manageUserSecrets', async (n?: TreeNode) => {
    const project = n?.kind === 'project' ? n.path : undefined;
    if (!project) return;
    try {
      const cli = await deps.getCli();
      if (!cli) throw new Error(vscode.l10n.t('The .NET SDK was not found'));
      const file = await ensureSecrets(project, {
        readProject: async (p) => readProjectInfo(p, await fsp.readFile(p, 'utf8')).userSecretsId,
        init: (p) => cli.userSecretsInit(p),
        exists: async (p) => fsp.access(p).then(() => true, () => false),
        mkdirp: async (d) => void (await fsp.mkdir(d, { recursive: true })),
        writeFile: (p, s) => fsp.writeFile(p, s, 'utf8'),
      }, os.homedir());
      await vscode.window.showTextDocument(vscode.Uri.file(file));
    } catch (e) {
      void vscode.window.showErrorMessage(vscode.l10n.t('Could not manage user secrets: {0}', e instanceof Error ? e.message : String(e)));
    }
  })];
}
