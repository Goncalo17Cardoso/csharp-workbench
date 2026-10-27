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

## Usage

Right-click a `.sln`, `.slnx` or `.csproj` file in the Explorer and choose **Manage NuGet Packages…**, or run **C# Workbench: Manage NuGet Packages…** from the Command Palette.

## Requirements

- .NET SDK 8.0 or later. `.slnx` solutions need SDK 9.0.200 or later.
- `dotnet` is looked up in the `csharpWorkbench.dotnetPath` setting, then `PATH`, then `/usr/local/share/dotnet`, `/usr/share/dotnet`, `~/.dotnet` and `/opt/homebrew/bin`.

## Settings

- `csharpWorkbench.dotnetPath`: absolute path to the `dotnet` executable. Leave empty to auto-detect.

## Limitations (v1)

- No interactive login: feeds that need a browser or credential-provider sign-in are not supported.
- No `packages.config` projects (non-SDK-style .NET Framework).
- Encrypted passwords in `nuget.config` are not supported (clear-text only).
- No new `VersionOverride` entries are created under Central Package Management.

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
