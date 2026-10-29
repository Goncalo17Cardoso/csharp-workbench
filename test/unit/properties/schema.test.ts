import { describe, it, expect } from 'vitest';
import { ALL_PROPERTIES, FIELDS, validateIdentifierPath, validateTfm, validateVersion } from '../../../src/properties/schema';

describe('schema', () => {
  it('FIELDS covers spec sections in order', () => {
    const bySection: Record<string, string[]> = {};
    for (const f of FIELDS) (bySection[f.section] ??= []).push(f.property);
    expect(bySection).toEqual({
      application: ['OutputType', 'TargetFramework', 'AssemblyName', 'RootNamespace', 'StartupObject'],
      build: ['Nullable', 'ImplicitUsings', 'LangVersion', 'TreatWarningsAsErrors', 'WarningsAsErrors', 'NoWarn', 'DefineConstants', 'AllowUnsafeBlocks', 'GenerateDocumentationFile'],
      package: ['GeneratePackageOnBuild', 'IsPackable', 'PackageId', 'Version', 'Authors', 'Company', 'Product', 'Description', 'Copyright', 'PackageLicenseExpression', 'PackageProjectUrl', 'RepositoryUrl', 'PackageTags', 'PackageReleaseNotes'],
      assembly: ['AssemblyVersion', 'FileVersion', 'InformationalVersion'],
    });
    expect(ALL_PROPERTIES.at(-1)).toBe('TargetFrameworks');
  });
  it('validateTfm accepts net8.0 net10.0 netstandard2.0 net8.0-ios17.0 rejects net8 and 8.0', () => {
    for (const v of ['net8.0', 'net10.0', 'netstandard2.0', 'net8.0-ios17.0']) expect(validateTfm(v)).toBeUndefined();
    for (const v of ['net8', '8.0', '']) expect(validateTfm(v)).toBeTypeOf('string');
  });
  it('validateVersion accepts 1.2.3 1.2.3-beta.1 1.2.3.4 rejects 1.x', () => {
    for (const v of ['1.2.3', '1.2.3-beta.1', '1.2.3.4', '1.2']) expect(validateVersion(v)).toBeUndefined();
    for (const v of ['1.x', '', 'a.b.c']) expect(validateVersion(v)).toBeTypeOf('string');
  });
  it('validateIdentifierPath rejects keywords, digits first and @', () => {
    expect(validateIdentifierPath('My.App_1')).toBeUndefined();
    for (const v of ['1App', 'My..App', 'a.class', 'My-App', '@x', '']) expect(validateIdentifierPath(v)).toBeTypeOf('string');
  });
});
