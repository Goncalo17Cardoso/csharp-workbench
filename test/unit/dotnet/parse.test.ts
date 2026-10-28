import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseSlnList, parseListPackageJson, parseSdkVersion, parseGetItems } from '../../../src/dotnet/parse';

const fx = (n: string) => readFileSync(join(__dirname, '../../fixtures/cli', n), 'utf8');

describe('parse', () => {
  it('parses sln list into absolute project paths', () => {
    const r = parseSlnList(fx('sln-list.txt'), '/work/Demo');
    expect(r).toEqual([
      { path: '/work/Demo/src/Multi/Multi.csproj', name: 'Multi' },
      { path: '/work/Demo/src/My App #1/App.csproj', name: 'App' },
    ]);
  });
  it('parses list package json', () => {
    const app = parseListPackageJson(fx('list-package.json')).find((p) => p.project.name === 'App')!;
    expect(app.project.path).toBe('/work/Demo/src/My App #1/App.csproj');
    expect(app.packages).toContainEqual({ id: 'Serilog', requested: '4.2.0', resolved: '4.2.0', framework: 'net8.0', latest: undefined });
  });
  it('parses outdated latestVersion', () => {
    const app = parseListPackageJson(fx('list-package-outdated.json')).find((p) => p.project.name === 'App')!;
    expect(app.packages.find((x) => x.id === 'Serilog')!.latest).toBe('4.4.0');
  });
  it('multi-target project yields one ref per framework', () => {
    const m = parseListPackageJson(fx('list-package-multitarget.json')).find((p) => p.project.name === 'Multi')!;
    const nj = m.packages.filter((x) => x.id === 'Newtonsoft.Json');
    expect(nj.map((x) => x.framework).sort()).toEqual(['net10.0', 'net8.0']);
    expect(nj.find((x) => x.framework === 'net8.0')!.resolved).toBe('12.0.1');
    expect(nj.find((x) => x.framework === 'net10.0')!.resolved).toBe('13.0.3');
  });
  it('tolerates text before the JSON (deprecation notices)', () => {
    const r = parseListPackageJson('warning: notice\n' + fx('list-package.json'));
    expect(r).toHaveLength(2);
  });
  it('parses sdk version', () => {
    expect(parseSdkVersion('10.0.102\n')).toBe('10.0.102');
  });
  it('parseGetItems reads Compile and None with Link', () => {
    const r = parseGetItems('notice\n' + fx('getitem.json'));
    const linked = r.Compile.find((i) => i.identity === '../Shared/Shared.cs');
    expect(linked?.link).toBe('Shared/Shared.cs');
    expect(linked?.fullPath.startsWith('/')).toBe(true);
    expect(r.Compile[0].link).toBeUndefined();
    expect(r.None).toHaveLength(1);
  });
});
