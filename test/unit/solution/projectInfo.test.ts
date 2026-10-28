import { describe, expect, it } from 'vitest';
import { readProjectInfo } from '../../../src/solution/projectInfo';

const proj = (body: string) => `<Project Sdk="Microsoft.NET.Sdk">${body}</Project>`;

describe('readProjectInfo', () => {
  it('reads root namespace default and explicit', () => {
    expect(readProjectInfo('/w/My.App.csproj', proj('')).rootNamespace).toBe('My.App');
    const x = proj('<PropertyGroup><RootNamespace>A.B</RootNamespace></PropertyGroup><PropertyGroup Condition="X"><RootNamespace>C</RootNamespace></PropertyGroup>');
    expect(readProjectInfo('/w/My.App.csproj', x).rootNamespace).toBe('A.B');
  });
  it('splits TargetFrameworks', () => {
    const i = readProjectInfo('/w/a.csproj', proj('<PropertyGroup><TargetFrameworks>net8.0;net48</TargetFrameworks></PropertyGroup>'));
    expect(i.targetFrameworks).toEqual(['net8.0', 'net48']);
  });
  it('resolves project references with spaces', () => {
    const i = readProjectInfo('/w/My App #1/a.csproj', proj('<ItemGroup><ProjectReference Include="..\\Other Lib\\o.csproj" /></ItemGroup>'));
    expect(i.projectRefs).toEqual(['/w/Other Lib/o.csproj']);
  });
  it('keeps UserSecretsId and 1.10-like strings', () => {
    const i = readProjectInfo('/w/a.csproj', proj('<PropertyGroup><UserSecretsId>abc-1</UserSecretsId></PropertyGroup>'));
    expect(i.userSecretsId).toBe('abc-1');
    const j = readProjectInfo('/w/a.csproj', proj('<PropertyGroup><RootNamespace>1.10</RootNamespace></PropertyGroup>'));
    expect(j.rootNamespace).toBe('1.10');
  });
  it('file-scoped when net8.0 and no LangVersion', () => {
    const p = (b: string) => readProjectInfo('/w/a.csproj', proj(`<PropertyGroup>${b}</PropertyGroup>`)).fileScopedNamespaces;
    expect(p('<TargetFramework>net8.0</TargetFramework>')).toBe(true);
    expect(p('<TargetFramework>netstandard2.0</TargetFramework>')).toBe(false);
    expect(p('<TargetFrameworks>net8.0;net48</TargetFrameworks>')).toBe(false);
    expect(p('<LangVersion>preview</LangVersion>')).toBe(true);
    expect(p('<LangVersion>10.0</LangVersion>')).toBe(true);
  });
  it('not file-scoped for LangVersion 9', () => {
    const i = readProjectInfo('/w/a.csproj', proj('<PropertyGroup><TargetFramework>net8.0</TargetFramework><LangVersion>9.0</LangVersion></PropertyGroup>'));
    expect(i.fileScopedNamespaces).toBe(false);
  });
});
