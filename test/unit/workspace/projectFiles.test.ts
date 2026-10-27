import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readPackageRefs, findCentralPackagesFile, readCpm } from '../../../src/workspace/projectFiles';

const fx = (n: string) => readFileSync(join(__dirname, '../../fixtures/projects', n), 'utf8');

describe('readPackageRefs', () => {
  it('reads Version as attribute and as child element', () => {
    const refs = readPackageRefs(`<Project><ItemGroup>
      <PackageReference Include="A" Version="1.0.0" />
      <PackageReference Include="B"><Version>2.0.0</Version></PackageReference>
    </ItemGroup></Project>`);
    expect(refs).toEqual([{ id: 'A', requested: '1.0.0' }, { id: 'B', requested: '2.0.0' }]);
  });
  it('reads VersionOverride', () => {
    const refs = readPackageRefs(fx('cpm.csproj'));
    expect(refs[1]).toEqual({ id: 'Newtonsoft.Json', requested: undefined, versionOverride: '12.0.1' });
  });
  it('PackageReference without version under CPM has requested undefined', () => {
    expect(readPackageRefs(fx('cpm.csproj'))[0].requested).toBeUndefined();
  });
  it('includes conditional groups, ignores Update items', () => {
    const refs = readPackageRefs(`<Project>
      <ItemGroup Condition="'$(TargetFramework)'=='net8.0'"><PackageReference Include="C" Version="1" /></ItemGroup>
      <ItemGroup><PackageReference Update="D" Version="2" /></ItemGroup>
    </Project>`);
    expect(refs.map((r) => r.id)).toEqual(['C']);
  });
  it('handles no references', () => {
    expect(readPackageRefs('<Project />')).toEqual([]);
  });
});

describe('findCentralPackagesFile', () => {
  it('finds Directory.Packages.props walking up', async () => {
    const exists = async (p: string) => p === '/r/Directory.Packages.props';
    expect(await findCentralPackagesFile('/r/src/app', exists, '/r/')).toBe('/r/Directory.Packages.props');
  });
  it('does not go above stopAt', async () => {
    const exists = async (p: string) => p === '/Directory.Packages.props';
    expect(await findCentralPackagesFile('/r/app', exists, '/r')).toBeUndefined();
  });
});

describe('readCpm', () => {
  it('reads versions', () => {
    const c = readCpm(fx('Directory.Packages.props'), '/p');
    expect(c?.propsPath).toBe('/p');
    expect(c?.versions.get('serilog')).toBe('3.1.1');
  });
  it('ignores props without ManagePackageVersionsCentrally=true', () => {
    expect(readCpm('<Project><ItemGroup><PackageVersion Include="A" Version="1"/></ItemGroup></Project>', '/p')).toBeUndefined();
    expect(readCpm('<Project><PropertyGroup><ManagePackageVersionsCentrally>false</ManagePackageVersionsCentrally></PropertyGroup></Project>', '/p')).toBeUndefined();
  });
  it('accepts True with whitespace', () => {
    expect(readCpm('<Project><PropertyGroup><ManagePackageVersionsCentrally> True </ManagePackageVersionsCentrally></PropertyGroup></Project>', '/p')).toBeDefined();
  });
});
