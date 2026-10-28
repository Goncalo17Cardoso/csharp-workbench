import { describe, it, expect, vi } from 'vitest';
import { DotnetCli } from '../../../src/dotnet/cli';
import { DotnetError, type Exec } from '../../../src/dotnet/exec';

const mk = (res = { code: 0, stdout: '', stderr: '' }) => {
  const exec = vi.fn<Exec>(async () => res);
  const out = { log: vi.fn(), info: vi.fn() };
  return { exec, out, cli: new DotnetCli(exec as unknown as Exec, '/usr/bin/dotnet', out) };
};

describe('DotnetCli', () => {
  it('sdkVersion runs in the given cwd so global.json is honoured', async () => {
    const { cli, exec } = mk({ code: 0, stdout: '9.0.200\n', stderr: '' });
    expect(await cli.sdkVersion('/p/My App #1')).toBe('9.0.200');
    expect(exec).toHaveBeenCalledWith('/usr/bin/dotnet', ['--version'], expect.objectContaining({ cwd: '/p/My App #1' }));
  });

  it('addPackage builds exact args', async () => {
    const { cli, exec } = mk();
    await cli.addPackage('/p/A.csproj', 'Serilog', '4.2.0');
    expect(exec).toHaveBeenCalledWith('/usr/bin/dotnet', ['add', '/p/A.csproj', 'package', 'Serilog', '--version', '4.2.0'], expect.objectContaining({ cwd: '/p' }));
  });
  it('builds other commands', async () => {
    const { cli, exec } = mk({ code: 0, stdout: '{"projects":[]}', stderr: '' });
    await cli.listPackages('/p/A.csproj', { outdated: true, prerelease: true });
    expect(exec.mock.calls[0][1]).toEqual(['list', '/p/A.csproj', 'package', '--format', 'json', '--outdated', '--include-prerelease']);
    await cli.removePackage('/p/A.csproj', 'X');
    expect(exec.mock.calls[1][1]).toEqual(['remove', '/p/A.csproj', 'package', 'X']);
    await cli.restore('/p/S.sln');
    expect(exec.mock.calls[2][1]).toEqual(['restore', '/p/S.sln']);
    await cli.slnList('/p/S.sln').catch(() => {});
    expect(exec.mock.calls[3][1]).toEqual(['sln', '/p/S.sln', 'list']);
  });
  it('configPaths parses lines', async () => {
    const { cli, exec } = mk({ code: 0, stdout: '/a/nuget.config\n/b/nuget.config\n', stderr: '' });
    expect(await cli.configPaths('/d')).toEqual(['/a/nuget.config', '/b/nuget.config']);
    expect(exec.mock.calls[0][1]).toEqual(['nuget', 'config', 'paths', '--working-directory', '/d']);
  });
  it('throws DotnetError with stderr on non-zero exit', async () => {
    const { cli } = mk({ code: 1, stdout: '', stderr: 'boom' });
    const e = await cli.restore('/p/S.sln').catch((x) => x);
    expect(e).toBeInstanceOf(DotnetError);
    expect(e.stderr).toBe('boom');
    expect(e.code).toBe(1);
  });
  it('every call is logged', async () => {
    const { cli, out } = mk({ code: 1, stdout: '', stderr: 'x' });
    await cli.restore('/p/S.sln').catch(() => {});
    expect(out.log).toHaveBeenCalledTimes(1);
  });
});

describe('DotnetCli solution explorer wrappers', () => {
  const call = async (f: (c: DotnetCli) => Promise<unknown>, res?: { code: number; stdout: string; stderr: string }) => {
    const m = mk(res);
    const r = await f(m.cli);
    return { args: m.exec.mock.calls[0][1], cwd: (m.exec.mock.calls[0][2] as { cwd: string }).cwd, r };
  };
  it('slnAdd builds --solution-folder args', async () => {
    expect((await call((c) => c.slnAdd('/s/A.sln', '/s/p/P.csproj', 'src/web'))).args)
      .toEqual(['sln', '/s/A.sln', 'add', '/s/p/P.csproj', '--solution-folder', 'src/web']);
  });
  it('slnAdd without folder', async () => {
    const r = await call((c) => c.slnAdd('/s/A.sln', '/s/p/P.csproj'));
    expect(r.args).toEqual(['sln', '/s/A.sln', 'add', '/s/p/P.csproj']);
    expect(r.cwd).toBe('/s');
  });
  it('slnRemove', async () => {
    expect((await call((c) => c.slnRemove('/s/A.sln', '/s/p/P.csproj'))).args).toEqual(['sln', '/s/A.sln', 'remove', '/s/p/P.csproj']);
  });
  it('add/removeReference', async () => {
    expect((await call((c) => c.addReference('/s/P.csproj', '/s/Q.csproj'))).args).toEqual(['add', '/s/P.csproj', 'reference', '/s/Q.csproj']);
    expect((await call((c) => c.removeReference('/s/P.csproj', '/s/Q.csproj'))).args).toEqual(['remove', '/s/P.csproj', 'reference', '/s/Q.csproj']);
  });
  it('newTemplate uses given cwd', async () => {
    const r = await call((c) => c.newTemplate('class', ['-n', 'Foo'], '/s/My App #1'));
    expect(r.args).toEqual(['new', 'class', '-n', 'Foo']);
    expect(r.cwd).toBe('/s/My App #1');
  });
  it('newList defaults to item, accepts project', async () => {
    const a = await call((c) => c.newList(), { code: 0, stdout: 'x', stderr: '' });
    expect(a.args).toEqual(['new', 'list', '--type', 'item']);
    expect(a.r).toBe('x');
    expect((await call((c) => c.newList('project'))).args).toEqual(['new', 'list', '--type', 'project']);
  });
  it('newHelp', async () => {
    expect((await call((c) => c.newHelp('class'))).args).toEqual(['new', 'class', '--help']);
  });
  it('userSecretsInit', async () => {
    expect((await call((c) => c.userSecretsInit('/s/P.csproj'))).args).toEqual(['user-secrets', 'init', '--project', '/s/P.csproj']);
  });
  it('getItems', async () => {
    expect((await call((c) => c.getItems('/s/P.csproj', ['Compile', 'None']))).args)
      .toEqual(['msbuild', '/s/P.csproj', '-getItem:Compile', '-getItem:None']);
  });
  it('msbuild evaluations run with a 60 s timeout, other commands without', async () => {
    const m = mk({ code: 0, stdout: 'x', stderr: '' });
    await m.cli.getItems('/s/P.csproj', ['Compile']);
    await m.cli.getProperty('/s/P.csproj', 'TargetPath');
    await m.cli.restore('/s/P.csproj');
    expect(m.exec.mock.calls.map((c) => (c[2] as { timeoutMs?: number }).timeoutMs)).toEqual([60_000, 60_000, undefined]);
  });
  it('getProperty trims, with props', async () => {
    const r = await call((c) => c.getProperty('/s/P.csproj', 'RootNamespace', { Configuration: 'Debug' }), { code: 0, stdout: ' Ns\n', stderr: '' });
    expect(r.args).toEqual(['msbuild', '/s/P.csproj', '-getProperty:RootNamespace', '-p:Configuration=Debug']);
    expect(r.r).toBe('Ns');
  });
});
