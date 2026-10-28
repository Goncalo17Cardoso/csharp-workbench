# C# Workbench

A Visual Studio-style NuGet package manager for .NET solutions and projects in VS Code, for macOS and Linux. It works without C# Dev Kit.

<!-- TODO: add screenshot of the NuGet panel (media/screenshot.png) before publishing -->

## Features

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

Everything above uses the CLI and never edits `.sln`, `.slnx` or `.csproj` text by hand, with one exception: solution folders. `dotnet sln` cannot create, rename or remove an empty solution folder, so for those three actions the extension edits the solution file directly. The edit is written only for folders, keeps every other byte of the file (BOM, line endings, GUIDs, unknown sections), and is validated with `dotnet sln list`. A backup of the original is kept until the result is validated; if validation fails, the original is restored and the error is shown.

## Usage

Right-click a `.sln`, `.slnx` or `.csproj` file in the Explorer and choose **Manage NuGet Packages…**, or run **C# Workbench: Manage NuGet Packages…** from the Command Palette.

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
- No Project Properties UI, launch profiles (`launchSettings.json`), Sync Namespaces or `.resx` editor yet.

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
