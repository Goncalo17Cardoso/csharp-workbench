import * as assert from 'node:assert';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ExtensionApi } from '../../src/extension';
import type { ToWebview } from '../../src/panel/protocol';
import { findDotnet } from '../../src/dotnet/locate';
import { readPackageRefs } from '../../src/workspace/projectFiles';
import { createFixtureSolution, type FixtureSolution } from './helpers/fixtures';

const exists = (p: string) => fs.access(p).then(() => true, () => false);
/** Looked up by package name so the test does not depend on the publisher id. */
const ourExtension = () => vscode.extensions.all.find((e) => e.packageJSON?.name === 'csharp-workbench-studio') as
  vscode.Extension<ExtensionApi> | undefined;
type Posted = { m: ToWebview; t: number };

describe('C# Workbench end to end', function () {
  let dotnet: string | undefined;
  let api: ExtensionApi;
  let root: string;
  let posts: Posted[] = [];

  const run = (args: string[], cwd: string) =>
    new Promise<void>((resolve, reject) =>
      execFile(dotnet!, args, { cwd }, (err, _o, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve())));

  async function fixture(name: string, cpm: boolean): Promise<FixtureSolution> {
    const dir = path.join(root, name, 'My App #1');
    const fx = await createFixtureSolution(dir, { cpm, dotnetPath: dotnet });
    await run(['restore', fx.sln], dir);
    return fx;
  }

  const waitFor = async <T extends ToWebview['type']>(
    type: T, pred: (m: Extract<ToWebview, { type: T }>) => boolean = () => true, from = 0,
  ) => {
    const deadline = Date.now() + 120_000;
    for (;;) {
      const hit = posts.slice(from).find((p) => p.m.type === type && pred(p.m as Extract<ToWebview, { type: T }>));
      if (hit) return hit;
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${type}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  };

  const open = async (fx: FixtureSolution) => {
    posts = [];
    const start = Date.now();
    await vscode.commands.executeCommand('csharpWorkbench.manageNuget', vscode.Uri.file(fx.sln));
    const first = await waitFor('installed');
    await waitFor('installed', (m) => m.confirmed);
    await waitFor('updates');
    return { ms: first.t - start };
  };

  const refs = async (csproj: string) =>
    readPackageRefs(await fs.readFile(csproj, 'utf8')).map((r) => `${r.id}@${r.requested ?? ''}`).sort();

  before(async function () {
    // The host's PATH is rebuilt by VS Code, so the launcher passes the dotnet it found (CSW_TEST_DOTNET).
    dotnet = process.env.CSW_TEST_DOTNET || await findDotnet({ pathEnv: process.env.PATH ?? '', home: os.homedir(), exists });
    if (!dotnet) return this.skip();
    await vscode.workspace.getConfiguration('csharpWorkbench').update('dotnetPath', dotnet, vscode.ConfigurationTarget.Global);
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'csw-e2e-'));
    // Fixtures target net8.0; pin SDK 8 when a newer SDK is also installed (also exercises sdkVersion(cwd)).
    await fs.writeFile(path.join(root, 'global.json'), '{"sdk":{"version":"8.0.100","rollForward":"latestFeature"}}');
    const ext = ourExtension();
    assert.ok(ext, 'extension is installed in the test host');
    api = await ext.activate();
    api.onPost = (m, t) => posts.push({ m, t });
    api.confirmOverride = async () => true;
  });

  afterEach(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  after(async () => {
    if (root) await fs.rm(root, { recursive: true, force: true });
  });

  it('opens panel in under 2s with installed rows', async () => {
    const fx = await fixture('open', false);
    await run(['add', fx.projects[0], 'package', 'Newtonsoft.Json', '--version', '13.0.1'], path.dirname(fx.projects[0]));
    const { ms } = await open(fx);
    const installed = posts.find((p) => p.m.type === 'installed')!.m as Extract<ToWebview, { type: 'installed' }>;
    assert.ok(installed.rows.some((r) => r.id === 'Newtonsoft.Json'), 'installed rows include the package');
    console.log(`first installed post after ${ms} ms`);
    assert.ok(ms < 2000, `first installed post took ${ms} ms`);
  });

  it('install Serilog in 2 projects matches manual dotnet add', async () => {
    const mine = await fixture('install-gui', false);
    const manual = await fixture('install-manual', false);
    for (const p of manual.projects) await run(['add', p, 'package', 'Serilog', '--version', '4.2.0'], path.dirname(p));
    await open(mine);
    await api.send(mine.sln, { type: 'run', request: { kind: 'install', packageId: 'Serilog', version: '4.2.0', projects: mine.projects } });
    for (let i = 0; i < 2; i++) assert.deepStrictEqual(await refs(mine.projects[i]), await refs(manual.projects[i]));
    assert.deepStrictEqual(await refs(mine.projects[0]), ['Serilog@4.2.0']);
  });

  it('update all updates outdated packages', async () => {
    const fx = await fixture('update', false);
    await run(['add', fx.projects[0], 'package', 'Newtonsoft.Json', '--version', '13.0.1'], path.dirname(fx.projects[0]));
    await open(fx);
    const updates = (await waitFor('updates', (m) => m.rows.length > 0)).m as Extract<ToWebview, { type: 'updates' }>;
    for (const row of updates.rows) {
      await api.send(fx.sln, { type: 'run', request: { kind: 'update', packageId: row.id, version: row.latest, projects: row.projects } });
    }
    const after = await refs(fx.projects[0]);
    assert.ok(updates.rows.length > 0 && !after.includes('Newtonsoft.Json@13.0.1'), `still outdated: ${after}`);
  });

  it('consolidate unifies differing versions', async () => {
    const fx = await fixture('consolidate', false);
    await run(['add', fx.projects[0], 'package', 'Newtonsoft.Json', '--version', '13.0.1'], path.dirname(fx.projects[0]));
    await run(['add', fx.projects[1], 'package', 'Newtonsoft.Json', '--version', '13.0.3'], path.dirname(fx.projects[1]));
    await open(fx);
    const c = (await waitFor('consolidate', (m) => m.rows.length > 0)).m as Extract<ToWebview, { type: 'consolidate' }>;
    const row = c.rows.find((r) => r.id === 'Newtonsoft.Json')!;
    await api.send(fx.sln, { type: 'run', request: { kind: 'consolidate', packageId: row.id, version: row.target, projects: fx.projects } });
    const [a, b] = [await refs(fx.projects[0]), await refs(fx.projects[1])];
    assert.deepStrictEqual(a, b);
    assert.deepStrictEqual(a, [`Newtonsoft.Json@${row.target}`]);
  });

  it('cpm fixture: update changes Directory.Packages.props, not csproj', async () => {
    const fx = await fixture('cpm', true);
    await run(['add', fx.projects[0], 'package', 'Newtonsoft.Json', '--version', '13.0.1'], path.dirname(fx.projects[0]));
    const csprojBefore = await fs.readFile(fx.projects[0], 'utf8');
    await open(fx);
    const row = ((await waitFor('updates', (m) => m.rows.length > 0)).m as Extract<ToWebview, { type: 'updates' }>).rows[0];
    await api.send(fx.sln, { type: 'run', request: { kind: 'update', packageId: row.id, version: row.latest, projects: row.projects } });
    const props = await fs.readFile(fx.props!, 'utf8');
    assert.ok(props.includes(`Version="${row.latest}"`) && !props.includes('Version="13.0.1"'), props);
    assert.strictEqual(await fs.readFile(fx.projects[0], 'utf8'), csprojBefore);
  });

  it('works without C# Dev Kit', () => {
    assert.strictEqual(vscode.extensions.getExtension('ms-dotnettools.csdevkit'), undefined);
    assert.ok(ourExtension()?.isActive);
  });
});
