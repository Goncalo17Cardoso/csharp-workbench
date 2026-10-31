# C# Workbench Studio

Visual Studio-style tools for .NET in VS Code, for macOS and Linux. It works without C# Dev Kit.

- **NuGet package manager**: browse, install, update and consolidate packages across a solution.
- **Solution Explorer**: the solution as Visual Studio shows it, with an Add menu for classes, items, projects and references.
- **Project Properties**: a page for the `.csproj` settings, showing the values MSBuild actually uses.
- **Launch profiles**: edit `launchSettings.json` and run or debug with the active profile.
- **Sync Namespaces**: fix namespaces after moving files, with a refactor preview.

How it is built is described in [ARCHITECTURE.md](ARCHITECTURE.md).

## NuGet package manager

A "NuGet: <solution>" editor tab with four views and a detail pane:

- **Browse**: search packages, include prerelease, pick a source (or "All"), choose a version and install it into any of the solution's projects.
- **Installed**: packages referenced by each project, with update and uninstall actions.
- **Updates**: packages with newer versions available, with a count badge.
- **Consolidate**: packages used with different versions across projects, unified in one step.
- **Central Package Management**: `Directory.Packages.props` is respected. Version changes apply centrally, and the UI warns when that affects several projects.
- **nuget.config sources**: v3 feeds, legacy v2 feeds, local folders, and feeds with credentials stored in `nuget.config`.
- **Package details**: rendered README, dependencies per target framework, deprecation and vulnerability warnings when the source reports them.

All project changes go through the `dotnet` CLI (`dotnet add package` / `dotnet remove package`); project files are never edited by hand. The `dotnet` output is shown in the "C# Workbench" Output channel.

## Solution Explorer

A "Solution Explorer" view (in the C# Workbench activity bar container) shows the open solution the way Visual Studio does, without needing C# Dev Kit.

- **Tree**: solution folders, projects, folders and files. `bin/` and `obj/` are hidden; the **Show All Files** toggle in the view title reveals them and excluded files. Related files nest like in Visual Studio (for example `appsettings.Development.json` under `appsettings.json`, `.cs` under `.razor`).
- **Dependencies**: Packages, Projects and Frameworks per project.
- **Live updates**: files created, renamed or deleted outside VS Code (Finder, terminal) appear in the tree within about a second.
- **Add menu**: Class, Interface, Folder, New Item… (built-in templates plus every item template from `dotnet new`), Existing Item…, New/Existing Project…, Project Reference…, NuGet Package…, New Solution Folder.
- **File operations**: Rename, Delete (to the Trash, with confirmation), Copy/Paste, drag and drop inside a project, Copy Path, Reveal in Finder, Open in Terminal.
- **Project menu**: Build, Rebuild, Clean, Run, Debug, Set as Startup Project, Remove from Solution, Rename Project, Manage NuGet Packages…, Manage User Secrets.
- **Solution menu**: Build/Rebuild/Clean Solution, Manage NuGet Packages for Solution…

Everything goes through the `dotnet` CLI (`dotnet new`, `dotnet sln add/remove`, `dotnet add/remove reference`, `dotnet user-secrets`, `dotnet build/run`). Visible names and namespaces follow Visual Studio rules (`2Customer` becomes `_2Customer`), and an existing file is never overwritten.

### Debug and forks

**Debug** needs the C# extension (`ms-dotnettools.csharp`) for its `coreclr` debugger; if it is missing you get a warning with an install button. **Run** works without it. In forks such as VSCodium or Cursor the Microsoft debugger may not be available: Debug then explains this, and Run still works.

### The solution-folder exception

Everything above uses the CLI and never edits `.sln`, `.slnx` or `.csproj` text by hand, with two exceptions: solution folders (this section) and the Properties editor (see below). For solution folders: `dotnet sln` cannot create, rename or remove an empty solution folder, so for those three actions the extension edits the solution file directly. The edit is written only for folders, keeps every other byte of the file (BOM, line endings, GUIDs, unknown sections), and is validated with `dotnet sln list`. A backup of the original is kept until the result is validated; if validation fails, the original is restored and the error is shown.

## Project Properties

Right-click a project in the Solution Explorer and choose **Properties** (or run **C# Workbench: Project Properties** from the Command Palette) for a Visual Studio-style page with Application, Build, Package, Assembly and Debug sections. Values are the ones MSBuild evaluates (`dotnet msbuild -getProperty`), so properties that come from `Directory.Build.props` show as **inherited**; editing one creates an override in the `.csproj`, and **Reset** removes it again.

- Choosing more than one Target framework swaps `TargetFramework` for `TargetFrameworks` in a single write.
- Properties defined with a `Condition` (or per configuration) are shown read-only, with an **Open in .csproj** link.
- Duplicated properties are flagged; the last occurrence is the one edited.
- If the project cannot be evaluated, the page opens read-only with the error.
- Known limitation: when the target framework list contains an MSBuild expression such as `$(ExtraTfms)`, changing frameworks from the page fails validation and the file is restored; edit that list by hand in the `.csproj`.

### The `.csproj` property editor exception

The `dotnet` CLI cannot change MSBuild properties, so this is the second place (after solution folders) where the extension edits a project file by hand. It lives in one dedicated module with these safety rules:

- It only touches property elements inside **unconditional** `PropertyGroup`s of the project's own `.csproj`: it changes an existing element's text, adds one to the first unconditional group (same indentation), or removes one (Reset).
- Everything else is preserved byte for byte: formatting, comments, BOM, line endings, attributes and order. `&`, `<` and `>` in values are escaped.
- The write is atomic, keeps a `.cw-bak` backup until validation passes, follows symlinks, and refuses read-only files and files that changed on disk.
- After writing, `dotnet msbuild -getProperty` (with restore) must evaluate each edited property to the requested value (or, for Reset, no longer take it from the `.csproj`). If it does not, the original is restored and the error is shown.

## Launch Profiles

The Debug section of the Properties page edits `Properties/launchSettings.json`: create, duplicate, rename and delete profiles, and edit command line arguments, working directory, application URL, launch browser and URL, executable path and environment variables. The file is edited with minimal changes (`jsonc-parser`), so comments and formatting are kept, and written atomically. It is created when you add the first profile.

- **Set as active** chooses the profile used by Run and Debug. Run passes `--launch-profile <name>`; Debug starts with the profile's environment variables, arguments, working directory and URL, and opens the browser at the application URL when the profile asks for it. Executable profiles run the configured executable.
- `%VAR%` and `$VAR` in environment variables are expanded for Debug as `dotnet run` does.

## Sync Namespaces

After moving files between folders, run **Sync Namespaces** from a project or the solution. It computes the namespace each file should have (from the project's evaluated root namespace, including one set in `Directory.Build.props`, and the folder, Visual Studio rules) and shows the changes in VS Code's refactor preview: namespace declarations, `using` directives and qualified names that refer to moved types. Undo and open files with unsaved changes are handled by VS Code. Files under `bin/` and `obj/` never take part.

Sync skips, and lists in the "C# Workbench" Output channel, files that contain `#if`, declare multiple or nested namespaces, or whose type references are ambiguous. Generated files (`*.g.cs`, `*.Designer.cs`, `<auto-generated>`) are listed as skipped too: their namespace declarations are never changed, but their namespaces still count as existing and their `using` directives and qualified names are updated. A partial type is never split: when one of its files keeps its namespace (for example an EF Core migration's `.Designer.cs`), or its halves sit in folders with different namespaces, none of its files is moved. If a project's root namespace cannot be evaluated, its namespace declarations are left unchanged and only its references are updated.

## Usage

- **NuGet**: right-click a `.sln`, `.slnx` or `.csproj` file in the Explorer and choose **Manage NuGet Packages…**, or run **C# Workbench: Manage NuGet Packages…** from the Command Palette.
- **Solution Explorer**: click the C# Workbench icon in the activity bar. If the folder has several solutions, pick one from the view title.
- **Properties, launch profiles and Sync Namespaces**: right-click a project in the Solution Explorer.

## Requirements

- .NET SDK 8.0 or later. `.slnx` solutions need SDK 9.0.200 or later.
- `dotnet` is looked up in the `csharpWorkbench.dotnetPath` setting, then `PATH`, then `/usr/local/share/dotnet`, `/usr/share/dotnet`, `~/.dotnet` and `/opt/homebrew/bin`.

## Settings

- `csharpWorkbench.dotnetPath`: absolute path to the `dotnet` executable. Leave empty to auto-detect.

## Limitations

- No interactive login: feeds that need a browser or credential-provider sign-in are not supported.
- No `packages.config` projects (non-SDK-style .NET Framework).
- Encrypted passwords in `nuget.config` are not supported (clear-text only).
- No new `VersionOverride` entries are created under Central Package Management.
- Properties set per configuration (under a `Condition`) are read-only; edit them in the `.csproj`.
- Sync Namespaces skips files with `#if`, files with multiple or nested namespaces, and ambiguous types, and lists them in the Output channel. Generated files never get a namespace declaration change (their references are still updated).
- Launch profiles for IIS, IIS Express and Docker are shown but not supported.
- No `.resx` editor yet.

## Development

```sh
npm install
npm run build
npm run test:unit
npm run test:cli
npm run test:int
```

The test scripts mirror the repository to a temporary directory when its path contains `#`, which breaks some tooling.

## License

MIT
