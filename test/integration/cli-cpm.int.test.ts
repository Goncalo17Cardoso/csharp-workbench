import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DotnetCli } from '../../src/dotnet/cli';
import { nodeExec } from '../../src/dotnet/exec';
import { findDotnet } from '../../src/dotnet/locate';
import { createOutput } from '../../src/output';
import { readCpm, readPackageRefs } from '../../src/workspace/projectFiles';
import { createFixtureSolution } from './helpers/fixtures';

const home = os.homedir();
const dotnet = await findDotnet({
  pathEnv: process.env.PATH ?? '',
  home,
  exists: (p) => fs.access(p).then(() => true, () => false),
});

const T = 120_000;
const ID = 'Newtonsoft.Json';

describe.skipIf(!dotnet)('dotnet CLI with central package management', () => {
  let root: string;
  const cli = () => new DotnetCli(nodeExec, dotnet!, createOutput({ appendLine: () => {} }));
  const read = (p: string) => fs.readFile(p, 'utf8');
  const refs = async (p: string) => readPackageRefs(await read(p));
  const central = async (p: string) => readCpm(await read(p), p)!.versions.get(ID.toLowerCase());

  beforeAll(async () => {
    process.env.DOTNET_ROOT ??= path.join(home, '.dotnet');
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'cw-'));
  });
  afterAll(async () => {
    if (root) await fs.rm(root, { recursive: true, force: true });
  });

  const fixture = async (name: string, cpm: boolean) =>
    createFixtureSolution(path.join(root, name, 'My App #1'), { cpm, dotnetPath: dotnet });

  it('cpm: add to project creates PackageReference without Version and central PackageVersion', async () => {
    const f = await fixture('add', true);
    await cli().addPackage(f.projects[0], ID, '13.0.1');
    const r = (await refs(f.projects[0])).find((x) => x.id === ID);
    expect(r).toBeDefined();
    expect(r!.requested).toBeUndefined();
    expect(r!.versionOverride).toBeUndefined();
    expect(await central(f.props!)).toBe('13.0.1');
  }, T);

  it('cpm: add with different version to a project already referencing updates central version', async () => {
    const f = await fixture('upd', true);
    await cli().addPackage(f.projects[0], ID, '13.0.1');
    await cli().addPackage(f.projects[0], ID, '13.0.3');
    expect(await central(f.props!)).toBe('13.0.3');
    const r = (await refs(f.projects[0])).find((x) => x.id === ID)!;
    expect(r.versionOverride).toBeUndefined();
    expect(r.requested).toBeUndefined();
  }, T);

  it('cpm: remove package leaves PackageVersion in props', async () => {
    const f = await fixture('rm', true);
    await cli().addPackage(f.projects[0], ID, '13.0.1');
    await cli().removePackage(f.projects[0], ID);
    expect((await refs(f.projects[0])).find((x) => x.id === ID)).toBeUndefined();
    expect(await central(f.props!)).toBe('13.0.1');
  }, T);

  it('cpm: remove then add on a project with VersionOverride drops the override', async () => {
    const f = await fixture('vo', true);
    await cli().addPackage(f.projects[0], ID, '13.0.1');
    // Test setup only: the CLI cannot create a VersionOverride, so the starting state is written here.
    const csproj = await read(f.projects[0]);
    await fs.writeFile(
      f.projects[0],
      csproj.replace(`<PackageReference Include="${ID}" />`, `<PackageReference Include="${ID}" VersionOverride="13.0.1" />`),
    );
    expect((await refs(f.projects[0])).find((x) => x.id === ID)!.versionOverride).toBe('13.0.1');
    await cli().removePackage(f.projects[0], ID);
    await cli().addPackage(f.projects[0], ID, '13.0.3');
    const r = (await refs(f.projects[0])).find((x) => x.id === ID)!;
    expect(r.versionOverride).toBeUndefined();
    expect(r.requested).toBeUndefined();
  }, T);

  it('non-cpm: add on two projects then list package --format json shows both', async () => {
    const f = await fixture('plain', false);
    await cli().addPackage(f.projects[0], ID, '13.0.1');
    await cli().addPackage(f.projects[1], ID, '13.0.3');
    const listed = await cli().listPackages(f.sln);
    const byName = new Map(listed.map((p) => [p.project.name, p.packages]));
    expect(byName.get('A')?.find((p) => p.id === ID)?.requested).toBe('13.0.1');
    expect(byName.get('B')?.find((p) => p.id === ID)?.requested).toBe('13.0.3');
  }, T);
});
