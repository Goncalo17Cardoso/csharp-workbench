# Changelog

## 0.3.0

- Project Properties page (Application, Build, Package, Assembly, Debug): evaluated values, inherited vs. set in the `.csproj`, Reset, multi-target frameworks, read-only conditional properties.
- Launch Profiles: create, duplicate, rename, delete and edit `launchSettings.json` profiles (comments preserved); the active profile drives Run (`--launch-profile`) and Debug.
- Sync Namespaces with a refactor preview of declarations, `using` directives and qualified names, from the evaluated root namespace; files with `#if`, multiple or nested namespaces and ambiguous types are skipped and listed; generated files keep their namespace declarations (listed as skipped) but still count as declared and get their references updated; `bin/` and `obj/` are excluded.
- The `.csproj` property editor is the second hand edit of project files: unconditional PropertyGroups only, byte-preserving, atomic with a `.cw-bak` backup, validated with `dotnet msbuild`.
- Fix: the extension bundle now uses the ESM build of `jsonc-parser`.

## 0.2.0

- Solution Explorer view: solution folders, projects, folders and files with Visual Studio-style file nesting, Dependencies (Packages, Projects, Frameworks) and a Show All Files toggle.
- Add Class/Interface/Folder/New Item (built-in and `dotnet new` item templates), Existing Item, New/Existing Project, Project Reference.
- Rename, Delete (Trash), Copy/Paste and drag and drop for files and folders; Rename and Remove from Solution for projects.
- Build, Rebuild, Clean, Run, Debug and startup project selection.
- Manage User Secrets; Manage NuGet Packages opens the v1 manager with the project preselected.
- New, Rename and Remove for solution folders, edited directly in the solution file and validated with `dotnet sln list` (the only hand edit of solution files).
- Live refresh when files change on disk.

## 0.1.0

- Initial release: NuGet manager with Browse, Installed, Updates and Consolidate tabs.
- Central Package Management (`Directory.Packages.props`) support.
- Package sources from `nuget.config` (v3, v2, local folders, credentials in config).
- Right-click `.sln`, `.slnx` and `.csproj` files and choose "Manage NuGet Packages…".
