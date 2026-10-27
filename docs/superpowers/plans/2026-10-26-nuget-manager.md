# C# Workbench — Gestor de NuGet (v1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extensão VS Code "C# Workbench" com um gestor de pacotes NuGet gráfico (Browse / Installed / Updates / Consolidate + painel de detalhe), equivalente ao do Visual Studio, para macOS/Linux.

**Architecture:** O processo da extensão (Node) faz todo o trabalho: localiza o `dotnet`, descobre soluções/projetos, resolve `nuget.config`, fala com as fontes NuGet por HTTP/disco e altera projetos **apenas** via `dotnet` CLI. Uma Webview por solução só desenha e envia intenções por mensagens tipadas. Módulos de domínio são puros (sem `vscode`) e testados com vitest; a camada `vscode` é fina e testada com integração.

**Tech Stack:** TypeScript 5, Node 22 (dev), esbuild (bundle extensão + webview), vitest + happy-dom (unit), `@vscode/test-cli` + `@vscode/test-electron` (integração), `fast-xml-parser` (só leitura de XML), `fflate` (ler `.nuspec` de `.nupkg`), `marked` (README), `@vscode/vsce` e `ovsx` (packaging).

**Spec:** `docs/superpowers/specs/2026-10-26-nuget-manager-design.md`

## Global Constraints

- Nome "C# Workbench"; id da extensão `csharp-workbench`; prefixo de comandos/settings `csharpWorkbench.`.
- **Nunca escrever XML de projeto/props/nuget.config à mão.** Toda a alteração a `.csproj` / `Directory.Packages.props` passa por `dotnet add package` / `dotnet remove package`. XML só é *lido*.
- **Sem dependência do C# Dev Kit**: `package.json` não tem `extensionDependencies`.
- `@vscode/webview-ui-toolkit` proibido (descontinuado). Webview usa só variáveis CSS `--vscode-*` para cores.
- SDK mínimo .NET 8.0; `.slnx` requer 9.0.200+ (mensagem clara se SDK inferior e alvo `.slnx`).
- Procura do `dotnet`: setting `csharpWorkbench.dotnetPath` → PATH → `/usr/local/share/dotnet`, `/usr/share/dotnet`, `~/.dotnet`, `/opt/homebrew/bin`.
- Sem `dotnet`: mensagem de erro com botão que abre `https://dotnet.microsoft.com/download`.
- Processos sempre com `execFile` (argumentos em array, sem shell).
- Strings visíveis em inglês via `vscode.l10n.t` (host) e `package.nls.json` (contributes).
- Plataformas-alvo: macOS e Linux. Não usar APIs exclusivas de Windows.
- Todo o output de `dotnet` vai para o Output channel "C# Workbench".
- Commits seguem Conventional Commits.

## Review Focus

1. **Caminhos com espaços e `#`** (a pasta do próprio utilizador é `C# Workbench`): todas as chamadas a `dotnet` e leituras de ficheiros funcionam. → teste em Task 1 e fixture de integração em Task 13 dentro de pasta `My App #1`.
2. **IDs com capitalização diferente** (`serilog` na pesquisa vs `Serilog` no `.csproj`): tratados como o mesmo pacote em todas as vistas. → testes em Tasks 6 e 9.
3. **Ordem de versões NuGet**: 4 partes (`1.0.0.1`), prerelease (`2.0.0-beta.10` > `2.0.0-beta.9` < `2.0.0`), metadata `+abc` ignorada. → testes em Task 4.
4. **Uma fonte falha (401/timeout/offline)** em "All": as outras continuam a dar resultados e a fonte falhada é sinalizada. → testes em Task 6.
5. **`dotnet` falha a meio de uma operação** (rede, source mapping, versão inexistente): UI sai do estado "busy", mostra a mensagem e oferece abrir o Output. → testes em Tasks 8 e 10.

---

## Estrutura de ficheiros

```
package.json, package.nls.json, tsconfig.json, esbuild.mjs, vitest.config.ts, .vscode-test.mjs
.gitignore (.superpowers/, node_modules/, dist/, out/, *.vsix)
src/
  extension.ts              activate: comandos, menus, PanelManager
  output.ts                 Output channel + log(cmd, result)
  core/types.ts             tipos partilhados (abaixo)
  core/version.ts           comparação de versões NuGet
  dotnet/locate.ts          findDotnet
  dotnet/exec.ts            Exec (execFile wrapper) + DotnetError
  dotnet/cli.ts             DotnetCli (sln list, list package, add, remove, restore, config paths, --version)
  dotnet/parse.ts           parsers puros do output do CLI
  workspace/targets.ts      selectTargets (sln/slnx/csproj)
  workspace/projectFiles.ts leitura rápida de PackageReference + CPM
  nuget/config.ts           parse/merge nuget.config, credenciais, mappings
  nuget/http.ts             HttpGet com Basic auth
  nuget/feeds/types.ts      FeedClient
  nuget/feeds/v3.ts | v2.ts | local.ts
  nuget/feeds/index.ts      createFeedClient
  nuget/aggregate.ts        searchAll / versionsAll / detailsFirst
  ops/operations.ts         planOperation / executePlan
  state/viewModel.ts        linhas Installed / Updates / Consolidate
  panel/protocol.ts         mensagens host↔webview (partilhado com webview)
  panel/NugetPanel.ts       um WebviewPanel por Target
  panel/PanelManager.ts     abre/reutiliza painéis, watchers
  webview/main.ts           bootstrap + estado da UI
  webview/views/browse.ts | installed.ts | updates.ts | consolidate.ts | details.ts
  webview/styles.css
test/unit/**.test.ts, test/fixtures/**, test/integration/**.test.ts
```

### Tipos partilhados (`src/core/types.ts`, criados na Task 1, estendidos onde indicado)

```ts
export type TargetKind = 'sln' | 'slnx' | 'csproj';
export interface Target { kind: TargetKind; path: string; name: string }
export interface ProjectInfo { path: string; name: string }
export interface PackageRef {
  id: string; requested?: string; resolved?: string; latest?: string;
  framework?: string; versionOverride?: string;
}
export interface ProjectPackages { project: ProjectInfo; packages: PackageRef[] }
export interface CpmInfo { propsPath: string; versions: Map<string, string> } // chave = id em minúsculas
export interface SolutionState { target: Target; projects: ProjectPackages[]; cpm?: CpmInfo }
export type SourceKind = 'v3' | 'v2' | 'local';
export interface PackageSource {
  name: string; url: string; kind: SourceKind;
  credential?: { username: string; password: string }; warning?: string;
}
export interface SearchResult {
  id: string; description: string; latestVersion: string;
  totalDownloads?: number; iconUrl?: string; sources: string[];
}
export interface PackageDetails {
  id: string; version: string; description: string; authors?: string;
  license?: string; licenseUrl?: string; projectUrl?: string; readme?: string;
  dependencies: { framework: string; packages: { id: string; range: string }[] }[];
  deprecation?: { reasons: string[]; message?: string; alternate?: string };
  vulnerabilities?: { severity: string; advisoryUrl: string }[];
}
```

---

### Task 1: Scaffold, execução de processos e localização do `dotnet`

**Files:**
- Create: `package.json`, `tsconfig.json`, `esbuild.mjs`, `vitest.config.ts`, `.gitignore`, `src/core/types.ts`, `src/dotnet/exec.ts`, `src/dotnet/locate.ts`, `src/output.ts`, `src/extension.ts` (activate vazio)
- Test: `test/unit/dotnet/locate.test.ts`, `test/unit/dotnet/exec.test.ts`

**Interfaces:**
- Produces:
  - `type Exec = (file: string, args: string[], opts: { cwd: string; timeoutMs?: number }) => Promise<ExecResult>`; `interface ExecResult { code: number; stdout: string; stderr: string }`; `const nodeExec: Exec` (usa `child_process.execFile`, nunca rejeita por exit code ≠ 0).
  - `class DotnetError extends Error { args: string[]; code: number; stdout: string; stderr: string }`
  - `findDotnet(deps: { configuredPath?: string; pathEnv: string; home: string; exists(p: string): Promise<boolean> }): Promise<string | undefined>`
  - `createOutput(channel: { appendLine(s: string): void }): { log(args: string[], r: ExecResult): void; info(s: string): void }`

- [ ] **Step 1:** `git init`; criar `package.json` (`name: "csharp-workbench"`, `displayName: "C# Workbench"`, `engines.vscode: "^1.95.0"`, `main: "./dist/extension.js"`, scripts `build`, `watch`, `test:unit` = `vitest run`, `test:int` = `vscode-test`), instalar dev deps da Tech Stack, `.gitignore` com as entradas da estrutura.
- [ ] **Step 2: Testes que falham** — `locate.test.ts`:
  - `prefers configured path when it exists` → `configuredPath: '/x/dotnet'` existe ⇒ `'/x/dotnet'`.
  - `falls back to PATH entries in order` → `pathEnv: '/a:/b'`, só `/b/dotnet` existe ⇒ `'/b/dotnet'`.
  - `checks well-known locations after PATH` → nada no PATH, `/usr/local/share/dotnet/dotnet` existe ⇒ esse; ordem testada com `~/.dotnet/dotnet` (expandido com `home`) também existente ⇒ continua `/usr/local/share/dotnet/dotnet`.
  - `ignores configured path that does not exist` e `returns undefined when nothing found`.
  - `exec.test.ts`: `passes args with spaces and # verbatim` → `nodeExec(process.execPath, ['-e','console.log(process.argv[1])','My App #1'], {cwd})` ⇒ `stdout.trim() === 'My App #1'`; `returns non-zero code without throwing`.
- [ ] **Step 3:** Correr `npx vitest run test/unit/dotnet` → FAIL (módulos inexistentes).
- [ ] **Step 4:** Implementar `exec.ts`, `locate.ts`, `output.ts`, `types.ts`.
- [ ] **Step 5:** `npx vitest run test/unit/dotnet` → PASS; `npm run build` → gera `dist/extension.js` sem erros.
- [ ] **Step 6:** Commit `chore: scaffold extension with dotnet locator`.

---

### Task 2: Wrappers do `dotnet` CLI e parsers

**Files:**
- Create: `src/dotnet/cli.ts`, `src/dotnet/parse.ts`
- Test: `test/unit/dotnet/parse.test.ts`, `test/unit/dotnet/cli.test.ts`, fixtures `test/fixtures/cli/list-package.json`, `list-package-outdated.json`, `list-package-multitarget.json`, `sln-list.txt`

**Interfaces:**
- Consumes: `Exec`, `DotnetError`, tipos de `core/types.ts`.
- Produces:
  - `parseSlnList(stdout: string, slnDir: string): ProjectInfo[]` (salta as 2 linhas de cabeçalho; caminhos absolutos; `name` = nome do ficheiro sem `.csproj`).
  - `parseListPackageJson(json: string): ProjectPackages[]` — lê `projects[].frameworks[].topLevelPackages[]` (`id`, `requestedVersion`, `resolvedVersion`, `latestVersion`); um `PackageRef` por (pacote, framework).
  - `parseSdkVersion(stdout: string): string`
  - `class DotnetCli { constructor(exec: Exec, dotnetPath: string, out: Output)`; `sdkVersion(): Promise<string>`; `slnList(slnPath): Promise<ProjectInfo[]>`; `listPackages(targetPath, opts?: { outdated?: boolean; prerelease?: boolean }): Promise<ProjectPackages[]>`; `addPackage(projectPath, id, version): Promise<void>`; `removePackage(projectPath, id): Promise<void>`; `restore(targetPath): Promise<void>`; `configPaths(dir): Promise<string[]> }`
  - Comandos exatos: `sln <p> list`; `list <p> package --format json [--outdated] [--include-prerelease]`; `add <proj> package <id> --version <v>`; `remove <proj> package <id>`; `restore <p>`; `nuget config paths --working-directory <dir>`; `--version`. `cwd` = diretório do alvo. Exit ≠ 0 ⇒ `throw new DotnetError(...)`. Toda a chamada é registada com `out.log`.

- [ ] **Step 1: Testes que falham** — `parse.test.ts`:
  - `parses sln list into absolute project paths` (fixture com `src/My App #1/App.csproj` ⇒ path absoluto correto, `name === 'App'`).
  - `parses list package json` ⇒ projeto `Api` tem `{ id:'Serilog', requested:'4.2.0', resolved:'4.2.0' }`.
  - `parses outdated latestVersion` ⇒ `latest === '7.2.0'`.
  - `multi-target project yields one ref per framework` ⇒ 2 refs `Newtonsoft.Json` com `framework` `net8.0` e `net9.0` e versões diferentes.
  - `cli.test.ts` com `Exec` falso: `addPackage builds exact args` ⇒ `['add','/p/A.csproj','package','Serilog','--version','4.2.0']`; `throws DotnetError with stderr on non-zero exit`; `every call is logged`.
- [ ] **Step 2:** `npx vitest run test/unit/dotnet` → FAIL.
- [ ] **Step 3:** Implementar `parse.ts` e `cli.ts`.
- [ ] **Step 4:** `npx vitest run test/unit/dotnet` → PASS.
- [ ] **Step 5:** Commit `feat: dotnet cli wrappers and parsers`.

---

### Task 3: Alvos (sln/slnx/csproj) e leitura rápida de projetos + CPM

**Files:**
- Create: `src/workspace/targets.ts`, `src/workspace/projectFiles.ts`
- Test: `test/unit/workspace/targets.test.ts`, `test/unit/workspace/projectFiles.test.ts`, fixtures `test/fixtures/projects/*.csproj`, `Directory.Packages.props`

**Interfaces:**
- Consumes: `Target`, `PackageRef`, `CpmInfo`.
- Produces:
  - `selectTargets(files: string[]): Target[]` — entrada: caminhos de `.sln/.slnx/.csproj` encontrados (sem `bin/`, `obj/`, `node_modules/`). Devolve todas as `.sln`/`.slnx`, ordenadas por profundidade e depois por nome; se não houver nenhuma, devolve cada `.csproj` como alvo.
  - `readPackageRefs(csprojXml: string): PackageRef[]` — `<PackageReference Include Version? VersionOverride?>` (atributo ou elemento filho).
  - `findCentralPackagesFile(projectDir: string, exists: (p: string) => Promise<boolean>, stopAt: string): Promise<string | undefined>` — sobe diretórios até `stopAt`.
  - `readCpm(propsXml: string, propsPath: string): CpmInfo | undefined` — só se `ManagePackageVersionsCentrally` for `true`; chaves em minúsculas.

- [ ] **Step 1: Testes que falham**:
  - `returns solutions before standalone projects` ⇒ `['/r/a.csproj','/r/A.sln']` ⇒ só `A.sln` (`kind:'sln'`).
  - `supports slnx` e `falls back to csproj targets when no solution`.
  - `orders nested solutions after root ones`.
  - `reads Version as attribute and as child element`; `reads VersionOverride`; `PackageReference without version under CPM has requested undefined`.
  - `finds Directory.Packages.props walking up`; `ignores props without ManagePackageVersionsCentrally=true`; `cpm keys are case-insensitive` ⇒ `versions.get('serilog')` com `Include="Serilog"`.
- [ ] **Step 2:** `npx vitest run test/unit/workspace` → FAIL.
- [ ] **Step 3:** Implementar com `fast-xml-parser` (`ignoreAttributes:false`).
- [ ] **Step 4:** `npx vitest run test/unit/workspace` → PASS.
- [ ] **Step 5:** Commit `feat: target discovery and fast project reading`.

---

### Task 4: Versões NuGet, HTTP e cliente de feed v3

**Files:**
- Create: `src/core/version.ts`, `src/nuget/http.ts`, `src/nuget/feeds/types.ts`, `src/nuget/feeds/v3.ts`
- Test: `test/unit/core/version.test.ts`, `test/unit/nuget/v3.test.ts`, fixtures `test/fixtures/v3/index.json`, `search-serilog.json`, `flat-versions.json`, `registration-page.json`, `readme.md`

**Interfaces:**
- Consumes: `PackageSource`, `SearchResult`, `PackageDetails`.
- Produces:
  - `compareVersions(a: string, b: string): number`; `isPrerelease(v: string): boolean`; `maxVersion(vs: string[]): string | undefined`.
  - `type HttpGet = (url: string) => Promise<{ status: number; body: Uint8Array }>`; `createHttp(source: PackageSource, fetchImpl = fetch, timeoutMs = 15000): HttpGet` (Basic auth se `source.credential`).
  - `interface FeedClient { search(q: string, o: { prerelease: boolean; skip: number; take: number }): Promise<SearchResult[]>; versions(id: string, prerelease: boolean): Promise<string[]>; details(id: string, version: string): Promise<PackageDetails> }`
  - `class FeedError extends Error { source: string; status?: number }`
  - `createV3Client(source: PackageSource, http: HttpGet): FeedClient` — usa os recursos `SearchQueryService`, `RegistrationsBaseUrl/3.6.0` (ou o mais recente presente), `PackageBaseAddress/3.0.0`, `ReadmeUriTemplate/6.13.0` do service index (cacheado por cliente). Versões vêm do flat container (ids em minúsculas no URL). Detalhes, deprecation e vulnerabilities vêm do `catalogEntry` da registration (seguir páginas sem `items` inline). `iconUrl` = `{PackageBaseAddress}/{id}/{ver}/icon` quando o pacote tem ícone, senão `iconUrl` do search.

- [ ] **Step 1: Testes que falham** — `version.test.ts`:
  - `compareVersions('1.0.0.1','1.0.0') > 0`; `('2.0.0-beta.10','2.0.0-beta.9') > 0`; `('2.0.0-beta','2.0.0') < 0`; `('1.0.0+abc','1.0.0') === 0`; `('10.0.0','9.0.0') > 0`; `('1.0.0-Beta','1.0.0-beta') === 0`.
  - `v3.test.ts` com `HttpGet` falso a servir fixtures: `search maps id, description, version, downloads`; `versions excludes prerelease unless asked and sorts descending`; `details reads deprecation and vulnerabilities`; `details includes readme when template present`; `401 throws FeedError with status 401`; `adds basic auth header when credential set` (testar `createHttp` com `fetchImpl` falso ⇒ header `Authorization: Basic dTpw` para `u`/`p`).
- [ ] **Step 2:** `npx vitest run test/unit/core test/unit/nuget` → FAIL.
- [ ] **Step 3:** Implementar.
- [ ] **Step 4:** → PASS.
- [ ] **Step 5:** Commit `feat: nuget v3 feed client and version ordering`.

---

### Task 5: Clientes de feed v2 e pasta local

**Files:**
- Create: `src/nuget/feeds/v2.ts`, `src/nuget/feeds/local.ts`, `src/nuget/feeds/index.ts`
- Test: `test/unit/nuget/v2.test.ts`, `test/unit/nuget/local.test.ts`, fixtures `test/fixtures/v2/search.xml`, `findById.xml`, `test/fixtures/local/flat/Foo.1.0.0.nupkg`, `test/fixtures/local/hier/foo/2.0.0/foo.2.0.0.nupkg` (gerados por um script de fixture com `fflate`)

**Interfaces:**
- Consumes: `FeedClient`, `HttpGet`, `FeedError`, `compareVersions`.
- Produces:
  - `createV2Client(source, http): FeedClient` — OData: `Search()?searchTerm='q'&includePrerelease=..&$skip&$top`, `FindPackagesById()?id='x'`, `Packages(Id='x',Version='v')`. Sem README (campo vazio).
  - `createLocalClient(source, fs: { readdir; readFile }): FeedClient` — aceita layout plano (`*.nupkg`) e hierárquico (`id/version/*.nupkg`); lê `.nuspec` de dentro do zip; `search` filtra por substring case-insensitive em id e descrição; `totalDownloads` indefinido.
  - `createFeedClient(source: PackageSource, deps: { http: HttpGet; fs }): FeedClient` — escolhe pelo `source.kind`.

- [ ] **Step 1: Testes que falham**: `v2 search parses atom entries`; `v2 versions from FindPackagesById`; `local search finds by description case-insensitively`; `local supports flat and hierarchical layouts`; `local details read nuspec dependencies per framework`; `factory picks client by kind`.
- [ ] **Step 2:** `npx vitest run test/unit/nuget` → FAIL.
- [ ] **Step 3:** Implementar (`fast-xml-parser` para Atom e nuspec, `fflate.unzipSync` para `.nupkg`).
- [ ] **Step 4:** → PASS.
- [ ] **Step 5:** Commit `feat: v2 and local folder feed clients`.

---

### Task 6: `nuget.config` efetivo e agregação entre fontes

**Files:**
- Create: `src/nuget/config.ts`, `src/nuget/aggregate.ts`
- Test: `test/unit/nuget/config.test.ts`, `test/unit/nuget/aggregate.test.ts`, fixtures `test/fixtures/config/{repo,user}/NuGet.Config`

**Interfaces:**
- Consumes: `PackageSource`, `FeedClient`, `FeedError`, `compareVersions`, `DotnetCli.configPaths`.
- Produces:
  - `parseNugetConfig(xml: string, filePath: string): ParsedConfig` — `packageSources` (`add`, `clear`, `protocolVersion`), `disabledPackageSources`, `packageSourceCredentials` (nomes com espaço codificados `_x0020_`; `Username`, `ClearTextPassword`, `Password`), `packageSourceMapping`. URLs relativas resolvidas contra o diretório do ficheiro.
  - `mergeConfigs(configs: ParsedConfig[] /* mais próximo primeiro */, env: Record<string, string | undefined>): EffectiveConfig` com `interface EffectiveConfig { sources: PackageSource[]; mappings: { pattern: string; sources: string[] }[] }`. Precedência: o ficheiro mais próximo ganha; `<clear/>` ignora fontes dos ficheiros mais afastados; fontes desativadas omitidas. `%VAR%` expandido em username e password. `Password` encriptada sem `ClearTextPassword` ⇒ sem credencial e `warning: 'Encrypted passwords are not supported on macOS/Linux. Use ClearTextPassword or an environment variable.'`. `kind`: caminho local/`file:` ⇒ `local`; `protocolVersion="3"` ou URL a terminar em `index.json` ⇒ `v3`; senão `v2`.
  - `loadEffectiveConfig(dir: string, cli: DotnetCli, readFile, env): Promise<EffectiveConfig>`
  - `searchAll(clients: { source: PackageSource; client: FeedClient }[], q: string, o): Promise<{ results: SearchResult[]; failures: { source: string; message: string }[] }>` — `Promise.allSettled`; junta por id em minúsculas; `latestVersion` = máximo; `sources` = união; mantém a ordem de relevância da primeira fonte que devolveu o id.
  - `versionsAll(clients, id, prerelease): Promise<string[]>` (união, desc) e `detailsFirst(clients, id, version): Promise<PackageDetails>` (primeira fonte que responde).

- [ ] **Step 1: Testes que falham**:
  - `closest config wins on same source name`; `clear drops sources from farther files`; `disabled sources are omitted`; `decodes _x0020_ in credential names`; `expands %NUGET_PAT% from env`; `encrypted password yields warning and no credential`; `detects v3, v2 and local kinds`; `resolves relative local paths against the config file dir`; `reads package source mappings`.
  - `aggregate.test.ts`: `merges same id with different casing from two sources` ⇒ 1 resultado, `sources.length === 2`; `failing source is reported but others still return results` (um cliente rejeita `FeedError` 401 ⇒ `failures[0].source` correto, `results` não vazio); `latestVersion is the max across sources`.
- [ ] **Step 2:** `npx vitest run test/unit/nuget` → FAIL.
- [ ] **Step 3:** Implementar.
- [ ] **Step 4:** → PASS.
- [ ] **Step 5:** Commit `feat: effective nuget.config and multi-source aggregation`.

---

### Task 7: Comportamento real do CLI com CPM (verificação de integração)

Objetivo: confirmar, contra o SDK real, as suposições de que a Task 8 depende. Sem isto a Task 8 pode escrever um plano de passos errado.

**Files:**
- Create: `test/integration/cli-cpm.int.test.ts` (vitest, corre fora do VS Code; `describe.skipIf(!dotnet)`), `test/integration/helpers/fixtures.ts` (`createFixtureSolution(dir, { cpm: boolean }): Promise<{ sln: string; projects: string[]; props?: string }>` usando `dotnet new sln/classlib` e, para CPM, `dotnet new packagesprops`), `docs/superpowers/notes/cli-cpm-behavior.md`

**Interfaces:**
- Consumes: `DotnetCli`, `readPackageRefs`, `readCpm`.
- Produces: `createFixtureSolution` (reutilizado na Task 13) e o ficheiro de notas com o comportamento observado.

- [ ] **Step 1:** Escrever testes que registam e afirmam o comportamento esperado, numa fixture dentro de uma pasta temporária `My App #1`:
  - `cpm: add to project creates PackageReference without Version and central PackageVersion`.
  - `cpm: add with different version to a project already referencing updates central version` (sem criar `VersionOverride`).
  - `cpm: remove package leaves PackageVersion in props`.
  - `cpm: remove then add on a project with VersionOverride drops the override`.
  - `non-cpm: add on two projects then list package --format json shows both`.
- [ ] **Step 2:** Correr `npx vitest run test/integration/cli-cpm.int.test.ts` com o .NET SDK instalado.
- [ ] **Step 3:** Registar em `docs/superpowers/notes/cli-cpm-behavior.md` o SDK usado (`dotnet --version`) e o resultado de cada caso. Se um caso não se confirmar, **parar e reportar** antes da Task 8, com o comportamento real. Não contornar editando XML.
- [ ] **Step 4:** Commit `test: verify dotnet cli behavior with central package management`.

---

### Task 8: Camada de operações (planear + executar)

**Files:**
- Create: `src/ops/operations.ts`
- Test: `test/unit/ops/operations.test.ts`

**Interfaces:**
- Consumes: `SolutionState`, `DotnetCli`, `DotnetError`, `compareVersions`.
- Produces:
  ```ts
  type OperationKind = 'install' | 'update' | 'uninstall' | 'consolidate';
  interface OperationRequest { kind: OperationKind; packageId: string; version?: string; projects: string[] }
  type CliStep = { op: 'add'; project: string; id: string; version: string } | { op: 'remove'; project: string; id: string };
  interface OperationPlan { steps: CliStep[]; affectsAllProjects: string[]; summary: string }
  interface OperationResult { ok: boolean; completed: number; error?: { message: string; stderr: string } }
  planOperation(req: OperationRequest, state: SolutionState): OperationPlan
  executePlan(plan: OperationPlan, cli: DotnetCli, onProgress: (done: number, total: number) => void): Promise<OperationResult>
  ```
  Regras (spec 8a):
  - **Sem CPM:** install/update ⇒ um `add` por projeto marcado; uninstall ⇒ um `remove` por projeto marcado; consolidate ⇒ `add` só nos projetos com versão ≠ alvo.
  - **Com CPM:** install ⇒ `add` por projeto marcado. Se a versão central existe e é diferente, `affectsAllProjects` = todos os projetos que referenciam o pacote. Update ⇒ um único `add` num projeto que referencia o pacote; `affectsAllProjects` = todos os que o referenciam. Consolidate ⇒ em cada projeto com `versionOverride`, `remove` + `add`, mais um `add` para alinhar a central se for preciso. Uninstall ⇒ `remove` por projeto.
  - `summary`: uma linha em inglês, ex. `Update Serilog to 4.2.0 in 3 projects (central version)`.
  - `executePlan` para no primeiro erro, devolve `ok:false`, `completed` e a mensagem/stderr do `DotnetError`. Não relança.

- [ ] **Step 1: Testes que falham** (estado construído à mão):
  - `install without cpm adds to each selected project`.
  - `update with cpm issues a single add and lists all referencing projects as affected`.
  - `install with cpm and different central version marks all referencing projects affected`.
  - `consolidate without cpm only touches projects on other versions`.
  - `consolidate with cpm removes and re-adds projects with VersionOverride`.
  - `uninstall removes from selected projects only`.
  - `package id match is case-insensitive` (`req.packageId:'serilog'` com refs `Serilog`).
  - `executePlan stops at first failure and returns stderr` (CLI falso falha no 2.º passo ⇒ `{ ok:false, completed:1 }`, `error.stderr` preenchido, `onProgress` chamado 1×).
- [ ] **Step 2:** `npx vitest run test/unit/ops` → FAIL.
- [ ] **Step 3:** Implementar de acordo com o que a Task 7 confirmou.
- [ ] **Step 4:** → PASS.
- [ ] **Step 5:** Commit `feat: plan and execute package operations with cpm awareness`.

---

### Task 9: View model (Installed / Updates / Consolidate)

**Files:**
- Create: `src/state/viewModel.ts`, `src/state/loadState.ts`
- Test: `test/unit/state/viewModel.test.ts`, `test/unit/state/loadState.test.ts`

**Interfaces:**
- Consumes: `SolutionState`, `ProjectPackages`, `compareVersions`, `readPackageRefs`, `findCentralPackagesFile`, `readCpm`, `DotnetCli`.
- Produces:
  ```ts
  interface InstalledRow { id: string; versions: Record<string /*projectPath*/, string>; central?: string; overrides: string[] }
  interface UpdateRow { id: string; current: string[]; latest: string; projects: string[] }
  interface ConsolidateRow { id: string; versions: Record<string, string>; target: string }
  buildInstalledRows(state: SolutionState): InstalledRow[]
  buildUpdateRows(outdated: ProjectPackages[]): UpdateRow[]
  buildConsolidateRows(state: SolutionState): ConsolidateRow[]
  loadFastState(target: Target, projects: ProjectInfo[], fs): Promise<SolutionState>  // só ficheiros
  loadConfirmedState(target: Target, fast: SolutionState, cli: DotnetCli): Promise<SolutionState> // restore se faltar obj/project.assets.json, depois list package
  ```
  Linhas ordenadas por id (case-insensitive). Num projeto multi-target com versões diferentes, `versions[project]` = versões únicas juntas por `, `. `ConsolidateRow.target` = maior versão em uso. Sob CPM, só entram em Consolidate os pacotes com `overrides.length > 0`.

- [ ] **Step 1: Testes que falham**: `groups same id across projects case-insensitively`; `multi-target shows joined distinct versions`; `updates merge projects and pick latest`; `consolidate lists only packages with differing versions`; `consolidate under cpm lists only overrides`; `loadConfirmedState runs restore only when project.assets.json missing` (CLI e fs falsos).
- [ ] **Step 2:** `npx vitest run test/unit/state` → FAIL.
- [ ] **Step 3:** Implementar.
- [ ] **Step 4:** → PASS.
- [ ] **Step 5:** Commit `feat: view models for installed, updates and consolidate`.

---

### Task 10: Protocolo e painel (lado do host)

**Files:**
- Create: `src/panel/protocol.ts`, `src/panel/controller.ts` (lógica pura do painel), `src/panel/NugetPanel.ts` (cola `vscode`), `src/panel/PanelManager.ts`
- Test: `test/unit/panel/controller.test.ts`

**Interfaces:**
- Consumes: tudo o que vem das Tasks 2–9.
- Produces:
  ```ts
  // webview → host
  type ToHost =
    | { type: 'ready' }
    | { type: 'search'; query: string; prerelease: boolean; source: string /* 'All' | name */; skip: number }
    | { type: 'selectPackage'; id: string; prerelease: boolean; source: string }
    | { type: 'selectVersion'; id: string; version: string }
    | { type: 'run'; request: OperationRequest }
    | { type: 'switchTarget'; path: string }
    | { type: 'refresh' } | { type: 'openOutput' };
  // host → webview
  type ToWebview =
    | { type: 'init'; targets: Target[]; current: Target; projects: ProjectInfo[]; sources: { name: string; warning?: string }[]; preselectProject?: string }
    | { type: 'searchResults'; results: SearchResult[]; failures: { source: string; message: string }[]; append: boolean }
    | { type: 'installed'; rows: InstalledRow[]; confirmed: boolean }
    | { type: 'updates'; rows: UpdateRow[] }
    | { type: 'consolidate'; rows: ConsolidateRow[]; cpm: boolean }
    | { type: 'details'; details: PackageDetails; versions: string[]; perProject: Record<string, string | null> }
    | { type: 'busy'; label: string | null; progress?: { done: number; total: number } }
    | { type: 'opResult'; ok: boolean; message: string }
    | { type: 'error'; message: string; canOpenOutput: boolean };
  class PanelController {
    constructor(deps: { cli: DotnetCli; post(m: ToWebview): void; confirm(summary: string, affected: string[]): Promise<boolean>; feeds: (src: string) => { source: PackageSource; client: FeedClient }[]; openOutput(): void });
    handle(msg: ToHost): Promise<void>;
  }
  PanelManager.open(target: Target, opts?: { preselectProject?: string }): void   // reutiliza o painel do mesmo target.path
  ```
  Comportamento:
  - `ready` ⇒ `init`, depois `installed{confirmed:false}` (estado rápido), depois em paralelo `installed{confirmed:true}`, `updates` e `consolidate`.
  - `run` ⇒ `planOperation`, depois `confirm` (modal `showWarningMessage` com o `summary` e, se houver, a lista `affectsAllProjects`), depois `busy` com progresso, `executePlan` e `opResult`, e por fim um refresh completo. **Qualquer** erro termina com `busy{label:null}` seguido de `error`.
  - Se o `stderr` de uma operação falhada contiver `PackageSourceMapping`, a mensagem `error` acrescenta: `Package source mapping blocked this package. Add a mapping in <caminho do nuget.config mais próximo>.` O caminho é o primeiro de `DotnetCli.configPaths`.
  - Watcher de `**/*.csproj`, `**/Directory.Packages.props`, `**/[Nn]u[Gg]et.[Cc]onfig` com debounce de 500 ms ⇒ refresh. É ignorado enquanto há uma operação a correr.
  - Título do painel: `NuGet: <target.name>`. `retainContextWhenHidden: true`. CSP com nonce. `localResourceRoots` = `dist/webview`.

- [ ] **Step 1: Testes que falham** (`controller.test.ts`, deps falsas):
  - `ready posts init then unconfirmed installed then confirmed`.
  - `run asks confirmation with affected projects and aborts when declined` ⇒ nenhum passo CLI executado.
  - `failed operation clears busy and posts error with canOpenOutput` (ordem: `busy(label)` → `busy(null)` → `error`).
  - `search reports source failures alongside results`.
  - `source mapping failure names the nuget.config to fix`.
  - `restore failure on load posts error and keeps unconfirmed installed visible`.
- [ ] **Step 2:** `npx vitest run test/unit/panel` → FAIL.
- [ ] **Step 3:** Implementar `protocol.ts`, `controller.ts`; depois `NugetPanel.ts`/`PanelManager.ts` como cola fina, sem lógica testável.
- [ ] **Step 4:** → PASS; `npm run build` OK.
- [ ] **Step 5:** Commit `feat: nuget panel host and message protocol`.

---

### Task 11: Webview — estrutura, Browse e painel de detalhe

**Files:**
- Create: `src/webview/main.ts`, `src/webview/views/browse.ts`, `src/webview/views/details.ts`, `src/webview/styles.css`; modificar `esbuild.mjs` (segundo bundle `dist/webview/main.js` + css)
- Test: `test/unit/webview/browse.test.ts`, `test/unit/webview/details.test.ts` (`// @vitest-environment happy-dom`)

**Interfaces:**
- Consumes: `ToHost`, `ToWebview` (de `src/panel/protocol.ts`).
- Produces:
  - `renderShell(root: HTMLElement): ShellRefs`: barra com separadores `Browse | Installed | Updates (n) | Consolidate (n)`, seletor de solução, campo de pesquisa, checkbox "Include prerelease", seletor de fonte e áreas `list` / `detail`.
  - `renderSearchList(el: HTMLElement, results: SearchResult[], failures, onSelect: (id: string) => void): void` — ícone (com fallback), nome, descrição, downloads formatados (`1.9B`, `980M`), versão. Um aviso por cada fonte falhada.
  - `renderDetails(el, d: PackageDetails, versions: string[], perProject: Record<string, string | null>, projects: ProjectInfo[], send: (m: ToHost) => void): void` — checkbox por projeto (com `— not installed` ou a versão), dropdown de versões (`(latest)`, `(installed)`), botão contextual, README em HTML via `marked` sanitizado, dependências por framework, banners de deprecated/vulnerável.
  - `actionFor(selected: string[], perProject, version): 'Install' | 'Update' | 'Uninstall'` — regra: todos os marcados já têm o pacote e a versão escolhida é igual à instalada ⇒ `Uninstall`; algum marcado tem outra versão ⇒ `Update`; caso contrário ⇒ `Install`.
  - Pesquisa com debounce de 300 ms. Scroll infinito: `skip` += 20 e `append:true`. Estado da UI guardado com `acquireVsCodeApi().setState`.

- [ ] **Step 1: Testes que falham**:
  - `renders one row per result with formatted downloads`.
  - `shows a warning per failed source`.
  - `clicking a row calls onSelect with id`.
  - `actionFor returns Install / Update / Uninstall per rule` (3 casos).
  - `details checkboxes show installed version or not installed`.
  - `preselected project is checked`.
  - `readme script tags are stripped`.
- [ ] **Step 2:** `npx vitest run test/unit/webview` → FAIL.
- [ ] **Step 3:** Implementar. Cores só com `var(--vscode-*)`.
- [ ] **Step 4:** → PASS; `npm run build` gera `dist/webview/main.js`.
- [ ] **Step 5:** Commit `feat: webview shell, browse list and package details`.

---

### Task 12: Webview — Installed, Updates e Consolidate

**Files:**
- Create: `src/webview/views/installed.ts`, `src/webview/views/updates.ts`, `src/webview/views/consolidate.ts`; modificar `src/webview/main.ts`
- Test: `test/unit/webview/tabs.test.ts`

**Interfaces:**
- Consumes: `InstalledRow`, `UpdateRow`, `ConsolidateRow`, `renderDetails`, `ToHost`.
- Produces:
  - `renderInstalled(el, rows, filter: string, onSelect)` — mostra a versão (ou `central` com o rótulo `(central)`) e um indicador "confirming…" enquanto `confirmed:false`.
  - `renderUpdates(el, rows, filter, send)` — checkbox por linha, "Select all", botão `Update selected (n)`. Envia um `run{kind:'update'}` por pacote, em sequência (o host confirma cada um).
  - `renderConsolidate(el, rows, cpm, send)` — versões por projeto, dropdown com a versão alvo (por omissão `target`) e botão `Consolidate`. Se `cpm`, a nota diz `Removes VersionOverride from these projects`.
  - Os contadores dos separadores atualizam com `updates.rows.length` e `consolidate.rows.length`. O campo de pesquisa filtra Installed e Updates localmente (substring do id, case-insensitive).
  - O overlay `busy` bloqueia os botões de ação e mostra o progresso `done/total`. A mensagem `error` mostra um banner com o botão "Show output" (`openOutput`).

- [ ] **Step 1: Testes que falham**:
  - `installed filter is case-insensitive`.
  - `update selected sends one run per selected package`.
  - `tab counters reflect row counts`.
  - `consolidate under cpm shows override note`.
  - `busy disables action buttons and error re-enables them`.
- [ ] **Step 2:** `npx vitest run test/unit/webview` → FAIL.
- [ ] **Step 3:** Implementar.
- [ ] **Step 4:** → PASS.
- [ ] **Step 5:** Commit `feat: installed, updates and consolidate tabs`.

---

### Task 13: Pontos de entrada, settings, l10n e integração ponta a ponta

**Files:**
- Modify: `package.json` (contributes), `src/extension.ts`
- Create: `package.nls.json`, `l10n/bundle.l10n.json` (gerado com `npx @vscode/l10n-dev export src`), `.vscode-test.mjs`, `test/integration/e2e.int.test.ts`

**Interfaces:**
- Consumes: `findDotnet`, `DotnetCli`, `selectTargets`, `PanelManager`.
- Produces:
  - Comando `csharpWorkbench.manageNuget` ("Manage NuGet Packages…"), com argumento opcional `Uri`:
    - sem Uri: `selectTargets` sobre `workspace.findFiles('**/*.{sln,slnx,csproj}', '**/{bin,obj,node_modules}/**')`. Se houver mais de um alvo, mostra um QuickPick.
    - Uri `.csproj` dentro de uma solução descoberta: abre essa solução com `preselectProject`.
  - `menus.explorer/context`: `when: resourceExtname =~ /^\\.(sln|slnx|csproj)$/`, grupo `navigation@90`. `menus.commandPalette`: sempre visível.
  - Setting `csharpWorkbench.dotnetPath` (string, scope `machine-overridable`).
  - Ativação: sem `dotnet` ⇒ `showErrorMessage` com o botão `Install .NET SDK` (abre `https://dotnet.microsoft.com/download`). Alvo `.slnx` com SDK < 9.0.200 ⇒ erro claro.
  - `package.json` sem `extensionDependencies`.

- [ ] **Step 1: Teste de integração que falha** (`e2e.int.test.ts`, mocha via `@vscode/test-cli`, skip sem `dotnet`). Usa `createFixtureSolution` (Task 7) com 3 projetos numa pasta `My App #1`, já restaurada, e a variante CPM. Casos, um por critério de sucesso:
  1. `opens panel in under 2s with installed rows` (instrumentar `PanelController` com um hook de teste que regista a hora do primeiro `installed`).
  2. `install Serilog in 2 projects matches manual dotnet add` (comparar com `readPackageRefs` numa cópia da fixture, onde se correu `dotnet add` manual).
  3. `update all updates outdated packages`.
  4. `consolidate unifies differing versions`.
  5. `cpm fixture: update changes Directory.Packages.props, not csproj`.
  6. `works without C# Dev Kit` (o perfil de teste corre com `--disable-extensions`; verificar que `ms-dotnettools.csdevkit` não está ativo).
- [ ] **Step 2:** `npm run test:int` → FAIL.
- [ ] **Step 3:** Implementar contributes, `extension.ts` e l10n.
- [ ] **Step 4:** `npm run test:int` → PASS; `npm run test:unit` → PASS.
- [ ] **Step 5:** Commit `feat: commands, explorer menus and end-to-end tests`.

---

### Task 14: Packaging e README

**Files:**
- Create: `README.md`, `CHANGELOG.md`, `LICENSE` (MIT, salvo indicação em contrário), `.vscodeignore`, `media/icon.png` (128×128, placeholder simples)
- Modify: `package.json` (`publisher`: placeholder `TODO-publisher`, `repository`, `categories: ["Programming Languages","Other"]`, `keywords`, script `package` = `vsce package`)

- [ ] **Step 1:** O README descreve as funcionalidades, os requisitos (.NET SDK 8+, 9.0.200+ para `.slnx`), a setting `csharpWorkbench.dotnetPath`, as limitações da v1 (sem login interativo, sem `packages.config`, sem passwords encriptadas) e inclui um screenshot do painel.
- [ ] **Step 2:** `npx vsce package` → gera `csharp-workbench-0.1.0.vsix` sem avisos de ficheiros em excesso. Instalar com `code --install-extension` e abrir uma solução real como verificação manual.
- [ ] **Step 3:** Commit `chore: packaging and readme`.
- [ ] **Step 4:** **Não publicar.** O utilizador define o `publisher` e decide quando publicar no Marketplace e no Open VSX.
