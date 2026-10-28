import { dirname } from 'node:path';
import type { ProjectInfo, ProjectPackages } from '../core/types';
import type { Output } from '../output';
import { DotnetError, type Exec } from './exec';
import { parseListPackageJson, parseSdkVersion, parseSlnList } from './parse';

/** A hung `dotnet msbuild` evaluation (offline SDK resolver, locked file) is killed after this. */
export const MSBUILD_EVAL_TIMEOUT_MS = 60_000;

export class DotnetCli {
  constructor(private exec: Exec, private dotnetPath: string, private out: Output) {}

  private async run(args: string[], cwd: string, timeoutMs?: number): Promise<string> {
    const r = await this.exec(this.dotnetPath, args, timeoutMs === undefined ? { cwd } : { cwd, timeoutMs });
    this.out.log(args, r);
    if (r.code !== 0) {
      throw new DotnetError(
        `dotnet ${args[0]} failed (exit ${r.code}): ${(r.stderr || r.stdout).trim()}`,
        args, r.code, r.stdout, r.stderr,
      );
    }
    return r.stdout;
  }

  async sdkVersion(cwd: string = process.cwd()): Promise<string> {
    return parseSdkVersion(await this.run(['--version'], cwd));
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

  async slnAdd(sln: string, project: string, solutionFolder?: string): Promise<void> {
    const args = ['sln', sln, 'add', project];
    if (solutionFolder) args.push('--solution-folder', solutionFolder);
    await this.run(args, dirname(sln));
  }

  async slnRemove(sln: string, project: string): Promise<void> {
    await this.run(['sln', sln, 'remove', project], dirname(sln));
  }

  async addReference(project: string, ref: string): Promise<void> {
    await this.run(['add', project, 'reference', ref], dirname(project));
  }

  async removeReference(project: string, ref: string): Promise<void> {
    await this.run(['remove', project, 'reference', ref], dirname(project));
  }

  async newTemplate(shortName: string, args: string[], cwd: string): Promise<void> {
    await this.run(['new', shortName, ...args], cwd);
  }

  async newList(type: 'item' | 'project' = 'item'): Promise<string> {
    return this.run(['new', 'list', '--type', type], process.cwd());
  }

  async newHelp(shortName: string): Promise<string> {
    return this.run(['new', shortName, '--help'], process.cwd());
  }

  async userSecretsInit(project: string): Promise<void> {
    await this.run(['user-secrets', 'init', '--project', project], dirname(project));
  }

  async getItems(project: string, types: string[]): Promise<string> {
    return this.run(['msbuild', project, ...types.map((t) => `-getItem:${t}`)], dirname(project), MSBUILD_EVAL_TIMEOUT_MS);
  }

  async getProperty(project: string, name: string, props: Record<string, string> = {}): Promise<string> {
    const p = Object.entries(props).map(([k, v]) => `-p:${k}=${v}`);
    return (await this.run(['msbuild', project, `-getProperty:${name}`, ...p], dirname(project), MSBUILD_EVAL_TIMEOUT_MS)).trim();
  }
}
