import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseNugetConfig, mergeConfigs, loadEffectiveConfig } from '../../../src/nuget/config';
import { DotnetError } from '../../../src/dotnet/exec';

const wrap = (inner: string): string => `<configuration>${inner}</configuration>`;
const P = (inner: string, file = '/r/nuget.config') => parseNugetConfig(wrap(inner), file);

describe('nuget config', () => {
  it('closest config wins on same source name', () => {
    const near = P('<packageSources><add key="A" value="https://near/index.json"/></packageSources>', '/r/a/nuget.config');
    const far = P('<packageSources><add key="a" value="https://far/index.json"/></packageSources>');
    const eff = mergeConfigs([near, far], {});
    expect(eff.sources).toHaveLength(1);
    expect(eff.sources[0].url).toBe('https://near/index.json');
  });

  it('clear drops sources from farther files', () => {
    const near = P('<packageSources><clear/><add key="n" value="https://n/index.json"/></packageSources>');
    const far = P('<packageSources><add key="f" value="https://f/index.json"/></packageSources>');
    expect(mergeConfigs([near, far], {}).sources.map((s) => s.name)).toEqual(['n']);
  });

  it('disabled sources are omitted', () => {
    const c = P('<packageSources><add key="a" value="https://a/index.json"/><add key="b" value="https://b/index.json"/></packageSources><disabledPackageSources><add key="b" value="true"/></disabledPackageSources>');
    expect(mergeConfigs([c], {}).sources.map((s) => s.name)).toEqual(['a']);
  });

  it('decodes _x0020_ in credential names', () => {
    const c = P('<packageSources><add key="my feed" value="https://m/index.json"/></packageSources><packageSourceCredentials><my_x0020_feed><add key="Username" value="u"/><add key="ClearTextPassword" value="p"/></my_x0020_feed></packageSourceCredentials>');
    expect(mergeConfigs([c], {}).sources[0].credential).toEqual({ username: 'u', password: 'p' });
  });

  it('expands %NUGET_PAT% from env', () => {
    const c = P('<packageSources><add key="s" value="https://s/index.json"/></packageSources><packageSourceCredentials><s><add key="Username" value="%U%"/><add key="ClearTextPassword" value="%NUGET_PAT%"/></s></packageSourceCredentials>');
    expect(mergeConfigs([c], { NUGET_PAT: 'tok', U: 'me' }).sources[0].credential).toEqual({ username: 'me', password: 'tok' });
    const miss = mergeConfigs([c], { U: 'me' }).sources[0];
    expect(miss.credential).toBeUndefined();
    expect(miss.warning).toBe('Environment variable NUGET_PAT is not set.');
  });

  it('encrypted password yields warning and no credential', () => {
    const c = P('<packageSources><add key="s" value="https://s/index.json"/></packageSources><packageSourceCredentials><s><add key="Username" value="u"/><add key="Password" value="AQAA"/></s></packageSourceCredentials>');
    const s = mergeConfigs([c], {}).sources[0];
    expect(s.credential).toBeUndefined();
    expect(s.warning).toBe('Encrypted passwords are not supported on macOS/Linux. Use ClearTextPassword or an environment variable.');
  });

  it('detects v3, v2 and local kinds', () => {
    const c = P('<packageSources><add key="a" value="https://a/x" protocolVersion="3"/><add key="b" value="https://b/index.json"/><add key="c" value="https://c/api/v2"/><add key="d" value="/abs/feed"/><add key="e" value="file:///abs/e"/></packageSources>');
    expect(mergeConfigs([c], {}).sources.map((s) => s.kind)).toEqual(['v3', 'v3', 'v2', 'local', 'local']);
  });

  it('resolves relative local paths against the config file dir', () => {
    const c = P('<packageSources><add key="l" value="../feed"/></packageSources>', '/r/sub/nuget.config');
    expect(mergeConfigs([c], {}).sources[0].url).toBe('/r/feed');
  });

  it('reads package source mappings', () => {
    const c = P('<packageSources><add key="a" value="https://a/index.json"/></packageSources><packageSourceMapping><packageSource key="a"><package pattern="Contoso.*"/><package pattern="Serilog"/></packageSource></packageSourceMapping>');
    expect(mergeConfigs([c], {}).mappings).toEqual([
      { pattern: 'Contoso.*', sources: ['a'] },
      { pattern: 'Serilog', sources: ['a'] },
    ]);
  });

  it('adds default nuget.org when nothing is defined', () => {
    expect(mergeConfigs([], {}).sources).toEqual([{ name: 'nuget.org', url: 'https://api.nuget.org/v3/index.json', kind: 'v3' }]);
    expect(mergeConfigs([P('<packageSources><clear/></packageSources>')], {}).sources).toEqual([]);
  });

  const fixtures = path.resolve(__dirname, '../../fixtures/config');
  const read = (p: string): Promise<string> => fs.promises.readFile(p, 'utf8');

  it('loads fixtures via configPaths closest-first', async () => {
    const cli = { configPaths: async () => [path.join(fixtures, 'repo/NuGet.Config'), path.join(fixtures, 'user/NuGet.Config')] };
    const eff = await loadEffectiveConfig('/x', cli as never, read, { NUGET_PAT: 't' });
    expect(eff.sources.map((s) => s.name)).toEqual(['shared', 'local feed', 'nuget.org']);
    expect(eff.sources[0].credential).toEqual({ username: 'bot', password: 't' });
    expect(eff.sources[1].url).toBe(path.join(fixtures, 'repo/feed'));
  });

  it('falls back to walking up when configPaths fails', async () => {
    const cli = { configPaths: async () => { throw new DotnetError('x', [], 1, '', ''); } };
    const files: Record<string, string> = {
      '/w/p/nuget.config': wrap('<packageSources><add key="a" value="https://a/index.json"/></packageSources>'),
      '/home/.nuget/NuGet/NuGet.Config': wrap('<packageSources><add key="h" value="https://h/index.json"/></packageSources>'),
    };
    const rd = async (p: string): Promise<string> => { if (p in files) { return files[p]; } throw new Error('ENOENT'); };
    const eff = await loadEffectiveConfig('/w/p/q', cli as never, rd, {}, '/home');
    expect(eff.sources.map((s) => s.name)).toEqual(['a', 'h']);
  });
});
