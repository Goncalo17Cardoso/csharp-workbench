import { describe, expect, it, vi } from 'vitest';
import { DotnetCli } from '../../../src/dotnet/cli';
import type { Exec } from '../../../src/dotnet/exec';

const mk = (stdout: string) => {
  const exec = vi.fn<Exec>(async () => ({ code: 0, stdout, stderr: '' }));
  return { exec, cli: new DotnetCli(exec as unknown as Exec, '/usr/bin/dotnet', { log: vi.fn(), info: vi.fn() }) };
};

describe('DotnetCli.getProperties', () => {
  it('parses JSON output for two names', async () => {
    const { cli, exec } = mk('{"Properties":{"Nullable":"enable","Version":"1.2.0"}}');
    expect(await cli.getProperties('/p/A.csproj', ['Nullable', 'Version'])).toEqual({ Nullable: 'enable', Version: '1.2.0' });
    expect(exec.mock.calls[0][1]).toEqual(['msbuild', '/p/A.csproj', '-getProperty:Nullable', '-getProperty:Version']);
  });
  it('returns plain text for one name', async () => {
    const { cli } = mk('net8.0\n');
    expect(await cli.getProperties('/p/A.csproj', ['TargetFramework'])).toEqual({ TargetFramework: 'net8.0' });
  });
  it("fills missing names with ''", async () => {
    const { cli } = mk('{"Properties":{"A":"x"}}');
    expect(await cli.getProperties('/p/A.csproj', ['A', 'B'])).toEqual({ A: 'x', B: '' });
  });
  it('returns {} for no names without running a process', async () => {
    const { cli, exec } = mk('');
    expect(await cli.getProperties('/p/A.csproj', [])).toEqual({});
    expect(exec).not.toHaveBeenCalled();
  });
  it('passes the timeout', async () => {
    const { cli, exec } = mk('{"Properties":{}}');
    await cli.getProperties('/p/A.csproj', ['A', 'B']);
    expect((exec.mock.calls[0][2] as { timeoutMs?: number }).timeoutMs).toBe(60_000);
  });
});
