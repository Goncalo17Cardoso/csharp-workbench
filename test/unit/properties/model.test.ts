import { describe, it, expect } from 'vitest';
import { ChangedOnDiskError } from '../../../src/core/atomicWrite';
import { loadProperties, saveProperties, type PropertiesDeps } from '../../../src/properties/model';

const P = '/p/a.csproj';
const CSPROJ = '<Project Sdk="Microsoft.NET.Sdk">\n  <PropertyGroup>\n    <TargetFramework>net8.0</TargetFramework>\n  </PropertyGroup>\n</Project>\n';

function mk(initial: string, evalFn: (names: string[], disk: string) => Record<string, string>) {
  const disk = { text: initial, writes: [] as string[] };
  const deps: PropertiesDeps = {
    readText: async () => disk.text,
    getProperties: async (_p, names) => evalFn(names, disk.text),
    writer: {
      readFile: async () => disk.text,
      writeFile: async (p, s) => { if (p.endsWith('.cw-tmp')) disk.writes.push(s); if (!p.endsWith('.cw-bak') && !p.endsWith('.cw-tmp')) disk.text = s; },
      rename: async (a, b) => { void a; disk.text = disk.writes.at(-1)!; void b; },
      unlink: async () => {},
      realpath: async (p) => p,
      mode: async () => 0o644,
      chmod: async () => {},
      canWrite: async () => true,
    },
  };
  return { disk, deps };
}

describe('model', () => {
  it('loadProperties marks Nullable inherited when absent from csproj but evaluated', async () => {
    const { deps } = mk(CSPROJ, () => ({ Nullable: 'enable', TargetFramework: 'net8.0', TargetFrameworks: '' }));
    const m = await loadProperties(P, deps);
    const n = m.fields.find((f) => f.property === 'Nullable')!;
    expect(n).toMatchObject({ origin: 'inherited', evaluated: 'enable', raw: undefined });
    expect(m.fields.find((f) => f.property === 'TargetFramework')).toMatchObject({ origin: 'project', raw: 'net8.0' });
    expect(m.readOnly).toBe(false);
  });
  it('loadProperties goes readOnly with error and empty values when evaluation throws', async () => {
    const { deps } = mk(CSPROJ, () => { throw new Error('boom'); });
    const m = await loadProperties(P, deps);
    expect(m.readOnly).toBe(true);
    expect(m.error).toBe('boom');
    expect(m.fields.every((f) => f.evaluated === '')).toBe(true);
  });
  it('saveProperties refuses when file changed on disk', async () => {
    const { deps, disk } = mk(CSPROJ, () => ({}));
    const m = await loadProperties(P, deps);
    disk.text = CSPROJ + '<!-- x -->';
    await expect(saveProperties(m, [{ kind: 'set', name: 'LangVersion', value: '12' }], deps)).rejects.toBeInstanceOf(ChangedOnDiskError);
    expect(disk.writes).toEqual([]);
  });
  it('saveProperties restores original when validation value mismatches', async () => {
    const { deps, disk } = mk(CSPROJ, () => ({ LangVersion: 'other' }));
    const m = await loadProperties(P, deps);
    await expect(saveProperties(m, [{ kind: 'set', name: 'LangVersion', value: '12' }], deps)).rejects.toThrow(/LangVersion/);
    expect(disk.text).toBe(CSPROJ);
  });
  it('saveProperties succeeds and reloads', async () => {
    const { deps, disk } = mk(CSPROJ, (_n, text) => ({ LangVersion: /<LangVersion>(.*?)</.exec(text)?.[1] ?? '' }));
    const m = await loadProperties(P, deps);
    const out = await saveProperties(m, [{ kind: 'set', name: 'LangVersion', value: '12' }], deps);
    expect(disk.text).toContain('<LangVersion>12</LangVersion>');
    expect(out.fields.find((f) => f.property === 'LangVersion')).toMatchObject({ origin: 'project', raw: '12', evaluated: '12' });
  });
});
