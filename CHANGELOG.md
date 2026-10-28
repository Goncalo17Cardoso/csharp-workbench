# Changelog

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
