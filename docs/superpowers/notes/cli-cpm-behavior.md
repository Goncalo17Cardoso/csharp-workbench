# dotnet CLI behavior with Central Package Management

Observed with SDK 10.0.102 (macOS), `Newtonsoft.Json` 13.0.1 / 13.0.3, projects `net8.0`, fixture dir `.../My App #1`.
Verified by `npm run test:cli` (test/integration/cli-cpm.int.test.ts). All 5 cases confirm the expected behavior.

| Case | Result |
|---|---|
| cpm: `dotnet add package X --version 13.0.1` | csproj gets `<PackageReference Include="Newtonsoft.Json" />` (no Version, no VersionOverride); props gets `<PackageVersion Include="Newtonsoft.Json" Version="13.0.1" />` |
| cpm: add 13.0.3 on project already referencing 13.0.1 | props `Version` becomes `13.0.3`; csproj reference unchanged, no VersionOverride created |
| cpm: `dotnet remove package` | csproj reference removed; `PackageVersion` stays in Directory.Packages.props (13.0.1) |
| cpm: csproj has `VersionOverride="13.0.1"`, remove then add 13.0.3 | override is gone after remove; re-add gives plain `<PackageReference Include="Newtonsoft.Json" />` and props 13.0.3 (no duplicate PackageVersion) |
| non-cpm: add to two projects, `dotnet list <sln> package --format json` | both projects listed, requested 13.0.1 and 13.0.3 |

Files observed after first add (cpm): `Directory.Packages.props` from `dotnet new packagesprops` has `ManagePackageVersionsCentrally=true`, an empty `<ItemGroup>`, and a new `<ItemGroup>` with the `PackageVersion` line. Note the add output logs "added to file .../Directory.Packages.props".

Notes
- The VersionOverride starting state cannot be produced by the CLI; the test writes it into the csproj as setup only (the behavior under test is remove/add).
- `dotnet new sln --format sln` is SDK 9+/10 only (SDK 10 defaults to .slnx). SDK 8.0.417 rejects `--format`; the fixture falls back to plain `dotnet new sln`.
- SDK 8.0.417 (via global.json in the temp parent): the non-cpm case passes; the 4 cpm cases cannot run because SDK 8 has no `packagesprops` template (fixture limitation, not a CLI CPM finding). CPM behavior on 8 is unverified.
