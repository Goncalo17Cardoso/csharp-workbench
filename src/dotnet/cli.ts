import { dirname } from 'node:path';
import type { ProjectInfo, ProjectPackages } from '../core/types';
import type { Output } from '../output';
import { DotnetError, type Exec } from './exec';
import { parseListPackageJson, parseSdkVersion, parseSlnList } from './parse';

export class DotnetCli {
  constructor(private exec: Exec, private dotnetPath: string, private out: Output) {}

  private async run(args: string[], cwd: string): Promise<string> {
    const r = await this.exec(this.dotnetPath, args, { cwd });
    this.out.log(args, r);
    if (r.code !== 0) {
      throw new DotnetError(
        `dotnet ${args[0]} failed (exit ${r.code}): ${(r.stderr || r.stdout).trim()}`,
        args, r.code, r.stdout, r.stderr,
      );
    }
    return r.stdout;
  }

  async sdkVersion(): Promise<string> {
    return parseSdkVersion(await this.run(['--version'], process.cwd()));
  }

  async slnList(slnPath: string): Promise<ProjectInfo[]> {
    const dir = dirname(slnPath);
    return parseSlnList(await this.run(['sln', slnPath, 'list'], dir), dir);
  }

  async listPackages(
    targetPath: string,
    opts: { outdated?: boolean; prerelease?: boolean } = {},
  ): Promise<ProjectPackages[]> {
    const args = ['list', targetPath, 'package', '--format', 'json'];
    if (opts.outdated) args.push('--outdated');
    if (opts.prerelease) args.push('--include-prerelease');
    return parseListPackageJson(await this.run(args, dirname(targetPath)));
  }

  async addPackage(projectPath: string, id: string, version: string): Promise<void> {
    await this.run(['add', projectPath, 'package', id, '--version', version], dirname(projectPath));
  }

  async removePackage(projectPath: string, id: string): Promise<void> {
    await this.run(['remove', projectPath, 'package', id], dirname(projectPath));
  }

  async restore(targetPath: string): Promise<void> {
    await this.run(['restore', targetPath], dirname(targetPath));
  }

  async configPaths(dir: string): Promise<string[]> {
    const stdout = await this.run(['nuget', 'config', 'paths', '--working-directory', dir], dir);
    return stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  }
}
