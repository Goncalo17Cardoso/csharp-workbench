import { describe, expect, it, vi } from 'vitest';
import { DotnetCli } from '../../../src/dotnet/cli';
import type { Exec } from '../../../src/dotnet/exec';
import { createEndWaiter, debugConfigFor, expandEnv, dotnetTask, runTfm, targetPathStep } from '../../../src/solution/runCore';

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

describe('createEndWaiter', () => {
  const mk = () => {
    vi.useFakeTimers();
    return createEndWaiter<string>((fn, ms) => setTimeout(fn, ms), (t) => clearTimeout(t as never), 500);
  };
  const settle = async (w: ReturnType<typeof mk>) => { await vi.advanceTimersByTimeAsync(600); return w.promise; };
  it('process then task -> code', async () => {
    const w = mk(); w.setExecution('a'); w.onProcessEnd('a', 0); w.onTaskEnd('a');
    expect(await settle(w)).toBe(0); vi.useRealTimers();
  });
  it('task then process within grace -> code', async () => {
    const w = mk(); w.setExecution('a'); w.onTaskEnd('a');
    await vi.advanceTimersByTimeAsync(200); w.onProcessEnd('a', 3);
    expect(await settle(w)).toBe(3); vi.useRealTimers();
  });
  it('task only -> undefined after grace', async () => {
    const w = mk(); w.setExecution('a'); w.onTaskEnd('a');
    let v: number | undefined | 'pending' = 'pending'; void w.promise.then((x) => { v = x; });
    await vi.advanceTimersByTimeAsync(400); expect(v).toBe('pending');
    await vi.advanceTimersByTimeAsync(200); expect(v).toBeUndefined(); vi.useRealTimers();
  });
  it('early buffered process and task -> prefers process code', async () => {
    const w = mk(); w.onTaskEnd('a'); w.onProcessEnd('a', 0); w.setExecution('a');
    expect(await settle(w)).toBe(0); vi.useRealTimers();
  });
  it('ignores other executions', async () => {
    const w = mk(); w.setExecution('a'); w.onProcessEnd('b', 1); w.onTaskEnd('b'); w.onProcessEnd('a', 0);
    expect(await settle(w)).toBe(0); vi.useRealTimers();
  });
});

describe('launch profiles in run and debug', () => {
  const prof = (o: Partial<import('../../../src/launch/launchSettings').LaunchProfile> = {}) =>
    ({ name: 'https', commandName: 'Project', supported: true, environmentVariables: {}, ...o });

  it('dotnetTask run adds --launch-profile with names containing spaces as one arg', () => {
    expect(dotnetTask('run', '/s/A.csproj', 'dotnet', undefined, 'My Profile').args)
      .toEqual(['run', '--project', '/s/A.csproj', '--launch-profile', 'My Profile']);
    expect(dotnetTask('run', '/s/A.csproj', 'dotnet', 'net8.0', 'x').args)
      .toEqual(['run', '--project', '/s/A.csproj', '-f', 'net8.0', '--launch-profile', 'x']);
  });

  it('expandEnv expands %HOME% $HOME ${HOME}', () => {
    const env = { HOME: '/h' };
    expect(expandEnv('%HOME%/a $HOME/b ${HOME}/c %NOPE%$NOPE', env)).toBe('/h/a /h/b /h/c ');
  });

  it('debugConfigFor sets env, ASPNETCORE_URLS, args, cwd and serverReadyAction', () => {
    const c = debugConfigFor('/s/Api/Api.csproj', '/s/Api/bin/Api.dll', 'Api (https)', prof({
      commandLineArgs: '--a "b c" $HOME', environmentVariables: { X: '%HOME%/x' }, applicationUrl: 'https://localhost:5001',
      workingDirectory: 'sub', launchBrowser: true, launchUrl: 'swagger',
    }), { HOME: '/h' }) as Record<string, unknown>;
    expect(c.args).toEqual(['--a', 'b c', '$HOME']);
    expect(c.env).toEqual({ X: '/h/x', ASPNETCORE_URLS: 'https://localhost:5001' });
    expect(c.cwd).toBe('/s/Api/sub');
    expect(c.serverReadyAction).toEqual({
      action: 'openExternally', pattern: '\\bNow listening on:\\s+(https?://\\S+)', uriFormat: '%s/swagger',
    });
    expect(c.program).toBe('/s/Api/bin/Api.dll');
  });

  it('debugConfigFor without profile is unchanged', () => {
    expect(debugConfigFor('/s/Api/Api.csproj', '/t.dll', 'Api')).toEqual({
      type: 'coreclr', request: 'launch', name: 'C# Workbench: Api', program: '/t.dll',
      cwd: '/s/Api', console: 'integratedTerminal', stopAtEntry: false,
    });
  });

  it('Executable profile uses executablePath as program', () => {
    const c = debugConfigFor('/s/A.csproj', '/t.dll', 'A', prof({ commandName: 'Executable', executablePath: '%HOME%/bin/tool', applicationUrl: 'http://x' }), { HOME: '/h' }) as Record<string, unknown>;
    expect(c.program).toBe('/h/bin/tool');
    expect(c.env).toBeUndefined();
  });
});
