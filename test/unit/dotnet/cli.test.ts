import { describe, it, expect, vi } from 'vitest';
import { DotnetCli } from '../../../src/dotnet/cli';
import { DotnetError, type Exec } from '../../../src/dotnet/exec';

const mk = (res = { code: 0, stdout: '', stderr: '' }) => {
  const exec = vi.fn<Exec>(async () => res);
  const out = { log: vi.fn(), info: vi.fn() };
  return { exec, out, cli: new DotnetCli(exec as unknown as Exec, '/usr/bin/dotnet', out) };
};

describe('DotnetCli', () => {
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
