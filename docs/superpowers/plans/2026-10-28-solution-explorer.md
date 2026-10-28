# C# Workbench — Solution Explorer (v2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Visual-Studio-style Solution Explorer for the C# Workbench extension. It lives in its own Activity Bar view, shows only the solution and its documents, and has VS context menus, including Add ▸ New Item… with every template.

**Architecture:**
- **Pure modules** (vitest), under `src/solution/`, read solution/project data into a model and compute the tree, the nesting, the namespaces and the CLI step plans.
- **A thin `vscode` layer** provides a native `TreeDataProvider`, commands, menus, tasks and debugging.
- **Changes go through the `dotnet` CLI**, with one isolated, validated exception for solution-folder edits in `.sln`/`.slnx`.
- **The v1 modules are reused** (`DotnetCli`, `findDotnet`, `selectTargets`, `readPackageRefs`, `PanelManager`).

**Tech Stack:** Same as v1: TypeScript, esbuild, vitest (+ happy-dom where needed), `@vscode/test-cli` (mocha, real VS Code), `fast-xml-parser` (read-only XML, always `parseTagValue:false`, `parseAttributeValue:false`). No new runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-10-28-solution-explorer-design.md` (v1 spec: `docs/superpowers/specs/2026-10-26-nuget-manager-design.md`)

## Global Constraints

- **No hand edits.** Never edit `.csproj`, `.sln` or `.slnx` text by hand. The **only** exception is the solution-folder module of Task 3. Everything else goes through `dotnet sln add/remove [--solution-folder]`, `dotnet add/remove reference`, `dotnet new`, `dotnet user-secrets init`, `dotnet build/clean/run`, and `dotnet msbuild -getItem/-getProperty`.
- **Processes:** always `execFile`/`ProcessExecution` with argument arrays, never through a shell.
- **No C# Dev Kit dependency.** No `extensionDependencies`. Debug needs `ms-dotnettools.csharp`. If it's missing, warn with an install button, and Run must keep working.
- **Naming:**
  - view container id `csharpWorkbench`;
  - view id `csharpWorkbench.solutionExplorer`, title "Solution Explorer";
  - commands prefixed `csharpWorkbench.`;
  - setting `csharpWorkbench.solutionExplorer.autoReveal` (boolean, default `true`).
- **Destructive actions** (Delete, Remove from Solution, Remove reference/package, Remove solution folder) ask for a modal confirmation. Delete uses the Trash (`useTrash: true`).
- **Hidden by default:** `bin/` and `obj/`, plus anything outside the evaluated item set. A **Show All Files** toggle in the view title shows them.
- **Strings:** visible strings go through `vscode.l10n.t` / `package.nls.json`, and the bundle is regenerated with `npx @vscode/l10n-dev export src`.
- **Platforms:** macOS and Linux. Minimum SDK 8.0. `.slnx` needs SDK 9.0.200+ (reuse v1's check).
- **Tests:**
  - unit: `npm run test:unit -- <path>` (never `npx vitest`, because the repo path contains `#`);
  - e2e: `npm run test:int`, with `PATH="$HOME/.dotnet:$PATH" DOTNET_ROOT="$HOME/.dotnet"`.
- **Commits:** Conventional Commits, with **no `Co-Authored-By` or any Claude attribution trailer** (user's explicit rule).

## Review Focus

1. **Paths with spaces and `#`** (e.g. a project in `My App #1`) must work in the tree, the CLI calls, the solution-folder edits and New Item. → Task 3 test and Task 12 fixture.
2. **A `.sln` written by Visual Studio** (UTF-8 BOM, CRLF, `VisualStudioVersion = 17…`, platform sections) must be byte-identical outside the edited lines. → Task 3 tests on a real VS-generated file.
3. **Project evaluation fails** (restore missing, MSBuild error, SDK mismatch): the project still shows files from a filesystem walk, plus a warning node "Could not evaluate project — showing files on disk". It must not show an empty node. → Task 4 test.
4. **Invalid or colliding names**: names such as `2Customer` or `my-class`, a folder `My Folder`, or a file that already exists. Expected: the class/namespace identifiers are sanitized the way VS does (`_2Customer`, `my_class`, `My_Folder`), and an existing file is never overwritten (show an error). → Task 6 and Task 8 tests.
5. **A large solution** (20+ projects) must not block on open. Project items are evaluated lazily, when a project node is expanded, and cached until a watcher invalidates them. → Task 7 test (evaluation count).

---

## File structure (new unless marked)

```
src/solution/
  model.ts            types (below)
  slnParse.ts         parseSln / parseSlnx (read-only)
  slnFolders.ts       THE exception: pure text edits for solution folders
  slnWriter.ts        atomic write + `dotnet sln list` validation + rollback
  projectInfo.ts      project refs, TFMs, RootNamespace, UserSecretsId, LangVersion (read-only XML)
  projectItems.ts     parse `-getItem` JSON; fallback disk walk
  nesting.ts          VS file-nesting rules
  tree.ts             pure tree builder → TreeNode[]
  naming.ts           identifier/namespace sanitising, file-scoped detection
  codeTemplates.ts    built-in Class/Interface/Enum/Record/Struct text
  templateCatalog.ts  parse `dotnet new list --type item`, option detection, cache
  plans.ts            pure CLI step plans (rename project, move project to folder, remove folder with projects)
  state.ts            workspaceState keys (selected solution, startup project)
  SolutionTreeProvider.ts   vscode TreeDataProvider + watchers + reveal + drag-and-drop
  commands/files.ts         Add ▸ items, file/folder ops
  commands/solution.ts      projects, solution folders, references, packages
  commands/run.ts           build/rebuild/clean/run tasks, startup project, debug
  commands/secrets.ts       Manage User Secrets
src/dotnet/cli.ts (modify)  new methods (Task 1)
src/extension.ts (modify)   register the Solution Explorer (Task 7)
package.json (modify)       viewsContainers, views, commands, menus, setting (Tasks 7–11)
media/solution-explorer.svg activity bar icon (monochrome, 24×24, currentColor)
test/unit/solution/**, test/fixtures/solution/**, test/integration/solution.e2e.test.ts
```

### Shared types (`src/solution/model.ts`, Task 2; extended where noted)

```ts
export interface SolutionFolder { id: string; name: string; parentId?: string } // sln: GUID "{…}" upper-case; slnx: folder path "/src/sub/"
export interface SolutionProject { path: string; name: string; folderId?: string; typeGuid?: string }
export interface SolutionModel { path: string; kind: 'sln' | 'slnx'; folders: SolutionFolder[]; projects: SolutionProject[] }
export interface ProjectInfoData {                         // Task 4
  path: string; rootNamespace: string; targetFrameworks: string[]; projectRefs: string[]; // absolute paths
  userSecretsId?: string; fileScopedNamespaces: boolean;
}
export interface ProjectItem { fullPath: string; link?: string }            // Task 4
export interface ProjectItems { items: ProjectItem[]; evaluated: boolean; error?: string } // evaluated=false → disk walk
export type NodeKind = 'solution' | 'solutionFolder' | 'project' | 'dependencies' | 'packages' | 'projectRefs'
  | 'frameworks' | 'package' | 'projectRef' | 'framework' | 'folder' | 'file' | 'warning';
export interface TreeNode {                                                  // Task 5
  id: string; kind: NodeKind; label: string; description?: string;
  path?: string; projectPath?: string; contextValue: string; children?: TreeNode[]; missing?: boolean;
}
```

`contextValue` = `cw.<kind>`. Add the suffix `.startup` on the startup project and `.missing` on missing linked items. Menus match `viewItem =~ /^cw\.project/` etc.

---

### Task 1: New `dotnet` CLI wrappers

**Files:** Modify `src/dotnet/cli.ts`, `src/dotnet/parse.ts`. Test: `test/unit/dotnet/cli.test.ts`, `test/unit/dotnet/parse.test.ts`. Fixtures (captured from the real SDK 10.0.102 and 8.0.417, trimmed): `test/fixtures/cli/getitem.json`, `new-list-item.txt`, `new-help-class.txt`, `new-help-razorcomponent.txt`.

**Interfaces:**
- Consumes: `Exec`, `DotnetError`, `Output`, and the existing `DotnetCli` patterns (cwd = dirname of the target, every call logged, exit ≠ 0 throws).
- Produces, new `DotnetCli` methods with these exact args:
  - `slnAdd(sln, project, solutionFolder?)` → `sln <sln> add <project> [--solution-folder <folder>]`
  - `slnRemove(sln, project)` → `sln <sln> remove <project>`
  - `addReference(project, ref)` → `add <project> reference <ref>`
  - `removeReference(project, ref)` → `remove <project> reference <ref>`
  - `newTemplate(shortName, args: string[], cwd)` → `new <shortName> ...args` (cwd given explicitly)
  - `newList(): Promise<string>` → `new list --type item` (raw stdout)
  - `newHelp(shortName): Promise<string>` → `new <shortName> --help`
  - `userSecretsInit(project)` → `user-secrets init --project <project>`
  - `getItems(project, types: string[]): Promise<string>` → `msbuild <project> -getItem:<T1> -getItem:<T2> …` (raw stdout)
  - `getProperty(project, name): Promise<string>` → `msbuild <project> -getProperty:<name>`, returning stdout trimmed
- Produces, parsers in `parse.ts`:
  - `parseGetItems(json: string): Record<string, { identity: string; fullPath: string; link?: string }[]>`. Reads `Items.<Type>[]` (`Identity`, `FullPath`, `Link`). It tolerates leading text before the first `{`.

- [ ] **Step 1: Capture fixtures.** In a scratch dir outside the repo (`export PATH="$HOME/.dotnet:$PATH" DOTNET_ROOT="$HOME/.dotnet"`), create a classlib with one linked file (`<Compile Include="..\Shared\Shared.cs" Link="Shared\Shared.cs" />`). Run the commands above and save trimmed outputs. Record the SDK versions in the commit body.
- [ ] **Step 2: Failing tests.**
  - `cli.test.ts`: one exact-args test per new method, e.g. `slnAdd builds --solution-folder args` ⇒ `['sln','/s/A.sln','add','/s/p/P.csproj','--solution-folder','src/web']`, plus `newTemplate uses given cwd`.
  - `parse.test.ts`: `parseGetItems reads Compile and None with Link` ⇒ the linked item has `link === 'Shared/Shared.cs'` (normalise `\` → `/`), and `fullPath` is absolute.
- [ ] **Step 3:** `npm run test:unit -- test/unit/dotnet` → FAIL.
- [ ] **Step 4:** Implement.
- [ ] **Step 5:** → PASS. Commit `feat: dotnet cli wrappers for solution explorer`.

---

### Task 2: Read `.sln` / `.slnx` into a `SolutionModel`

**Files:** Create `src/solution/model.ts`, `src/solution/slnParse.ts`. Test: `test/unit/solution/slnParse.test.ts`. Fixtures: `test/fixtures/solution/vs.sln`, a real Visual Studio 2022 file with BOM, CRLF, nested solution folders `src`, `src/web` and `tests`, 3 projects, one project path containing `My App #1`, and platform sections. Also `test/fixtures/solution/basic.slnx`, the equivalent produced by `dotnet sln migrate`.

**Interfaces:**
- Produces:
  - `parseSln(text: string, slnPath: string): SolutionModel`. Folders are `Project("{2150E333-8FDC-42A3-9474-1A3956D46DE8}")` entries. Parents come from `GlobalSection(NestedProjects)`. Project paths become absolute, with `\` converted to `/`.
  - `parseSlnx(xml: string, slnxPath: string): SolutionModel`. Folders are `<Folder Name="/a/b/">`, with id = Name and parentId = parent path. Projects are `<Project Path=…>` inside a folder or at the root.
  - `loadSolution(path: string, readFile): Promise<SolutionModel>`.

- [ ] **Step 1: Failing tests:**
  - `parses nested solution folders from NestedProjects` ⇒ `web.parentId === src.id`
  - `assigns projects to folders`
  - `resolves project paths with spaces and #`
  - `parses slnx folders and projects`
  - `sln and slnx fixtures yield the same folder names and project paths`
  - `ignores BOM and CRLF`
- [ ] **Step 2:** FAIL → **Step 3:** implement (line-based for `.sln`; `fast-xml-parser` for `.slnx`) → **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat: parse sln and slnx solution structure`.

---

### Task 3: Solution-folder edits (the single exception)

**Files:** Create `src/solution/slnFolders.ts`, `src/solution/slnWriter.ts`. Test: `test/unit/solution/slnFolders.test.ts`, `test/unit/solution/slnWriter.test.ts`.

**Interfaces:**
- Consumes: `parseSln`, `parseSlnx`, `SolutionModel`, `DotnetCli.slnList`.
- Produces, pure functions returning the whole new file text:
  - `addFolder(text, kind, name, parentId?, newGuid: () => string): string`
    - `.sln`: insert `Project("{2150E333-…}") = "<name>", "<name>", "{GUID}"\r\nEndProject` (using the file's own line ending) after the last `EndProject`. If there's a parent, add `{GUID} = {PARENT}` in `NestedProjects`, creating that section inside `Global` if it's missing.
    - `.slnx`: insert `<Folder Name="/parent/name/" />` with the file's indentation style.
  - `renameFolder(text, kind, id, newName): string`
    - `.sln`: replace both name fields of that entry only.
    - `.slnx`: rewrite the Name of that folder and the prefix of every descendant folder.
  - `removeEmptyFolder(text, kind, id): string`. Throws `Error('Solution folder is not empty')` if it has child folders or projects. `.sln`: remove the `Project…EndProject` block and every `NestedProjects` line mentioning the id.
  - `writeSolutionAtomically(path, newText, deps: { readFile; writeFile; rename; validate: () => Promise<void> }): Promise<void>`.
    1. Keep the original text.
    2. Write `<path>.cw-tmp`, then rename it over the original.
    3. Run `validate()` (the caller passes `() => cli.slnList(path)`).
    4. On failure, write the original back and rethrow.
- Folder names are validated with `validateFolderName(name): string | undefined` (error message). It rejects empty names, `/ \ : * ? " < > |` and duplicates among siblings (case-insensitive).

- [ ] **Step 1: Failing tests** (on `vs.sln` / `basic.slnx` from Task 2):
  - `add root folder to sln keeps every other byte` ⇒ diffing lines shows only the inserted block, BOM and CRLF are kept, and `parseSln(result)` has the folder.
  - `add nested folder creates NestedProjects when missing`
  - `rename folder changes only that entry`
  - `rename slnx folder updates descendants`
  - `remove empty folder removes block and nesting lines`
  - `remove non-empty folder throws`
  - `validateFolderName rejects duplicates case-insensitively`
  - `writer restores original when validation fails` (fake deps; the final content equals the original)
  - `writer works on a path containing "My App #1"` (real temp dir)
- [ ] **Step 2:** FAIL → **Step 3:** implement → **Step 4:** PASS.
- [ ] **Step 5:** Integration check in `test/integration/cli-cpm.int.test.ts`'s style. Add `test/integration/slnFolders.int.test.ts`, run by `test:cli`, so update the script to run both files. It creates a real solution with `dotnet new sln --format sln` and `--format slnx`, then for each one:
  1. run `addFolder`, `renameFolder` and `removeEmptyFolder` via the writer;
  2. after each edit, `dotnet sln list` succeeds;
  3. `dotnet sln add --solution-folder` into the renamed folder works.

  Run `npm run test:cli` → PASS on SDK 10.0.102.
- [ ] **Step 6:** Commit `feat: validated solution-folder edits for sln and slnx`.

---

### Task 4: Project info and project items

**Files:** Create `src/solution/projectInfo.ts`, `src/solution/projectItems.ts`. Test: `test/unit/solution/projectInfo.test.ts`, `test/unit/solution/projectItems.test.ts`.

**Interfaces:**
- Consumes: `DotnetCli.getItems`, `parseGetItems`, `fast-xml-parser`.
- Produces:
  - `readProjectInfo(csprojPath, xml): ProjectInfoData`
    - `RootNamespace`, defaulting to the file name without `.csproj`.
    - `TargetFramework` or `TargetFrameworks`, split on `;`.
    - `ProjectReference Include`, resolved to absolute paths.
    - `UserSecretsId`.
    - `fileScopedNamespaces` = true when `LangVersion` ≥ 10 or is `latest`/`preview`, or when there's no `LangVersion` and every TFM is `net6.0` or later.
  - `loadProjectItems(projectPath, cli, fsWalk): Promise<ProjectItems>`
    - Calls `getItems(project, ['Compile','None','Content','EmbeddedResource','AdditionalFiles'])`.
    - On a `DotnetError`, returns `{ items: <walk>, evaluated: false, error: message }`.
    - The walk is every file under the project dir except `bin/`, `obj/`, `.git/`, `node_modules/` and `*.user`.
  - `walkProjectDir(dir, fs): Promise<string[]>`, absolute paths.

- [ ] **Step 1: Failing tests:**
  - `reads root namespace default and explicit`
  - `splits TargetFrameworks`
  - `resolves project references with spaces`
  - `file-scoped when net8.0 and no LangVersion`, and `not file-scoped for LangVersion 9`
  - `uses evaluated items when getItems succeeds` (fake CLI with the Task 1 fixture)
  - `falls back to disk walk with error when evaluation fails`
  - `walk skips bin, obj and .user files`
- [ ] **Step 2:** FAIL → **Step 3:** implement → **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat: read project info and evaluated items`.

---

### Task 5: Nesting rules and the tree builder

**Files:** Create `src/solution/nesting.ts`, `src/solution/tree.ts`. Test: `test/unit/solution/nesting.test.ts`, `test/unit/solution/tree.test.ts`.

**Interfaces:**
- Consumes: `SolutionModel`, `ProjectInfoData`, `ProjectItems`, `PackageRef` (v1 `readPackageRefs`).
- Produces:
  - `nestFiles(fileNames: string[]): Map<string, string>` (child → parent, within one folder). The rules, in order:
    - `X.*.json` → `X.json` (e.g. `appsettings.Development.json` → `appsettings.json`)
    - `X.xaml.cs` → `X.xaml`
    - `X.razor.cs`, `X.razor.css`, `X.razor.js` → `X.razor`
    - `X.cshtml.cs` → `X.cshtml`
    - `X.Designer.cs` → `X.resx` if present, else `X.cs`
    - `X.g.cs` / `X.g.i.cs` → `X.cs`
    - `X.min.js` / `X.min.css` → `X.js` / `X.css`
    - Only nest when the parent exists in the same folder.
  - `buildSolutionNodes(model: SolutionModel, opts: { startupProject?: string }): TreeNode[]`: the solution node with its children (folders and projects, sorted: folders first, then by name case-insensitive). Project nodes have no children yet (lazy).
  - `buildProjectChildren(project, info, items, packages, opts: { showAllFiles: boolean; allFiles?: string[] }): TreeNode[]`
    - A `Dependencies` node with `Packages` (`package`: label id, description version), `Projects` (`projectRef`) and `Frameworks`.
    - Then the folder/file tree from items relative to the project dir. Linked items are placed by `link`, and a linked item whose file is missing gets `missing:true` with contextValue `cw.file.missing`.
    - Nesting is applied.
    - With `showAllFiles`, add the files from `allFiles` that aren't in items, with description `excluded`.
    - When `items.evaluated` is false, prepend a `warning` node: `Could not evaluate project — showing files on disk`.
  - Node ids are stable: `<kind>:<absolute path or folder id>`.

- [ ] **Step 1: Failing tests:**
  - `nests appsettings environments under appsettings.json`
  - `nests Designer.cs under resx before cs`
  - `does not nest without parent`
  - `solution children: folders before projects, sorted`
  - `startup project gets .startup context suffix`
  - `project children start with Dependencies`
  - `linked item placed by Link and flagged missing`
  - `showAllFiles adds excluded files`
  - `unevaluated project shows warning node first`
- [ ] **Step 2:** FAIL → **Step 3:** implement → **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat: solution tree model with vs file nesting`.

---

### Task 6: Naming, built-in code templates, template catalog

**Files:** Create `src/solution/naming.ts`, `src/solution/codeTemplates.ts`, `src/solution/templateCatalog.ts`. Test: `test/unit/solution/naming.test.ts`, `codeTemplates.test.ts`, `templateCatalog.test.ts`.

**Interfaces:**
- Produces:
  - `toIdentifier(s): string`. Replace each invalid character with `_`, prefix `_` if the name starts with a digit, keep Unicode letters, and escape C# keywords with `@`.
  - `namespaceFor(rootNamespace, projectDir, folderDir): string`. The root namespace plus each relative folder segment passed through `toIdentifier`, joined with `.`.
  - `renderCodeTemplate(kind: 'class'|'interface'|'enum'|'record'|'struct', name, ns, fileScoped): string`. Output must match this exactly for `class Customer`, `ns MyApp.Core.Models`, file-scoped:
    ```
    namespace MyApp.Core.Models;

    public class Customer
    {
    }
    ```
    Block-scoped wraps the type in `namespace X\n{\n    …\n}` with 4-space indentation. `record` gives `public record Customer;`-style output: `public record Customer\n{\n}`. The file ends with `\n`.
  - `parseNewList(stdout): ItemTemplate[]` with `interface ItemTemplate { name: string; shortNames: string[]; languages: string[]; tags: string }`. Parse column widths from the dashed separator line. Short names may be comma-separated, and languages look like `[C#],F#`.
  - `parseTemplateOptions(helpStdout): { namespace: boolean; project: boolean }`. True when `--namespace`/`-na` and `--project` appear in the help.
  - `class TemplateCatalog { constructor(cli); list(): Promise<ItemTemplate[]>; options(shortName): Promise<{namespace:boolean;project:boolean}> }`. Results are cached per instance, and `refresh()` clears the cache.
  - `newItemArgs(name: string, outDir: string, ns: string, projectPath: string, opts: { namespace: boolean; project: boolean }): string[]`, which returns `['-n', name, '-o', outDir, ...(opts.namespace ? ['--namespace', ns] : []), ...(opts.project ? ['--project', projectPath] : [])]`.

- [ ] **Step 1: Failing tests:**
  - `toIdentifier("2Customer") === "_2Customer"`, `toIdentifier("my-class") === "my_class"`, `toIdentifier("class") === "@class"`.
  - `namespaceFor("MyApp.Core", "/p", "/p/My Folder/Sub") === "MyApp.Core.My_Folder.Sub"`.
  - `renders file-scoped class exactly` (the string above), `renders block-scoped interface`.
  - `parses dotnet new list item table with comma short names` (Task 1 fixture).
  - `detects namespace option for class template`, `detects no namespace option for razorcomponent` (whatever the real fixture shows; assert the real value).
  - `catalog caches list until refresh` (the CLI is called once).
- [ ] **Step 2:** FAIL → **Step 3:** implement → **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat: naming rules, code templates and dotnet new catalog`.

---

### Task 7: Solution Explorer view (tree provider, picker, state, watchers, reveal)

**Files:** Create `src/solution/state.ts`, `src/solution/SolutionTreeProvider.ts`, `media/solution-explorer.svg`. Modify `src/extension.ts`, `package.json`. Test: `test/unit/solution/provider.test.ts`. Fake the minimal `vscode` surface by injecting deps; don't import `vscode` in the testable core. Split the provider into `SolutionTreeCore` (pure, testable) and the `vscode` adapter in the same file or in `SolutionTreeProvider.ts` + `treeCore.ts`.

**Interfaces:**
- Consumes: Tasks 2, 4, 5, v1 `selectTargets`, `readPackageRefs`.
- Produces:
  - `state.ts`: `getSelectedSolution(ws: Memento): string | undefined`, `setSelectedSolution(ws, path)`, `getStartupProject(ws, solutionPath)`, `setStartupProject(ws, solutionPath, projectPath | undefined)`. The keys are `cw.selectedSolution` and `cw.startup:<solutionPath>`.
  - `class SolutionTreeCore`. Its constructor takes `{ loadSolution, loadProjectInfo, loadProjectItems, loadPackages, walk, state }`.
    - `roots()`: the solution nodes, or loose `.csproj` project nodes when there's no solution.
    - `children(node)`: lazy and cached per project.
    - `invalidate(path)`: drops the cache of the project that owns the path, or the whole solution when a `.sln`/`.slnx` changes.
    - `setShowAllFiles(b)`.
    - `projectForPath(p)`.
    - `nodeForPath(p)`.
  - The `vscode` adapter:
    - registers `TreeDataProvider<TreeNode>` + `createTreeView('csharpWorkbench.solutionExplorer', { showCollapseAll: true, canSelectMany: true, dragAndDropController })`;
    - maps `TreeNode` to `TreeItem`, using `resourceUri` for files and folders so the file icon theme applies, `ThemeIcon` for the others, and the `vscode.open` command on files;
    - sets the context key `csharpWorkbench.hasSolution`.
  - `package.json`:
    - `viewsContainers.activitybar` entry `csharpWorkbench` with title "Solution Explorer" and icon `media/solution-explorer.svg`;
    - `views.csharpWorkbench` entry `csharpWorkbench.solutionExplorer`;
    - a `viewsWelcome` entry for "No solution or project found";
    - the setting `csharpWorkbench.solutionExplorer.autoReveal`;
    - view/title commands `csharpWorkbench.selectSolution` (only when there are several), `csharpWorkbench.refresh`, `csharpWorkbench.toggleShowAllFiles`;
    - activation `onView:csharpWorkbench.solutionExplorer` (implicit via contributes).
  - Watchers: `**/*.{cs,csproj,sln,slnx,props,targets,json,razor,cshtml,xaml,resx}` plus folder create/delete, debounced 300 ms → `invalidate` → `onDidChangeTreeData` for the affected node only.
  - Auto-reveal: on `window.onDidChangeActiveTextEditor`, when `autoReveal` is on and the view is visible, call `treeView.reveal(nodeForPath(file), { select: true, focus: false, expand: true })`.
  - Selecting a solution is remembered through `state.ts`.

- [ ] **Step 1: Failing tests** (core with fakes):
  - `roots show selected solution, falling back to first`
  - `no solution shows loose projects`
  - `project children load lazily once` (with 20 projects, `loadProjectItems` is not called before expansion and is called once per expanded project)
  - `invalidate of a .cs path reloads only its project`
  - `invalidate of the .sln reloads the solution`
  - `nodeForPath finds a nested file`
  - `startup project from state marks node`
- [ ] **Step 2:** FAIL → **Step 3:** implement core, then adapter and `package.json`. **Step 4:** PASS, then `npx tsc --noEmit` and `npm run build`.
- [ ] **Step 5:** Commit `feat: solution explorer view with lazy tree and auto-reveal`.

---

### Task 8: Add ▸ items and file/folder operations

**Files:** Create `src/solution/commands/files.ts`. Modify `package.json` (commands + `view/item/context` menus with an `Add` submenu `csharpWorkbench.add`). Test: `test/unit/solution/files.test.ts`. Put the pure helpers in `files.ts` and test them; the `vscode` glue stays thin.

**Interfaces:**
- Consumes: Task 6 (`namespaceFor`, `renderCodeTemplate`, `TemplateCatalog`, `newItemArgs`, `toIdentifier`), Task 4 `readProjectInfo`, Task 7 core.
- Produces commands (all `csharpWorkbench.` prefixed):
  - `newItem` shows a QuickPick, grouped by separator: first "Code" (Class, Interface, Enum, Record, Struct, built-in), then the catalog templates filtered to `languages` containing `C#` or none, sorted by name. It then asks for the name via InputBox, with the default extension shown.
    - Built-in kinds write `<folder>/<name>.cs` from `renderCodeTemplate`.
    - Catalog templates run `cli.newTemplate(shortName, newItemArgs(...), folder)`.
    - Open the created file(s): the newest files created under `-o`.
  - `newClass` and `newInterface` are shortcuts for the built-ins.
  - `newFolder`, `addExistingItem` (an `showOpenDialog` with multi-select that copies into the folder), `rename` (InputBox, `workspace.fs.rename`), `delete` (modal confirm, `workspace.fs.delete({ recursive: true, useTrash: true })`, multi-select), `copy` / `paste` (in-extension clipboard of paths; paste copies into the target folder and, on a name clash, uses `Name - Copy.ext` like VS), `copyPath`, `revealInFinder` (`revealFileInOS`), `openInTerminal` (`createTerminal({ cwd })`).
  - Drag-and-drop: move files/folders within the same project (`workspace.fs.rename`). Drops onto another project are refused with a message.
  - Pure helpers:
    - `targetPathFor(folder, name, ext): string`
    - `ensureNotExists(path, exists): Promise<void>` (throws `File already exists: <name>`)
    - `copyName(existingNames: Set<string>, name): string`
    - `isSameProject(core, a, b): boolean`

- [ ] **Step 1: Failing tests:**
  - `class in Models folder gets project namespace + Models` ⇒ content equals `renderCodeTemplate('class','Customer','MyApp.Core.Models',true)`.
  - `newItem refuses existing file`.
  - `catalog item passes namespace when supported` (fake catalog + CLI ⇒ exact args).
  - `copyName produces "X - Copy.cs" then "X - Copy (2).cs"`.
  - `drag between projects is refused`.
- [ ] **Step 2:** FAIL → **Step 3:** implement. Wire the menus:
  - `Add ▸` on `cw.project` / `cw.folder`;
  - file operations on `cw.file` / `cw.folder`;
  - `New Folder` in `Add ▸`.
- [ ] **Step 4:** PASS, then tsc and build.
- [ ] **Step 5:** Commit `feat: add new item, class, interface, folder and file operations`.

---

### Task 9: Projects, solution folders, references, packages

**Files:** Create `src/solution/plans.ts`, `src/solution/commands/solution.ts`. Modify `package.json`. Test: `test/unit/solution/plans.test.ts`.

**Interfaces:**
- Consumes: Task 1 CLI, Task 3 (`addFolder`, `renameFolder`, `removeEmptyFolder`, `validateFolderName`, `writeSolutionAtomically`), Task 2 model, v1 `PanelManager.open(target, { preselectProject })` and `selectTargets`.
- Produces, pure plans in `plans.ts`:
  - `type Step = { op: 'slnAdd'|'slnRemove'|'addRef'|'removeRef'|'renameFile'; args: string[] }`
  - `planRenameProject(model, projectPath, newName, dependents: string[]): Step[]`, in this exact order:
    1. `slnRemove(old)`
    2. `removeRef` in each dependent
    3. `renameFile(old.csproj → new.csproj, same dir)`
    4. `slnAdd(new, folderPath?)`
    5. `addRef` in each dependent
  - `folderPathOf(model, folderId): string`, e.g. `src/web` for nested folders. This is the value for `--solution-folder`.
  - `planRemoveFolder(model, folderId): { projectRemovals: string[]; folderIdsBottomUp: string[] }`
  - `dependentsOf(infos: ProjectInfoData[], projectPath): string[]`
- Produces commands:
  - `addNewProject` (solution/solutionFolder): a QuickPick of `dotnet new list --type project` (reuse `parseNewList` with that type), then the name, then `newTemplate(short, ['-n', name, '-o', <solutionDir>/<name>], solutionDir)`, then `slnAdd(sln, proj, folderPath?)`.
  - `addExistingProject`: open a `.csproj` dialog, then `slnAdd`.
  - `newSolutionFolder`, `renameSolutionFolder`, `removeSolutionFolder`:
    - These use the Task 3 writer, with `validate = () => cli.slnList(sln)`.
    - Removing a folder that contains projects asks for confirmation, then runs `slnRemove` for each project, then removes the folders bottom-up.
  - `removeFromSolution` (confirm), `renameProject` (InputBox + `planRenameProject` executed sequentially; on failure, show the error and the step index).
  - `addProjectReference`: a multi-pick QuickPick of the other solution projects, excluding self and existing references, then `addReference` for each one.
  - `removeProjectReference` (confirm, multi-select).
  - `manageNugetForProject` / `manageNugetForSolution` / `addNugetPackage` → v1 `PanelManager.open(target, { preselectProject })`.
  - `removePackage` (confirm) → v1 `operations` via `cli.removePackage(project, id)`.
  - `updatePackage` → opens the v1 manager on the Updates tab. If the protocol has no tab selection, open the manager and leave the tab as is.
  - Every successful command invalidates the affected nodes.
  - Startup-project state (Task 7 `state.ts`):
    - `renameProject` moves the stored startup path to the new `.csproj`;
    - `removeFromSolution` and the project removals inside `removeSolutionFolder` clear it when it points at a removed project.

    Test: `startup state follows rename and clears on remove` (fake Memento).

- [ ] **Step 1: Failing tests:**
  - `rename plan order is slnRemove, removeRefs, rename, slnAdd with folder, addRefs` (exact steps for a project in `src/web` with 2 dependents).
  - `folderPathOf builds nested path`.
  - `planRemoveFolder lists nested projects and folders bottom-up`.
  - `dependentsOf finds projects referencing target`.
- [ ] **Step 2:** FAIL → **Step 3:** implement plans, then commands and menus:
  - solution: Add ▸ New Project…/Existing Project…/New Solution Folder, Manage NuGet Packages for Solution…;
  - solutionFolder: Add ▸ …, Rename, Remove;
  - project: Rename, Remove from Solution, Add ▸ Project Reference…/NuGet Package…, Manage NuGet Packages…;
  - packages/package/projectRefs/projectRef: the item menus.
- [ ] **Step 4:** PASS, then tsc and build.
- [ ] **Step 5:** Commit `feat: project, solution folder, reference and package commands`.

---

### Task 10: Build, Run, Startup Project, Debug

**Files:** Create `src/solution/commands/run.ts`. Modify `package.json`. Test: `test/unit/solution/run.test.ts`.

**Interfaces:**
- Consumes: Task 1 `getProperty`, Task 7 `state.ts`.
- Produces:
  - `dotnetTask(kind: 'build'|'rebuild'|'clean'|'run', targetPath, dotnet): { name: string; args: string[] }`, a pure function:
    - build ⇒ `['build', target]`
    - rebuild ⇒ `['build', target, '--no-incremental']`
    - clean ⇒ `['clean', target]`
    - run ⇒ `['run', '--project', target]`

    Name examples: `Build MyApp.Api`, `Rebuild Solution 'MyApp'`. The `vscode` side creates a `Task` with `ProcessExecution(dotnet, args, { cwd })`, `problemMatchers: ['$msCompile']`, group Build (or none for run), and executes it.
  - Commands:
    - `build` / `rebuild` / `clean` on a project or the solution;
    - `run` on a project;
    - `setStartupProject` (stores state, refreshes the node);
    - `runStartup` / `debugStartup` (in the view title; ask to pick when no startup project is set);
    - `debug` on a project.
  - `debugConfigFor(projectPath, targetPath, name): vscode.DebugConfiguration`, a pure function returning `{ type: 'coreclr', request: 'launch', name: 'C# Workbench: <name>', program: targetPath, cwd: dirname(projectPath), console: 'integratedTerminal', stopAtEntry: false }`.
  - Debug flow:
    1. If `extensions.getExtension('ms-dotnettools.csharp')` is missing, show a warning with an `Install C# extension` button that runs `workbench.extensions.installExtension`, then stop.
    2. Run the build task and wait for it to end. Stop if the exit code is ≠ 0.
    3. `targetPath = cli.getProperty(project, 'TargetPath')`. If it's empty for a multi-target project, use the first TFM: `getProperty` with `-p:TargetFramework=<tfm>`. Extend `getProperty(project, name, props?: Record<string,string>)` → `-p:K=V` args.
    4. `debug.startDebugging(folder, debugConfigFor(...))`. If it returns false, show "The .NET debugger is not available in this editor. Use Run instead." with a `Run` button.
  - A `DebugConfigurationProvider` registered for `coreclr` with `DebugConfigurationProviderTriggerKind.Dynamic` returns one config per startup project (built from `debugConfigFor` with `program` resolved at resolve-time via `resolveDebugConfigurationWithSubstitutedVariables`, which builds first).

- [ ] **Step 1: Failing tests:**
  - `rebuild uses --no-incremental`
  - `run uses --project`
  - `debug config is coreclr launch with program and cwd`
  - `getProperty passes TargetFramework for multi-target`
- [ ] **Step 2:** FAIL → **Step 3:** implement. **Step 4:** PASS, then tsc and build.
- [ ] **Step 5:** Commit `feat: build, run, startup project and debug`.

---

### Task 11: Manage User Secrets, menu polish, l10n

**Files:** Create `src/solution/commands/secrets.ts`. Modify `package.json`, `package.nls.json`, `l10n/bundle.l10n.json`. Test: `test/unit/solution/secrets.test.ts`.

**Interfaces:**
- Consumes: Task 1 `userSecretsInit`, Task 4 `readProjectInfo`.
- Produces:
  - `secretsPath(home, id): string` = `<home>/.microsoft/usersecrets/<id>/secrets.json`.
  - The `manageUserSecrets` command:
    1. If the project has no `UserSecretsId`, run `userSecretsInit(project)` and re-read the project.
    2. Ensure the file exists (`{}\n` if new, creating directories).
    3. Open it.
- Menu polish: the final `view/item/context` groups, in the order of the spec §2 menus. Separators via groups `1_add`, `2_build`, `3_run`, `4_manage`, `5_os`, `6_edit`, `7_remove`. `Manage NuGet Packages…` appears on project, solution and `packages`.
- Every new visible string goes through `l10n.t`. Regenerate the bundle, and update `test/unit/l10nBundle.test.ts` if it pins keys.

- [ ] **Step 1: Failing tests:** `secretsPath`, `init runs only when UserSecretsId missing` (fake CLI + fs), `creates {} file when missing`.
- [ ] **Step 2:** FAIL → **Step 3:** implement. **Step 4:** PASS, then tsc, build and `npm run test:unit`.
- [ ] **Step 5:** Commit `feat: manage user secrets and finalize solution explorer menus`.

---

### Task 12: End-to-end tests for the success criteria, README

**Files:** Create `test/integration/solution.e2e.test.ts`. Modify `test/integration/helpers/fixtures.ts` (add `createSolutionExplorerFixture(dir): Promise<{ sln; api; core; tests }>`): solution folders `src` (with `src/web`) and `tests`, an ASP.NET Core project `MyApp.Api` in `src/web/My App #1/`, a classlib `MyApp.Core` with a `Models` folder, an xunit project, and `appsettings.Development.json`. Use `global.json` pinning SDK 8, as in v1. Also modify `src/extension.ts` (test API in Test mode only: `solution: { core: SolutionTreeCore; run(command, ...args) }`), `README.md` and `CHANGELOG.md`.

- [ ] **Step 1:** Write one mocha test per spec §7 success criterion. Each asserts real outcomes on disk or through the core, never only "no exception":
  1. `roots within 2 s show folders and projects, no bin/obj`
  2. `appsettings.Development.json nested under appsettings.json`
  3. `Add Class Customer in Models creates file with namespace MyApp.Core.Models and opens it` (assert `window.activeTextEditor` path)
  4. `New Item razorcomponent equals dotnet new output` (compare with a manual `dotnet new razorcomponent` in a temp copy)
  5. `Add Project Reference Api→Core matches dotnet add reference and Dependencies/Projects updates`
  6. `Add New Project into solution folder tests uses --solution-folder` (`parseSln` shows the folder parent)
  7. `Remove from Solution removes the project after confirm` (confirmation auto-accepted via a Test-mode hook)
  8. `Manage User Secrets opens the right secrets.json`
  9. `file created on disk appears in the tree within 1 s`
  10. `Manage NuGet Packages opens the v1 manager with the project preselected` (via the v1 test API `onPost` init message)

  Plus the Task 3 exception end to end: `New Solution Folder, Rename, Remove keep dotnet sln list valid`.
- [ ] **Step 2:** `npm run test:int` → FAIL (before the wiring is done, or because of a missing hook), then fix the wiring until PASS. All v1 e2e tests still pass.
- [ ] **Step 3:** README: add a "Solution Explorer" section (features, menus, Debug needs the C# extension, forks note, the solution-folder exception explained) and update the Limitations. CHANGELOG `0.2.0`, and bump `version` to `0.2.0`.
- [ ] **Step 4:** `npm run test:unit`, tsc, build, `npm run package` → all OK.
- [ ] **Step 5:** Commit `test: solution explorer end-to-end and docs`.
