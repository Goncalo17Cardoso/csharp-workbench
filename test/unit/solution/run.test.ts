import { describe, expect, it, vi } from 'vitest';
import { DotnetCli } from '../../../src/dotnet/cli';
import type { Exec } from '../../../src/dotnet/exec';
import { debugConfigFor, dotnetTask, runTfm, targetPathStep } from '../../../src/solution/runCore';

describe('dotnetTask', () => {
  it('build', () => expect(dotnetTask('build', '/s/Api/MyApp.Api.csproj', 'dotnet'))
    .toEqual({ name: 'Build MyApp.Api', args: ['build', '/s/Api/MyApp.Api.csproj'] }));
  it('rebuild uses --no-incremental', () => expect(dotnetTask('rebuild', '/s/MyApp.sln', 'dotnet'))
    .toEqual({ name: "Rebuild Solution 'MyApp'", args: ['build', '/s/MyApp.sln', '--no-incremental'] }));
  it('clean', () => expect(dotnetTask('clean', '/s/MyApp.slnx', 'dotnet').args).toEqual(['clean', '/s/MyApp.slnx']));
  it('run uses --project', () => expect(dotnetTask('run', '/s/A.csproj', 'dotnet'))
    .toEqual({ name: 'Run A', args: ['run', '--project', '/s/A.csproj'] }));
  it('build with tfm adds -f', () => {
    expect(dotnetTask('build', '/s/A.csproj', 'dotnet', 'net8.0').args).toEqual(['build', '/s/A.csproj', '-f', 'net8.0']);
    expect(dotnetTask('rebuild', '/s/A.csproj', 'dotnet', 'net8.0').args).toEqual(['build', '/s/A.csproj', '--no-incremental', '-f', 'net8.0']);
  });
});

describe('debugConfigFor', () => {
  it('debug config is coreclr launch with program and cwd', () => {
    expect(debugConfigFor('/s/Api/Api.csproj', '/s/Api/bin/Debug/net8.0/Api.dll', 'Api')).toEqual({
      type: 'coreclr', request: 'launch', name: 'C# Workbench: Api', program: '/s/Api/bin/Debug/net8.0/Api.dll',
      cwd: '/s/Api', console: 'integratedTerminal', stopAtEntry: false,
    });
  });
});

describe('targetPathStep', () => {
  it('uses a single line', () => expect(targetPathStep('/a/b.dll\n', ['net8.0'])).toEqual({ kind: 'path', path: '/a/b.dll' }));
  it('retries with first tfm when empty', () => expect(targetPathStep('', ['net8.0', 'net9.0'])).toEqual({ kind: 'retry', tfm: 'net8.0' }));
  it('retries when multi-line', () => expect(targetPathStep('a\nb', ['net9.0'])).toEqual({ kind: 'retry', tfm: 'net9.0' }));
  it('fails without tfms', () => expect(targetPathStep('', [])).toEqual({ kind: 'fail' }));
  it('getProperty passes TargetFramework for multi-target', async () => {
    const exec = vi.fn<Exec>(async () => ({ code: 0, stdout: 'x', stderr: '' }));
    const cli = new DotnetCli(exec as unknown as Exec, 'dotnet', { log: vi.fn(), info: vi.fn() });
    await cli.getProperty('/s/A.csproj', 'TargetPath', { TargetFramework: 'net8.0' });
    expect(exec.mock.calls[0][1]).toEqual(['msbuild', '/s/A.csproj', '-getProperty:TargetPath', '-p:TargetFramework=net8.0']);
  });
});

describe('run on multi-target', () => {
  it('run with tfm adds -f', () => expect(dotnetTask('run', '/s/A.csproj', 'dotnet', 'net8.0').args)
    .toEqual(['run', '--project', '/s/A.csproj', '-f', 'net8.0']));
  it('runTfm: single -> undefined, multi -> first', () => {
    expect(runTfm(['net8.0'])).toBeUndefined();
    expect(runTfm([])).toBeUndefined();
    expect(runTfm(['net8.0', 'net9.0'])).toBe('net8.0');
  });
});
