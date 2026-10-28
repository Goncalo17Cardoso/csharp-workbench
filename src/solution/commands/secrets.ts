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
        mkdirp: async (d, mode) => void (await fsp.mkdir(d, { recursive: true, mode })),
        writeFile: (p, s, mode) => fsp.writeFile(p, s, { encoding: 'utf8', mode, flag: 'wx' }),
      }, os.homedir());
      await vscode.window.showTextDocument(vscode.Uri.file(file));
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      const bad = /^Invalid UserSecretsId: (.*)$/s.exec(m);
      void vscode.window.showErrorMessage(bad
        ? vscode.l10n.t('Invalid UserSecretsId: {0}', bad[1])
        : vscode.l10n.t('Could not manage user secrets: {0}', m));
    }
  })];
}
