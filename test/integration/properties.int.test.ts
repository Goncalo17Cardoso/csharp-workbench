import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { nodeTextFs } from '../../src/core/atomicWrite';
import { DotnetCli } from '../../src/dotnet/cli';
import { nodeExec } from '../../src/dotnet/exec';
import { findDotnet } from '../../src/dotnet/locate';
import { createOutput } from '../../src/output';
import { loadProperties, saveProperties, type PropertiesDeps } from '../../src/properties/model';

const home = os.homedir();
const dotnet = await findDotnet({
  pathEnv: process.env.PATH ?? '',
  home,
  exists: (p) => fs.access(p).then(() => true, () => false),
});
const T = 240_000;

function run(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(dotnet!, args, { cwd }, (err, stdout, stderr) =>
      err ? reject(new Error(`dotnet ${args.join(' ')} failed: ${stderr || stdout || err.message}`)) : resolve(stdout),
    );
  });
}

const hasNet10 = await fs.access(path.join(home, '.dotnet', 'shared', 'Microsoft.NETCore.App')).then(
  async () => (await fs.readdir(path.join(home, '.dotnet', 'shared', 'Microsoft.NETCore.App'))).some((d) => d.startsWith('10.')),
  () => false,
);

describe.skipIf(!dotnet)('project properties validated by dotnet msbuild', () => {
  let root: string;
  let proj: string;
  let deps: PropertiesDeps;

  beforeAll(async () => {
    process.env.DOTNET_ROOT ??= path.join(home, '.dotnet');
    root = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'cw-')), 'My App #1');
    await fs.mkdir(root);
    await run(['new', 'console', '-n', 'App', '-o', '.', '-f', 'net8.0', '--no-restore'], root);
    await fs.writeFile(path.join(root, 'Directory.Build.props'), '<Project><PropertyGroup><Nullable>enable</Nullable></PropertyGroup></Project>\n');
    proj = path.join(root, 'App.csproj');
    // The template sets Nullable itself; drop it so the value comes from Directory.Build.props.
    await fs.writeFile(proj, (await fs.readFile(proj, 'utf8')).replace(/^\s*<Nullable>.*<\/Nullable>\r?\n/m, ''));
    const cli = new DotnetCli(nodeExec, dotnet!, createOutput({ appendLine: () => {} }));
    deps = { readText: (p) => nodeTextFs.readFile(p), getProperties: (p, n) => cli.getProperties(p, n), writer: nodeTextFs };
  }, T);
  afterAll(async () => {
    if (root) await fs.rm(path.dirname(root), { recursive: true, force: true });
  });

  const msbuild = async (name: string) => (await run(['msbuild', proj, `-getProperty:${name}`], root)).trim();
  const get = (m: Awaited<ReturnType<typeof loadProperties>>, p: string) => m.fields.find((f) => f.property === p)!;

  it('set LangVersion, then remove it', async () => {
    let m = await loadProperties(proj, deps);
    expect(get(m, 'Nullable')).toMatchObject({ origin: 'inherited', evaluated: 'enable' });
    m = await saveProperties(m, [{ kind: 'set', name: 'LangVersion', value: '11.0' }], deps);
    expect(get(m, 'LangVersion')).toMatchObject({ origin: 'project', raw: '11.0', evaluated: '11.0' });
    expect(await msbuild('LangVersion')).toBe('11.0');
    await run(['build', proj], root);
    m = await saveProperties(m, [{ kind: 'remove', name: 'LangVersion' }], deps);
    expect(get(m, 'LangVersion').origin).toBe('inherited');
    expect(await msbuild('LangVersion')).toBe(get(m, 'LangVersion').evaluated);
    await run(['build', proj], root);
  }, T);

  it.skipIf(!hasNet10)('TargetFramework -> TargetFrameworks net8.0;net10.0 builds', async () => {
    let m = await loadProperties(proj, deps);
    m = await saveProperties(m, [{ kind: 'targetFrameworks', tfms: ['net8.0', 'net10.0'] }], deps);
    expect(get(m, 'TargetFramework')).toMatchObject({ origin: 'project', evaluated: 'net8.0;net10.0' });
    expect(await msbuild('TargetFrameworks')).toBe('net8.0;net10.0');
    await run(['build', proj], root);
  }, T);
});
