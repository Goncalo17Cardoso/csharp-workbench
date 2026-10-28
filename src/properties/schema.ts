// Field list of the Project Properties page (spec §2.1). Pure: validators return an l10n
// key (the English message) or undefined; the adapter translates it.
import { toIdentifier } from '../solution/identifier';

export type FieldKind = 'text' | 'bool' | 'choice' | 'tfms' | 'list'; // list = ';'-separated
export type SectionId = 'application' | 'build' | 'package' | 'assembly' | 'debug' | 'secrets';

export interface FieldDef {
  property: string;
  section: SectionId;
  kind: FieldKind;
  label: string;
  choices?: string[];
  validate?: (v: string) => string | undefined;
}

const TFM_RE = /^(net\d+\.\d+(-[a-z]+(\d+(\.\d+)*)?)?|netstandard\d\.\d|netcoreapp\d\.\d|net\d{2,3})$/;
const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-((0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(\.(0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(\+[0-9a-zA-Z-]+(\.[0-9a-zA-Z-]+)*)?$/;
const QUAD_RE = /^\d+\.\d+(\.\d+){0,2}$/;

export function validateTfm(v: string): string | undefined {
  return TFM_RE.test(v) ? undefined : 'Not a valid target framework (for example net8.0).';
}

export function validateVersion(v: string): string | undefined {
  return SEMVER_RE.test(v) || QUAD_RE.test(v) ? undefined : 'Use a version like 1.2.3, 1.2.3-beta.1 or 1.2.3.4.';
}

export function validateIdentifierPath(v: string): string | undefined {
  const ok = v.length > 0 && v.split('.').every((s) => s === toIdentifier(s) && !s.includes('@'));
  return ok ? undefined : 'Not a valid identifier (letters, digits and underscores; dot-separated).';
}

const t = (property: string, section: SectionId, kind: FieldKind, label: string, extra: Partial<FieldDef> = {}): FieldDef =>
  ({ property, section, kind, label, ...extra });

export const FIELDS: FieldDef[] = [
  t('OutputType', 'application', 'choice', 'Output type', { choices: ['Exe', 'Library', 'WinExe'] }),
  t('TargetFramework', 'application', 'tfms', 'Target framework(s)'),
  t('AssemblyName', 'application', 'text', 'Assembly name', { validate: validateIdentifierPath }),
  t('RootNamespace', 'application', 'text', 'Default namespace', { validate: validateIdentifierPath }),
  t('StartupObject', 'application', 'text', 'Startup object'),

  t('Nullable', 'build', 'choice', 'Nullable', { choices: ['enable', 'disable', 'warnings', 'annotations'] }),
  t('ImplicitUsings', 'build', 'choice', 'Implicit usings', { choices: ['enable', 'disable'] }),
  t('LangVersion', 'build', 'text', 'Language version'),
  t('TreatWarningsAsErrors', 'build', 'bool', 'Treat warnings as errors'),
  t('WarningsAsErrors', 'build', 'list', 'Warnings as errors'),
  t('NoWarn', 'build', 'list', 'Suppress warnings'),
  t('DefineConstants', 'build', 'list', 'Conditional symbols'),
  t('AllowUnsafeBlocks', 'build', 'bool', 'Allow unsafe code'),
  t('GenerateDocumentationFile', 'build', 'bool', 'Documentation file'),

  t('GeneratePackageOnBuild', 'package', 'bool', 'Generate package on build'),
  t('IsPackable', 'package', 'bool', 'Packable'),
  t('PackageId', 'package', 'text', 'Package ID'),
  t('Version', 'package', 'text', 'Version', { validate: validateVersion }),
  t('Authors', 'package', 'text', 'Authors'),
  t('Company', 'package', 'text', 'Company'),
  t('Product', 'package', 'text', 'Product'),
  t('Description', 'package', 'text', 'Description'),
  t('Copyright', 'package', 'text', 'Copyright'),
  t('PackageLicenseExpression', 'package', 'text', 'License expression'),
  t('PackageProjectUrl', 'package', 'text', 'Project URL'),
  t('RepositoryUrl', 'package', 'text', 'Repository URL'),
  t('PackageTags', 'package', 'list', 'Tags'),
  t('PackageReleaseNotes', 'package', 'text', 'Release notes'),

  t('AssemblyVersion', 'assembly', 'text', 'Assembly version', { validate: validateVersion }),
  t('FileVersion', 'assembly', 'text', 'File version', { validate: validateVersion }),
  t('InformationalVersion', 'assembly', 'text', 'Informational version'),
];

export const ALL_PROPERTIES: string[] = [...FIELDS.map((f) => f.property), 'TargetFrameworks'];
