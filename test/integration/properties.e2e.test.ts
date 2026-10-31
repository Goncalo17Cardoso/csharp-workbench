import * as assert from 'node:assert';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ExtensionApi } from '../../src/extension';
import { findDotnet } from '../../src/dotnet/locate';
import type { PropertyEdit } from '../../src/properties/csprojEdit';
import type { PropertiesModel } from '../../src/properties/model';
import type { PropsToWebview } from '../../src/properties/protocol';
import { debugConfigFor, dotnetTask } from '../../src/solution/runCore';
import { createPropertiesFixture, type PropertiesFixture } from './helpers/fixtures';

const exists = (p: string) => fs.access(p).then(() => true, () => false);
const ourExtension = () => vscode.extensions.all.find((e) => e.packageJSON?.name === 'csharp-workbench-studio') as
  vscode.Extension<ExtensionApi> | undefined;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('Project Properties, Launch Profiles and Sync end to end', function () {
  let dotnet: string;
  let api: ExtensionApi;
  let wsRoot: string;
  let fx: PropertiesFixture;
  let dir: string;
  let counter = 0;
  let posts: PropsToWebview[] = [];

  const exec = (args: string[], cwd: string) =>
    new Promise<{ code: number; out: string }>((resolve) =>
      execFile(dotnet, args, { cwd, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, PATH: `${path.dirname(dotnet)}${path.delimiter}${process.env.PATH ?? ''}` } }, (err, o, e) =>
        resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, out: `${o}${e}` })));
  const getProperty = async (name: string) => (await exec(['msbuild', fx.csproj, `-getProperty:${name}`], path.dirname(fx.csproj))).out.trim();
  const bytes = () => fs.readFile(fx.csproj);
  const lastModel = (): PropertiesModel => {
    const m = [...posts].reverse().find((p) => p.type === 'model');
    assert.ok(m && m.type === 'model', 'a model was posted');
    return m.model;
  };
  const field = (name: string) => lastModel().fields.find((f) => f.property === name)!;
  const waitFor = async (pred: () => boolean, what: string) => {
    for (let i = 0; i < 400 && !pred(); i++) await sleep(50);
    assert.ok(pred(), `timed out waiting for ${what}`);
  };
  const profiles = () => {
    const v = [...posts].reverse().find((p) => p.type === 'profilesModel');
    assert.ok(v && v.type === 'profilesModel', 'a profiles model was posted');
    return v.model;
  };
  async function openAndLoad() {
    await api.properties!.open(fx.csproj);
    const c = api.properties!.controllerFor(fx.csproj);
    assert.ok(c, 'controller exists');
    await waitFor(() => posts.some((p) => p.type === 'model'), 'model');
    await sleep(500); // let the webview-less panel's own ready/load settle
    return c;
  }
  async function save(c: NonNullable<ReturnType<NonNullable<ExtensionApi['properties']>['controllerFor']>>, edits: PropertyEdit[]): Promise<boolean> {
    const n = posts.length;
    await c.handle({ type: 'save', edits });
    return posts.slice(n).some((p) => p.type === 'saved');
  }
  const withSdk10 = async <T>(fn: () => Promise<T>): Promise<T> => {
    // SDK 8 cannot target net10.0, so a multi-target build pins the SDK that can.
    const g = path.join(fx.dir, 'global.json');
    await fs.writeFile(g, '{"sdk":{"version":"10.0.100","rollForward":"latestFeature"}}');
    try { return await fn(); } finally { await fs.rm(g, { force: true }); }
  };

  before(async function () {
    const found = process.env.CSW_TEST_DOTNET || await findDotnet({ pathEnv: process.env.PATH ?? '', home: os.homedir(), exists });
    if (!found) return this.skip();
    dotnet = found;
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    assert.ok(folder, 'the test host opens a workspace folder');
    wsRoot = folder;
    await vscode.workspace.getConfiguration('csharpWorkbench').update('dotnetPath', dotnet, vscode.ConfigurationTarget.Global);
    await fs.writeFile(path.join(wsRoot, 'global.json'), '{"sdk":{"version":"8.0.100","rollForward":"latestFeature"}}');
    const ext = ourExtension();
    assert.ok(ext, 'extension is installed in the test host');
    api = await ext.activate();
    assert.ok(api.properties && api.sync, 'Test-mode properties and sync APIs exist');
    api.confirmOverride = async () => true;
    api.syncSkipConfirmation = true;
    api.properties.onPost = (m) => posts.push(m);
  });

  beforeEach(async () => {
    posts = [];
    if (dir) await fs.rm(dir, { recursive: true, force: true });
    dir = path.join(wsRoot, `prop${++counter} #1`);
    fx = await createPropertiesFixture(dir, { dotnetPath: dotnet });
  });

  afterEach(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  after(async () => {
    if (dir) await fs.rm(dir, { recursive: true, force: true });
    await fs.rm(path.join(wsRoot, 'global.json'), { force: true });
  });

  it('1. opens within 2 s with the loading state, shows evaluated values, Nullable inherited', async () => {
    const start = Date.now();
    await api.properties!.open(fx.csproj);
    await waitFor(() => posts.some((p) => p.type === 'model'), 'model');
    const ms = Date.now() - start;
    console.log(`criterion 1: open to model in ${ms} ms`);
    assert.ok(ms < 2000, `took ${ms} ms`);
    const types = posts.map((p) => p.type);
    const loading = types.indexOf('loading');
    assert.ok(loading >= 0 && loading < types.indexOf('model'), `loading before model: ${types.join(',')}`);
    assert.strictEqual(field('TargetFramework').evaluated, 'net8.0');
    assert.strictEqual(field('Nullable').evaluated, 'enable');
    assert.strictEqual(field('Nullable').origin, 'inherited');
  });

  it('2. net8.0 to net8.0;net10.0 swaps the element, changes only that line, and builds', async () => {
    const before = fx.csprojBytes.toString('utf8');
    const c = await openAndLoad();
    assert.strictEqual(await save(c, [{ kind: 'targetFrameworks', tfms: ['net8.0', 'net10.0'] }]), true);
    const after = (await bytes()).toString('utf8');
    assert.strictEqual(after, before.replace('<TargetFramework>net8.0</TargetFramework>', '<TargetFrameworks>net8.0;net10.0</TargetFrameworks>'));
    assert.strictEqual(await getProperty('TargetFrameworks'), 'net8.0;net10.0');
    await withSdk10(async () => {
      const b = await exec(['build', fx.csproj], fx.dir);
      assert.strictEqual(b.code, 0, b.out);
    });
  });

  it('3. editing inherited Nullable creates an override; Reset removes it and the value is inherited again', async () => {
    const c = await openAndLoad();
    assert.strictEqual(await save(c, [{ kind: 'set', name: 'Nullable', value: 'disable' }]), true);
    assert.match((await bytes()).toString('utf8'), /<Nullable>disable<\/Nullable>/);
    assert.strictEqual(await getProperty('Nullable'), 'disable');
    assert.strictEqual(field('Nullable').origin, 'project');
    assert.strictEqual(await save(c, [{ kind: 'remove', name: 'Nullable' }]), true);
    assert.ok((await bytes()).equals(fx.csprojBytes), 'bytes back to the original');
    assert.strictEqual(await getProperty('Nullable'), 'enable');
    assert.strictEqual(field('Nullable').origin, 'inherited');
  });

  it('4. a property under a Condition is read-only (conditional) and refused on save', async () => {
    const c = await openAndLoad();
    assert.strictEqual(field('DefineConstants').origin, 'conditional');
    assert.strictEqual(await save(c, [{ kind: 'set', name: 'DefineConstants', value: 'X' }]), false);
    assert.ok((await bytes()).equals(fx.csprojBytes), 'file untouched');
  });

  it('5. BOM, CRLF and comments survive byte for byte except the edited line', async () => {
    const c = await openAndLoad();
    assert.strictEqual(await save(c, [{ kind: 'set', name: 'ImplicitUsings', value: 'disable' }]), true);
    const after = await bytes();
    const expected = Buffer.from(fx.csprojBytes.toString('utf8').replace('<ImplicitUsings>enable<', '<ImplicitUsings>disable<'), 'utf8');
    assert.ok(after.equals(expected), 'only the edited value changed');
    assert.deepStrictEqual([...after.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
    assert.strictEqual(await exists(`${fx.csproj}.cw-bak`), false, 'no leftover backup');
  });

  it('6. Staging profile: Run passes --launch-profile Staging, Debug config has the env and opens the browser', async () => {
    const c = await openAndLoad();
    await c.handle({ type: 'profiles', action: { kind: 'new', name: 'Staging', commandName: 'Project' } });
    await c.handle({ type: 'profiles', action: { kind: 'env', name: 'Staging', env: { ASPNETCORE_ENVIRONMENT: 'Staging' } } });
    await c.handle({ type: 'profiles', action: { kind: 'set', name: 'Staging', field: 'launchBrowser', value: true } });
    await c.handle({ type: 'profiles', action: { kind: 'set', name: 'Staging', field: 'applicationUrl', value: 'http://localhost:5123' } });
    await c.handle({ type: 'setActiveProfile', name: 'Staging' });
    const view = { model: profiles() };
    assert.strictEqual(view.model.active, 'Staging');
    const profile = view.model.profiles.find((p) => p.name === 'Staging');
    assert.ok(profile, 'Staging written to launchSettings.json');
    assert.match(await fs.readFile(fx.launchSettings, 'utf8'), /"Staging"/);
    const task = dotnetTask('run', fx.csproj, dotnet, undefined, view.model.active);
    assert.deepStrictEqual(task.args, ['run', '--project', fx.csproj, '--launch-profile', 'Staging']);
    const dbg = debugConfigFor(fx.csproj, '/x/MyApi.dll', 'MyApi', profile, {});
    assert.strictEqual((dbg.env as Record<string, string>).ASPNETCORE_ENVIRONMENT, 'Staging');
    assert.ok(dbg.serverReadyAction, 'opens the browser on the app URL');
    assert.strictEqual((dbg.env as Record<string, string>).ASPNETCORE_URLS, 'http://localhost:5123');
  });

  it('7. launchSettings.json comments survive editing a profile', async () => {
    const c = await openAndLoad();
    await c.handle({ type: 'profiles', action: { kind: 'env', name: 'http', env: { FOO: 'bar' } } });
    const text = await fs.readFile(fx.launchSettings, 'utf8');
    assert.match(text, /\/\/ keep this comment/);
    assert.strictEqual(profiles().profiles.find((p) => p.name === 'http')?.environmentVariables.FOO, 'bar');
  });

  it('8. moving Customer.cs to Domain/ and syncing previews declaration and using, then the project builds', async function () {
    const projDir = path.dirname(fx.csproj);
    await fs.mkdir(path.join(projDir, 'Domain'), { recursive: true });
    await fs.rename(path.join(projDir, 'Models', 'Customer.cs'), path.join(projDir, 'Domain', 'Customer.cs'));
    const planned = await api.sync!.plan(fx.csproj);
    assert.ok(planned, 'a plan was computed');
    const customer = path.join(projDir, 'Domain', 'Customer.cs');
    const service = path.join(projDir, 'Services', 'CustomerService.cs');
    assert.ok(planned.plan.edits.get(customer)?.some((e) => e.kind === 'declaration' && e.newText.includes('MyApi.Domain')), 'declaration edit');
    assert.ok(planned.plan.edits.get(service)?.some((e) => e.kind === 'using' && e.newText.includes('MyApi.Domain')), 'using edit');
    await vscode.commands.executeCommand('csharpWorkbench.syncNamespaces', { kind: 'project', path: fx.csproj });
    for (let i = 0; i < 100; i++) {
      if (/MyApi\.Domain/.test(await fs.readFile(customer, 'utf8'))) break;
      await sleep(100);
    }
    await vscode.workspace.saveAll(false);
    assert.match(await fs.readFile(customer, 'utf8'), /namespace MyApi\.Domain/);
    assert.match(await fs.readFile(service, 'utf8'), /using MyApi\.Domain;/);
    const b = await exec(['build', fx.csproj], fx.dir);
    assert.strictEqual(b.code, 0, b.out);
  });

  it('9. a file with two top-level namespaces is skipped and listed', async () => {
    const planned = await api.sync!.plan(fx.csproj);
    assert.ok(planned);
    const multi = path.join(path.dirname(fx.csproj), 'Services', 'Multi.cs');
    const hit = planned.plan.skipped.find((s) => s.path === multi);
    assert.ok(hit, `skipped list: ${JSON.stringify(planned.plan.skipped)}`);
    assert.strictEqual(hit.reason, 'multipleNamespaces');
    assert.ok(!planned.plan.edits.has(multi), 'no edits for the skipped file');
  });

  it('10. a write that fails validation leaves the original bytes and reports the error', async () => {
    const c = await openAndLoad();
    posts.length = 0;
    // MSBuild evaluates $(CwNoSuchProperty) to '', so the evaluated value differs from the requested one.
    const ok = await save(c, [{ kind: 'set', name: 'Company', value: '$(CwNoSuchProperty)Acme' }]);
    assert.strictEqual(ok, false);
    assert.ok((await bytes()).equals(fx.csprojBytes), 'original bytes intact');
    assert.strictEqual(await exists(`${fx.csproj}.cw-bak`), false, 'backup cleaned up');
    const err = posts.find((p) => p.type === 'error');
    assert.ok(err && err.type === 'error' && err.message.length > 0, 'an error was posted');
  });
});
