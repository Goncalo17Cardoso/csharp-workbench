import * as assert from 'node:assert';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ExtensionApi } from '../../src/extension';
import { findDotnet } from '../../src/dotnet/locate';
import type { ToWebview } from '../../src/panel/protocol';
import type { SolutionModel, TreeNode } from '../../src/solution/model';
import { parseSln } from '../../src/solution/slnParse';
import type { SolutionTreeCore } from '../../src/solution/treeCore';
import { createSolutionExplorerFixture, type SolutionExplorerFixture } from './helpers/fixtures';

const exists = (p: string) => fs.access(p).then(() => true, () => false);
const ourExtension = () => vscode.extensions.all.find((e) => e.packageJSON?.name === 'csharp-workbench') as
  vscode.Extension<ExtensionApi> | undefined;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const real = (p: string) => fs.realpath(p);

describe('Solution Explorer end to end', function () {
  let dotnet: string | undefined;
  let api: ExtensionApi;
  let core: SolutionTreeCore;
  let wsRoot: string;
  let fx: SolutionExplorerFixture;
  let dir: string;
  let counter = 0;
  const posts: ToWebview[] = [];
  const extraCleanup: string[] = [];

  const sh = (args: string[], cwd: string) =>
    new Promise<string>((resolve, reject) =>
      execFile(dotnet!, args, { cwd }, (err, o, e) => (err ? reject(new Error(e || err.message)) : resolve(o))));
  const run = (cmd: string, ...args: unknown[]) => api.solution!.run(cmd, ...args);
  const model = async (): Promise<SolutionModel> => parseSln(await fs.readFile(fx.sln, 'utf8'), fx.sln);
  const slnProjects = async () => (await sh(['sln', fx.sln, 'list'], dir)).split(/\r?\n/).filter((l) => l.endsWith('.csproj'));

  async function walk(nodes: TreeNode[], pred: (n: TreeNode) => boolean): Promise<TreeNode | undefined> {
    for (const n of nodes) {
      if (pred(n)) return n;
      const hit = await walk(await core.children(n), pred);
      if (hit) return hit;
    }
    return undefined;
  }
  const find = async (pred: (n: TreeNode) => boolean) => walk(await core.roots(), pred);
  const must = async (what: string, pred: (n: TreeNode) => boolean) => {
    const n = await find(pred);
    assert.ok(n, `node not found: ${what}`);
    return n;
  };
  const projectNode = (csproj: string) => must(csproj, (n) => n.kind === 'project' && n.path === csproj);

  async function freshFixture(): Promise<void> {
    await clean();
    dir = path.join(wsRoot, `case${++counter} #1`);
    fx = await createSolutionExplorerFixture(dir, { dotnetPath: dotnet });
    await run('refresh');
    await sleep(1500); // let the watcher drain the events of the files just created
    core.reset();
  }
  async function clean(): Promise<void> {
    if (dir) await fs.rm(dir, { recursive: true, force: true });
    for (const p of extraCleanup.splice(0)) await fs.rm(p, { recursive: true, force: true });
  }

  before(async function () {
    dotnet = process.env.CSW_TEST_DOTNET || await findDotnet({ pathEnv: process.env.PATH ?? '', home: os.homedir(), exists });
    if (!dotnet) return this.skip();
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    assert.ok(folder, 'the test host opens a workspace folder');
    wsRoot = folder;
    await vscode.workspace.getConfiguration('csharpWorkbench').update('dotnetPath', dotnet, vscode.ConfigurationTarget.Global);
    await fs.writeFile(path.join(wsRoot, 'global.json'), '{"sdk":{"version":"8.0.100","rollForward":"latestFeature"}}');
    const ext = ourExtension();
    assert.ok(ext, 'extension is installed in the test host');
    api = await ext.activate();
    assert.ok(api.solution, 'Test-mode solution API exists');
    core = api.solution.core;
    api.confirmOverride = async () => true;
    api.onPost = (m) => posts.push(m);
  });

  beforeEach(async () => {
    await freshFixture();
    if (counter === 1) console.log(`fixture templates: api=${fx.templates.api} tests=${fx.templates.tests}`);
  });

  afterEach(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  after(async () => {
    await clean();
    await fs.rm(path.join(wsRoot, 'global.json'), { force: true });
  });

  it('roots within 2 s show folders and projects, no bin/obj', async () => {
    core.reset();
    const start = Date.now();
    const roots = await core.roots();
    const ms = Date.now() - start;
    console.log(`criterion 1: roots() in ${ms} ms`);
    assert.ok(ms < 2000, `roots took ${ms} ms`);
    const labels: string[] = [];
    const collect = async (nodes: TreeNode[]) => { for (const n of nodes) { labels.push(`${n.kind}:${n.label}`); await collect(await core.children(n)); } };
    await collect(roots);
    for (const want of ['solutionFolder:src', 'solutionFolder:web', 'solutionFolder:tests', 'project:MyApp.Api', 'project:MyApp.Core', 'project:MyApp.Tests']) {
      assert.ok(labels.includes(want), `missing ${want} in ${labels.join(', ')}`);
    }
    assert.ok(!labels.some((l) => /^(folder|file):(bin|obj)$/.test(l)), 'bin/obj are hidden');
  });

  it('appsettings.Development.json nested under appsettings.json', async () => {
    const parent = await must('appsettings.json', (n) => n.kind === 'file' && n.label === 'appsettings.json');
    const kids = await core.children(parent);
    assert.ok(kids.some((k) => k.label === 'appsettings.Development.json'), `children: ${kids.map((k) => k.label)}`);
    const top = await find((n) => n.kind === 'file' && n.label === 'appsettings.Development.json');
    assert.ok(top && core.getParent(top)?.label === 'appsettings.json', 'Development file sits under appsettings.json');
  });

  it('Add Class Customer in Models creates file with namespace MyApp.Core.Models and opens it', async () => {
    const models = await must('Models', (n) => n.kind === 'folder' && n.label === 'Models' && !!n.path?.includes('MyApp.Core'));
    await run('newClass', models, 'Customer');
    const file = path.join(dir, 'MyApp.Core', 'Models', 'Customer.cs');
    const text = await fs.readFile(file, 'utf8');
    assert.match(text, /namespace MyApp\.Core\.Models;?/);
    assert.match(text, /class Customer/);
    assert.strictEqual(await real(vscode.window.activeTextEditor!.document.uri.fsPath), await real(file));
  });

  it('New Item razorcomponent equals dotnet new output', async () => {
    const proj = await projectNode(fx.core);
    const copy = path.join(dir, 'MyApp.Core.manual');
    await fs.cp(path.join(dir, 'MyApp.Core'), copy, { recursive: true });
    extraCleanup.push(copy);
    await sh(['new', 'razorcomponent', '-n', 'Widget', '-o', copy], dir);
    await run('newItem', proj, 'razorcomponent', 'Widget');
    const mine = await fs.readFile(path.join(dir, 'MyApp.Core', 'Widget.razor'));
    const manual = await fs.readFile(path.join(copy, 'Widget.razor'));
    assert.ok(mine.equals(manual), 'Widget.razor is byte-identical to dotnet new output');
  });

  it('Add Project Reference Api to Core matches dotnet add reference and Dependencies/Projects updates', async () => {
    const copyDir = path.join(dir, 'src', 'web', 'Manual #2');
    await fs.cp(path.dirname(fx.api), copyDir, { recursive: true });
    extraCleanup.push(copyDir);
    const copyProj = path.join(copyDir, 'MyApp.Api.csproj');
    await sh(['add', copyProj, 'reference', fx.core], dir);
    const api = await projectNode(fx.api);
    await run('addProjectReference', api, [fx.core]);
    assert.strictEqual(await fs.readFile(fx.api, 'utf8'), await fs.readFile(copyProj, 'utf8'));
    const refs = await must('Projects', (n) => n.kind === 'projectRefs' && n.projectPath === fx.api);
    assert.deepStrictEqual((await core.children(refs)).map((n) => n.label), ['MyApp.Core']);
    const fresh = await core.children(await projectNode(fx.api));
    const deps = fresh.find((n) => n.kind === 'dependencies')!;
    const projects = (await core.children(deps)).find((n) => n.kind === 'projectRefs')!;
    assert.deepStrictEqual((await core.children(projects)).map((n) => n.label), ['MyApp.Core']);
  });

  it('Add New Project into solution folder tests uses --solution-folder', async () => {
    const folder = await must('tests', (n) => n.kind === 'solutionFolder' && n.label === 'tests');
    await run('addNewProject', folder, 'classlib', 'MyApp.More');
    const m = await model();
    const tests = m.folders.find((f) => f.name === 'tests')!;
    const added = m.projects.find((p) => p.name === 'MyApp.More');
    assert.ok(added, 'project is in the solution');
    assert.strictEqual(added.folderId, tests.id);
    assert.ok((await slnProjects()).some((p) => p.endsWith('MyApp.More.csproj')));
  });

  it('Remove from Solution removes the project after confirm', async () => {
    const proj = await projectNode(fx.tests);
    await run('removeFromSolution', proj);
    assert.ok(!(await slnProjects()).some((p) => p.endsWith('MyApp.Tests.csproj')), 'dotnet sln list no longer has it');
    assert.ok(!(await model()).projects.some((p) => p.name === 'MyApp.Tests'));
    assert.ok(await exists(fx.tests), 'project file stays on disk');
  });

  it('Manage User Secrets opens the right secrets.json', async () => {
    const proj = await projectNode(fx.api);
    await run('manageUserSecrets', proj);
    const id = /<UserSecretsId>([^<]+)<\/UserSecretsId>/.exec(await fs.readFile(fx.api, 'utf8'))?.[1];
    assert.ok(id, 'UserSecretsId was initialised');
    const secretsDir = path.join(os.homedir(), '.microsoft', 'usersecrets', id);
    extraCleanup.push(secretsDir);
    const expected = path.join(secretsDir, 'secrets.json');
    assert.strictEqual(await real(vscode.window.activeTextEditor!.document.uri.fsPath), await real(expected));
  });

  it('file created on disk appears in the tree within 1 s', async () => {
    const proj = await projectNode(fx.core);
    await core.children(proj); // warm the cache so a stale entry would be observable
    const file = path.join(dir, 'MyApp.Core', 'Marker.cs');
    const start = Date.now();
    await fs.writeFile(file, 'class Marker { }\n');
    let ms = -1;
    while (Date.now() - start < 1000) {
      if ((await core.children(proj)).some((n) => n.label === 'Marker.cs')) { ms = Date.now() - start; break; }
      await sleep(25);
    }
    console.log(`criterion 9: file appeared after ${ms} ms`);
    assert.ok(ms >= 0, 'Marker.cs did not appear within 1 s');
  });

  it('Manage NuGet Packages opens the v1 manager with the project preselected', async () => {
    posts.length = 0;
    const proj = await projectNode(fx.core);
    await run('manageNugetForProject', proj);
    const deadline = Date.now() + 60_000;
    let init: Extract<ToWebview, { type: 'init' }> | undefined;
    while (!init && Date.now() < deadline) {
      init = posts.find((m): m is Extract<ToWebview, { type: 'init' }> => m.type === 'init');
      if (!init) await sleep(50);
    }
    assert.ok(init, 'init message posted');
    assert.strictEqual(init.preselectProject, fx.core);
  });

  it('New Solution Folder, Rename, Remove keep dotnet sln list valid', async () => {
    const root = await must('solution', (n) => n.kind === 'solution');
    const names = async () => (await model()).folders.map((f) => f.name).sort();
    const before = await names();
    assert.deepStrictEqual(before, ['src', 'tests', 'web']);

    await run('newSolutionFolder', root, 'docs');
    await slnProjects();
    assert.deepStrictEqual(await names(), ['docs', 'src', 'tests', 'web']);

    const docs = await must('docs', (n) => n.kind === 'solutionFolder' && n.label === 'docs');
    await run('renameSolutionFolder', docs, 'documents');
    await slnProjects();
    assert.deepStrictEqual(await names(), ['documents', 'src', 'tests', 'web']);

    const renamed = await must('documents', (n) => n.kind === 'solutionFolder' && n.label === 'documents');
    await run('removeSolutionFolder', renamed);
    assert.strictEqual((await slnProjects()).length, 3, 'all projects are still listed');
    assert.deepStrictEqual(await names(), ['src', 'tests', 'web']);
  });
});
