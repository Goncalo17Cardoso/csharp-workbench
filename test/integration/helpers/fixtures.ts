// Framework-agnostic: no vitest or mocha imports (reused by the VS Code integration tests).
import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

function dotnet(dotnetPath: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(dotnetPath, args, { cwd, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) =>
      err ? reject(new Error(`dotnet ${args.join(' ')} failed: ${stderr || stdout || err.message}`)) : resolve(stdout),
    );
  });
}

export interface FixtureSolution { sln: string; projects: string[]; props?: string }

/** Creates `<dir>/App.sln` with two net8.0 classlibs (A, B); with cpm also a Directory.Packages.props. */
export async function createFixtureSolution(
  dir: string,
  opts: { cpm: boolean; dotnetPath?: string },
): Promise<FixtureSolution> {
  const dn = opts.dotnetPath ?? 'dotnet';
  await fs.mkdir(dir, { recursive: true });
  // SDK 10 defaults to .slnx; SDK 8 has no --format option (and always writes .sln).
  await dotnet(dn, ['new', 'sln', '--format', 'sln', '-n', 'App'], dir).catch(() =>
    dotnet(dn, ['new', 'sln', '-n', 'App'], dir),
  );
  const projects: string[] = [];
  for (const name of ['A', 'B']) {
    await dotnet(dn, ['new', 'classlib', '-n', name, '-f', 'net8.0'], dir);
    projects.push(path.join(dir, name, `${name}.csproj`));
  }
  const sln = path.join(dir, 'App.sln');
  await dotnet(dn, ['sln', sln, 'add', ...projects], dir);
  let props: string | undefined;
  if (opts.cpm) {
    // Test setup: minimal props written directly so SDK 8 (no packagesprops template) and 10 start identically.
    props = path.join(dir, 'Directory.Packages.props');
    await fs.writeFile(
      props,
      '<Project><PropertyGroup><ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally></PropertyGroup><ItemGroup/></Project>\n',
    );
  }
  return { sln, projects, props };
}

export interface SolutionExplorerFixture {
  sln: string;
  /** ASP.NET Core project MyApp.Api in `src/web/My App #1/`. */
  api: string;
  /** Classlib MyApp.Core with a `Models` folder. */
  core: string;
  /** xunit project MyApp.Tests. */
  tests: string;
  /** Template short names actually used (webapi/xunit may be unavailable offline). */
  templates: { api: string; tests: string };
}

/**
 * Creates the Solution Explorer fixture in `dir`: folders `src` (with `src/web`) and `tests`,
 * MyApp.Api (path with a space and `#`), MyApp.Core with Models/, MyApp.Tests, appsettings.Development.json.
 * Uses real `dotnet new` / `dotnet sln add --solution-folder`; restores before returning.
 */
export async function createSolutionExplorerFixture(
  dir: string,
  opts: { dotnetPath?: string } = {},
): Promise<SolutionExplorerFixture> {
  const dn = opts.dotnetPath ?? 'dotnet';
  await fs.mkdir(dir, { recursive: true });
  await dotnet(dn, ['new', 'sln', '--format', 'sln', '-n', 'MySln'], dir).catch(() => dotnet(dn, ['new', 'sln', '-n', 'MySln'], dir));
  const sln = path.join(dir, 'MySln.sln');

  const apiDir = path.join(dir, 'src', 'web', 'My App #1');
  const apiTemplate = await dotnet(dn, ['new', 'webapi', '-n', 'MyApp.Api', '-o', apiDir, '-f', 'net8.0'], dir).then(() => 'webapi'); // no fallback: SDK 8 ships webapi, and a substitute could make the nesting test vacuous
  const api = path.join(apiDir, 'MyApp.Api.csproj');

  await dotnet(dn, ['new', 'classlib', '-n', 'MyApp.Core', '-o', path.join(dir, 'MyApp.Core'), '-f', 'net8.0'], dir);
  const core = path.join(dir, 'MyApp.Core', 'MyApp.Core.csproj');
  await fs.mkdir(path.join(dir, 'MyApp.Core', 'Models'), { recursive: true });
  await fs.writeFile(path.join(dir, 'MyApp.Core', 'Models', 'Address.cs'), 'namespace MyApp.Core.Models;\n\npublic class Address { }\n');

  const testsTemplate = await dotnet(dn, ['new', 'xunit', '-n', 'MyApp.Tests', '-o', path.join(dir, 'tests', 'MyApp.Tests'), '-f', 'net8.0'], dir).then(() => 'xunit');
  const tests = path.join(dir, 'tests', 'MyApp.Tests', 'MyApp.Tests.csproj');

  await dotnet(dn, ['sln', sln, 'add', '--solution-folder', 'src/web', api], dir);
  await dotnet(dn, ['sln', sln, 'add', core], dir);
  await dotnet(dn, ['sln', sln, 'add', '--solution-folder', 'tests', tests], dir);
  await dotnet(dn, ['restore', sln], dir);
  return { sln, api, core, tests, templates: { api: apiTemplate, tests: testsTemplate } };
}

export interface PropertiesFixture {
  dir: string;
  /** `<dir>/My App #1/MyApi.csproj`: BOM, CRLF, a comment, an unconditional and a conditional PropertyGroup. */
  csproj: string;
  /** Exact bytes of the csproj as created. */
  csprojBytes: Buffer;
  propsFile: string;
  launchSettings: string;
}

/**
 * ASP.NET Core (`webapi`) project MyApi in `<dir>/My App #1/` whose Nullable comes from a
 * Directory.Build.props, with Models/Customer.cs, a file using it, and a two-namespace file.
 * No fallback template: the fixture fails when `webapi` is missing.
 */
export async function createPropertiesFixture(dir: string, opts: { dotnetPath?: string } = {}): Promise<PropertiesFixture> {
  const dn = opts.dotnetPath ?? 'dotnet';
  const projDir = path.join(dir, 'My App #1');
  await fs.mkdir(dir, { recursive: true });
  await dotnet(dn, ['new', 'webapi', '-n', 'MyApi', '-o', projDir, '-f', 'net8.0'], dir);
  const propsFile = path.join(dir, 'Directory.Build.props');
  await fs.writeFile(propsFile, '<Project>\n  <PropertyGroup>\n    <Nullable>enable</Nullable>\n  </PropertyGroup>\n</Project>\n');
  const csproj = path.join(projDir, 'MyApi.csproj');
  const template = await fs.readFile(csproj, 'utf8');
  const itemGroup = template.match(/\s*<ItemGroup>[\s\S]*?<\/ItemGroup>/)?.[0].replace(/\r?\n/g, '\r\n') ?? '';
  const text = [
    '<Project Sdk="Microsoft.NET.Sdk.Web">',
    '  <!-- keep me -->',
    '  <PropertyGroup>',
    '    <TargetFramework>net8.0</TargetFramework>',
    '    <ImplicitUsings>enable</ImplicitUsings>',
    '  </PropertyGroup>',
    '  <PropertyGroup Condition="\'$(Configuration)\'==\'Debug\'">',
    '    <DefineConstants>$(DefineConstants);CWDEBUG</DefineConstants>',
    '  </PropertyGroup>',
    '</Project>',
    '',
  ].join('\r\n').replace('\r\n</Project>', `${itemGroup}\r\n</Project>`);
  const csprojBytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')]);
  await fs.writeFile(csproj, csprojBytes);
  await fs.mkdir(path.join(projDir, 'Models'), { recursive: true });
  await fs.mkdir(path.join(projDir, 'Services'), { recursive: true });
  await fs.writeFile(path.join(projDir, 'Models', 'Customer.cs'), 'namespace MyApi.Models;\n\npublic class Customer { }\n');
  await fs.writeFile(path.join(projDir, 'Services', 'CustomerService.cs'),
    'using MyApi.Models;\n\nnamespace MyApi.Services;\n\npublic class CustomerService\n{\n    public Customer? Find() => null;\n}\n');
  await fs.writeFile(path.join(projDir, 'Services', 'Multi.cs'), 'namespace One { public class A { } }\nnamespace Two { public class B { } }\n');
  const launchSettings = path.join(projDir, 'Properties', 'launchSettings.json');
  await fs.mkdir(path.dirname(launchSettings), { recursive: true });
  await fs.writeFile(launchSettings,
    '{\n  // keep this comment\n  "profiles": {\n    "http": {\n      "commandName": "Project",\n      "applicationUrl": "http://localhost:5099"\n    }\n  }\n}\n');
  await dotnet(dn, ['restore', csproj], dir);
  return { dir, csproj, csprojBytes, propsFile, launchSettings };
}
