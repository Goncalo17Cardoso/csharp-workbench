# Architecture

C# Workbench Studio is a VS Code extension written in TypeScript. This document explains how it is organised and the rules the code follows. For what the extension does, see the [README](README.md).

## Principles

- **The `dotnet` CLI does the real work.** The extension does not reimplement MSBuild or NuGet. Project and solution changes go through `dotnet add package`, `dotnet sln add/remove`, `dotnet add/remove reference`, `dotnet new`, `dotnet user-secrets` and `dotnet build/run`. Project contents and properties are read through `dotnet msbuild -getItem` and `-getProperty`, so the extension sees what MSBuild sees. Processes always run through `execFile` with an argument array, never a shell.
- **Logic is kept apart from VS Code.**
  - Everything that makes a decision lives in pure modules with no `vscode` import: parsing XML and solution files, planning edits, computing namespaces, validating names. These run under plain Node and are unit-tested with vitest.
  - The VS Code layer (commands, tree views, webview panels) is kept thin and only wires that logic to the editor.
- **Project files are not edited by hand, with two exceptions.** The CLI cannot create empty solution folders or change MSBuild properties, so two dedicated modules edit those files directly, under strict rules (see [Editing project files safely](#editing-project-files-safely)).
- **No dependency on C# Dev Kit.** Only Debug needs the C# extension (`ms-dotnettools.csharp`), for its `coreclr` debugger.

## Source layout

| Folder | What it holds |
|---|---|
| `src/extension.ts` | Activation, command registration, and a test-only API exposed in Test mode. |
| `src/core` | Shared types, version comparison, l10n helpers, and the atomic file writer (`atomicWrite.ts`). |
| `src/dotnet` | Locating `dotnet`, running it (`exec.ts`), the typed CLI wrapper (`cli.ts`) and output parsing. |
| `src/nuget` | NuGet feeds: v3, v2 and local folders, `nuget.config` reading, and result aggregation. |
| `src/ops`, `src/state` | NuGet operations (install, update, remove, consolidate) and the view models of the NuGet panel. |
| `src/panel` | The NuGet webview host: panel, controller and message protocol. |
| `src/webview` | Browser-side code of both webviews: the NuGet panel (`main.ts`, `views/`) and Project Properties (`properties/`). |
| `src/workspace` | Finding solutions and projects in the workspace. |
| `src/solution` | Solution Explorer: solution parsing, tree building, file nesting, templates, commands, Run/Debug. |
| `src/properties` | Project Properties: `.csproj` scanner and editor, field schema, model, panel host. |
| `src/launch` | Launch profiles: `launchSettings.json` store and the active profile. |
| `src/sync` | Sync Namespaces: C# tokenizer, planner and the refactor-preview command. |

## Features

### NuGet package manager

- A webview panel with Browse, Installed, Updates and Consolidate tabs.
- Search and package details come straight from the feeds configured in `nuget.config`. The extension talks to v3 and v2 feeds and local folders itself (`src/nuget/feeds`).
- Installing, updating and removing packages runs `dotnet add package` / `dotnet remove package`. Central Package Management (`Directory.Packages.props`) is respected.
- The panel and the extension exchange typed messages (`src/panel/protocol.ts`). The controller holds the logic and is tested without a webview.

### Solution Explorer

- A native VS Code tree (`TreeDataProvider`) in its own activity bar view. Being native, it inherits the theme, file icons, keyboard navigation, multi-select and drag and drop.
- Solution folders come from reading the `.sln` / `.slnx` file (`slnParse.ts`), because `dotnet sln list` does not return them.
- Project items come from `dotnet msbuild -getItem`. If that evaluation fails, the tree falls back to a disk walk and marks the project with a warning.
- Projects are loaded lazily, when expanded, and cached until a file watcher reports a relevant change. This keeps large solutions responsive.
- New files use built-in templates (class, interface, enum, record, struct) with a namespace computed the way Visual Studio does it, or any item template installed for `dotnet new`.
- Run uses `dotnet run`. Debug builds the project, reads `TargetPath`, and starts an in-memory `coreclr` configuration. It never writes to `.vscode/launch.json`.

### Project Properties

- A webview with Application, Build, Package, Assembly, Debug and User Secrets sections.
- Values are evaluated with one `dotnet msbuild -getProperty:A -getProperty:B …` call, so the page shows what MSBuild actually uses.
- The origin of each value comes from an offset-tracking scanner of the `.csproj` (`csprojScan.ts`):
  - **project**: defined in an unconditional `PropertyGroup`; editable.
  - **inherited**: from the SDK or a `Directory.Build.props`; editing creates an override.
  - **conditional**: set per configuration; read-only.
- Saving is explicit. The host validates every edit before writing.

### Launch profiles

- `Properties/launchSettings.json` is edited with `jsonc-parser`, which applies minimal edits and keeps comments and formatting. Malformed files are refused rather than overwritten.
- The active profile is stored per project in the workspace state.
- Run passes `--launch-profile` to `dotnet run`; Executable profiles run the configured program directly. Debug builds the `coreclr` configuration from the profile's arguments, environment variables, working directory and application URL.

### Sync Namespaces

1. **Tokenizer** (`csTokens.ts`): a single-pass C# scanner. It finds namespace declarations, `using` directives, top-level type names and qualified names, each with exact offsets. It skips comments, strings of every kind (verbatim, interpolated, raw) and char literals.
2. **Planner** (`plan.ts`): computes the expected namespace of each file from the project's evaluated root namespace and its folder. It then produces the edits:
   - declaration changes;
   - `using` updates, including new usings so files keep compiling;
   - qualified-name rewrites.

   When it cannot be sure, it leaves the file alone and lists it in the Output channel. That covers files with `#if`, generated files, ambiguous types and partial types that would be split.
3. **Command** (`command.ts`): turns the plan into a `WorkspaceEdit` shown in VS Code's refactor preview. Nothing is written until the user confirms.

## Editing project files safely

Two modules edit project files directly: the solution-folder editor (`src/solution/slnFolders.ts`) and the `.csproj` property editor (`src/properties/csprojEdit.ts`). Both follow the same rules, enforced by the shared writer in `src/core/atomicWrite.ts`:

- Only the intended text changes. Everything else stays byte for byte, including formatting, comments, BOM and line endings. Each edit is checked by re-parsing the result.
- The write is atomic: a temporary file, then a rename.
- A `.cw-bak` backup of the original is kept until validation passes.
- Read-only files and files that changed on disk since they were read are refused.
- After writing, the result is validated with `dotnet` itself (`dotnet sln list`, or `dotnet msbuild -getProperty` for each edited property). If validation fails, the original is restored and the error is shown.

## Tests

| Command | What it runs |
|---|---|
| `npm run test:unit` | vitest unit tests of the pure modules and the webviews (with happy-dom). |
| `npm run test:cli` | Integration tests against the real `dotnet` CLI (SDK 8 and 10). |
| `npm run test:int` | End-to-end tests in a real VS Code instance, on real projects created with `dotnet new`. |

Test fixtures live in directories whose names contain a space and `#`, because those characters break naive path handling. Some tools fail on a repository path containing `#`, so the scripts in `scripts/` mirror the repository to a temporary directory before running tests.

## Build

`npm run build` uses esbuild to produce three bundles:

- `dist/extension.js`: the extension, for Node.
- `dist/webview/main.js`: the NuGet panel, for the browser.
- `dist/webview/properties.js`: the Project Properties page, for the browser.

`npm run package` builds and creates the `.vsix` with `vsce`.

## Localisation

Visible strings go through `vscode.l10n.t` (code) and `package.nls.json` (manifest). English strings live in `l10n/bundle.l10n.json`, and a unit test checks that every key used in the code is present there.
