# C# Workbench — Project Properties, Launch Profiles e Sync Namespaces (v3) — Design

Data: 2026-10-28
Estado: rascunho para aprovação

O utilizador pediu para saltar as perguntas e partir da recomendação do assistente. Tudo o que está neste documento é **decisão do assistente**, salvo quando diz o contrário. O utilizador pode contrariar qualquer ponto ao ler.

## 1. Intenção e porquê

A v2 trouxe o Solution Explorer. Com ele, o projeto ganhou um menu de contexto como no Visual Studio, mas faltam três coisas que o design da v2 deixou para a v3:

1. **Project Properties:** a página de propriedades do projeto do Visual Studio. No Mac, hoje, mudar o target framework, o nullable ou a versão do pacote obriga a editar o `.csproj` à mão.
2. **Launch profiles:** o Visual Studio deixa escolher e editar perfis de arranque (`Properties/launchSettings.json`) com argumentos, variáveis de ambiente e URLs. O Run/Debug da v2 ignora estes perfis no Debug.
3. **Sync Namespaces:** depois de mover ficheiros entre pastas, o Visual Studio corrige os `namespace` para corresponderem às pastas. No VS Code não há equivalente sem o Dev Kit.

Ordem de entrega recomendada: Project Properties, depois Launch Profiles (que completa o Run/Debug da v2), depois Sync Namespaces.

## 2. Objetivos

### 2.1 Project Properties

- Entrada **Properties** no fundo do menu de contexto do projeto, como no Visual Studio, e o comando `C# Workbench: Project Properties` na paleta (pede o projeto se não houver contexto).
- Abre uma **webview** por projeto (uma só aberta por projeto; reabrir foca-a), com navegação à esquerda por secções, como o Visual Studio 2022:
  - **Application:** Output type (`OutputType`: Exe, Library, WinExe), Target framework(s) (`TargetFramework` ou `TargetFrameworks`), Assembly name (`AssemblyName`), Default namespace (`RootNamespace`), Startup object (`StartupObject`).
  - **Build:** Nullable (`Nullable`), Implicit usings (`ImplicitUsings`), Language version (`LangVersion`), Treat warnings as errors (`TreatWarningsAsErrors`), Warnings as errors (`WarningsAsErrors`), Suppress warnings (`NoWarn`), Conditional symbols (`DefineConstants`), Allow unsafe code (`AllowUnsafeBlocks`), Documentation file (`GenerateDocumentationFile`).
  - **Package:** Generate package on build (`GeneratePackageOnBuild`), Packable (`IsPackable`), Package ID (`PackageId`), Version (`Version`), Authors, Company, Product, Description, Copyright, License expression (`PackageLicenseExpression`), Project URL (`PackageProjectUrl`), Repository URL (`RepositoryUrl`), Tags (`PackageTags`), Release notes (`PackageReleaseNotes`).
  - **Assembly:** Assembly version (`AssemblyVersion`), File version (`FileVersion`), Informational version (`InformationalVersion`).
  - **Debug:** a lista de launch profiles com o editor da secção 2.2.
  - **User Secrets:** botão que corre o "Manage User Secrets" da v2.
- Cada campo mostra o **valor avaliado** (o que o MSBuild usa) e a **origem**:
  - **neste projeto:** a propriedade está num `PropertyGroup` sem condição do `.csproj`. Editável.
  - **herdado:** vem do SDK, de um `Directory.Build.props` ou de um ficheiro importado. Mostra o valor e a indicação "herdado". Editar cria um override no `.csproj`, como o Visual Studio. Um botão "Repor" remove o override.
  - **condicional:** a propriedade está no `.csproj` com uma `Condition` (por exemplo, só em Release). Só leitura, com a indicação "definido por configuração", e um botão para abrir o `.csproj` nessa linha.
- Guardar é explícito (botão **Save** e `Cmd+S` com a webview focada), como no Visual Studio. Fechar com alterações por guardar pede confirmação. Se o `.csproj` mudar no disco com alterações por guardar, a webview avisa e oferece recarregar.
- Validação no próprio campo: target framework válido (`net8.0`, `net10.0`, `netstandard2.0`, …), versões no formato SemVer/`a.b.c.d`, nomes de assembly e namespace válidos (reutiliza `naming.ts`).

### 2.2 Launch Profiles

- Editor dentro da secção **Debug** da webview do projeto e o comando `C# Workbench: Select Launch Profile`.
- Lê e escreve `Properties/launchSettings.json`, preservando comentários, ordem e formatação do resto do ficheiro.
- Perfis com `commandName` **Project** e **Executable** são editáveis e executáveis. Perfis de outros tipos (IIS, IISExpress, Docker, …) aparecem na lista, marcados como "não suportado neste sistema", e não podem ser escolhidos.
- Campos: nome do perfil, command line arguments (`commandLineArgs`), working directory (`workingDirectory`), environment variables (`environmentVariables`, tabela chave/valor), App URL (`applicationUrl`), Launch browser (`launchBrowser`) + URL relativo (`launchUrl`), e, para Executable, o caminho (`executablePath`).
- Ações: New, Duplicate, Rename, Delete (com confirmação). Se o ficheiro não existir, New cria-o com `{"profiles":{}}` e o perfil.
- **Perfil ativo:** um por projeto, guardado em `workspaceState` (chave `cw.launchProfile:<caminho do projeto>`). Por omissão, o primeiro perfil suportado, como o `dotnet run`. O nó do projeto de arranque na árvore mostra o perfil ativo na descrição. Se o perfil ativo deixar de existir, volta ao primeiro.
- **Run/Debug usam o perfil ativo:**
  - Run: `dotnet run --project <proj> --launch-profile <nome>` (já com `-f` nos multi-target, como na v2). Sem perfis: como hoje.
  - Debug (configuração `coreclr` em memória da v2): `args` = argumentos do perfil, `env` = variáveis do perfil, `cwd` = working directory (ou a pasta do projeto). Em perfis Project com `applicationUrl`, define `ASPNETCORE_URLS`. Com `launchBrowser`, usa `serverReadyAction` para abrir o browser no URL quando a app escreve "Now listening on". Perfis Executable: `program` = `executablePath`.
  - O `DebugConfigurationProvider` dinâmico da v2 passa a oferecer uma entrada por perfil suportado do projeto de arranque.

### 2.3 Sync Namespaces

- Entrada **Sync Namespaces** no menu do projeto e da solução, como no Visual Studio 2022.
- Para cada `.cs` do projeto (itens `Compile` avaliados, sem ficheiros ligados de fora do projeto, sem `obj/` nem ficheiros gerados), calcula o namespace esperado com `namespaceFor(RootNamespace, pasta do projeto, pasta do ficheiro)` da v2.
- Altera **só a declaração** do namespace (`namespace X;` ou `namespace X { … }`), mantendo o estilo (file-scoped ou bloco) e o resto do ficheiro byte a byte.
- **Referências:** em todos os `.cs` dos projetos da solução, quando um ficheiro tem `using Antigo;` e o namespace `Antigo` deixa de existir depois do sync, a diretiva passa a `using Novo;` (uma por cada namespace novo para onde foram tipos de `Antigo`). Se `Antigo` continuar a existir, junta-se `using Novo;` ao lado. Referências totalmente qualificadas (`Antigo.Tipo`) e `global using` noutros ficheiros entram na mesma regra; nomes dentro de strings e comentários nunca são tocados.
- Ficheiros sem namespace, com vários namespaces de topo ou com namespaces aninhados ficam de fora e aparecem numa lista "não alterados" no Output.
- **Tudo passa pela pré-visualização de refactoring do VS Code** (`WorkspaceEdit` com confirmação): o utilizador vê cada alteração e pode desmarcar ficheiros antes de aplicar. Nada é escrito sem essa confirmação.
- Depois de aplicar, oferece **Build** para confirmar que o código compila.

## 3. Não-objetivos (v3)

- Propriedades por configuração (Debug/Release) e por plataforma: aparecem só em leitura (2.1).
- Secções do Visual Studio sem equivalente fora do Windows: Resources, Settings, Signing, Code Analysis, Publish, Windows/WPF/WinForms.
- Editar `Directory.Build.props`, `Directory.Packages.props` ou ficheiros importados.
- Perfis IIS/IISExpress/Docker.
- Renomear símbolos que não sejam namespaces, ou mover ficheiros para corresponder a namespaces (o inverso do sync).
- Uma análise semântica completa como a do Roslyn. O Sync Namespaces trabalha sobre o texto, com um tokenizador de C# que ignora comentários e strings.

## 4. Anti-objetivos

- **Estragar um `.csproj`.** Uma alteração de propriedades que deixe o projeto inválido, ou que mude outra coisa além das propriedades editadas, é um falhanço, mesmo que a página funcione.
- **Escrever código-fonte sem pré-visualização.** O Sync Namespaces nunca aplica alterações sem o utilizador as ver.
- **Mostrar um valor diferente do que o MSBuild usa.** A página mostra sempre o valor avaliado, não só o texto do `.csproj`.
- **Depender do C# Dev Kit.** Continua opcional. O editor de `.csproj` do Dev Kit 11 (pre-release) pode coexistir.
- **Página lenta.** A webview abre logo e mostra o estado "a ler o projeto…" enquanto a avaliação MSBuild corre.

## 5. Como é feito (decisões do assistente)

- **Segunda exceção à regra "só pelo CLI": propriedades do `.csproj`.** O `dotnet` CLI não tem comando para mudar propriedades MSBuild, e o Visual Studio edita o `.csproj` diretamente. A v3 abre uma segunda exceção, com as mesmas regras da exceção das solution folders (v2, §7a), e com um módulo isolado e dedicado:
  - só toca em elementos de propriedade dentro de `PropertyGroup` **sem condição** do próprio `.csproj`: muda o texto de um elemento existente, acrescenta um elemento novo ao primeiro `PropertyGroup` sem condição (com a mesma indentação), ou remove um elemento (Repor);
  - preserva tudo o resto byte a byte: formatação, comentários, BOM, fins de linha, atributos e ordem;
  - escreve de forma atómica, com backup `.cw-bak` até a validação passar, e as mesmas proteções do `slnWriter` (realpath, permissões, ficheiro só de leitura recusado, ficheiro mudado no disco recusado);
  - **valida depois de escrever** com `dotnet msbuild <proj> -getProperty:<cada propriedade editada>`: o valor avaliado tem de ser o pedido (ou, no Repor, deixar de vir do `.csproj`). Se falhar, repõe o original e mostra o erro;
  - escapa `&`, `<` e `>` nos valores;
  - `TargetFramework` ↔ `TargetFrameworks`: escolher mais de um framework troca o elemento (remove um, cria o outro), numa só escrita.
- **`launchSettings.json`** não é um ficheiro de projeto, e é editado diretamente com a biblioteca `jsonc-parser` (Microsoft), que aplica edições mínimas e preserva comentários e formatação. Escrita atómica, como acima.
- **Sync Namespaces** só altera código-fonte, através de `WorkspaceEdit`. O VS Code trata da pré-visualização, do undo e dos ficheiros abertos com alterações.
- **Leitura das propriedades:** um único `dotnet msbuild <proj> -getProperty:A -getProperty:B …` (SDK 8+, saída JSON) para os valores avaliados, mais a leitura do XML do `.csproj` (já existe `fast-xml-parser` no projeto) para saber a origem de cada propriedade. Com timeout e mensagem clara se a avaliação falhar; nesse caso a página fica só de leitura.
- **Webview:** reutiliza a base da v1 (`chrome.ts`, estilos, CSP, protocolo de mensagens tipado) e segue o tema do VS Code. Lógica em módulos puros testados com vitest; a webview é testada com `happy-dom`, como a v1.
- **Mesmas bases técnicas:** TypeScript, módulos puros sem `vscode`, camada `vscode` fina, testes de integração num VS Code real, `vscode.l10n.t` em todos os textos visíveis, sem dependência do Dev Kit.
- **Versão:** `0.3.0`.

## 6. Restrições e pontos técnicos

- macOS e Linux, SDK mínimo 8.0, como antes. Caminhos com espaços e `#`.
- Projetos SDK-style apenas.
- Uma propriedade pode aparecer várias vezes no mesmo `PropertyGroup` sem condição ou em vários grupos sem condição: o MSBuild usa a última. O writer edita a última ocorrência e a página indica que há duplicados.
- Propriedades com valores que referenciam outras (`$(Foo)`): mostradas com o texto original e o valor avaliado; editá-las substitui o texto.
- `launchSettings.json` pode ter variáveis como `$(TargetDir)` ou `%VAR%`; ficam como texto e o `dotnet run` trata delas. No Debug, as variáveis de ambiente `%VAR%`/`$VAR` são expandidas como o `dotnet run` faz.
- Sync Namespaces numa solução grande não pode bloquear o editor: o cálculo corre com progresso e cancelamento.

## 7. Critérios de sucesso

Num projeto ASP.NET Core real (SDK 8) com um `Directory.Build.props` que define `Nullable`, em macOS, sem o Dev Kit:
1. Properties abre em menos de 2 s com o estado "a ler…" e mostra os valores avaliados. `Nullable` aparece como "herdado".
2. Mudar Target framework de `net8.0` para `net8.0;net10.0` e guardar troca `TargetFramework` por `TargetFrameworks`; o `diff` do `.csproj` mostra só essa linha; `dotnet build` passa.
3. Mudar `Nullable` (herdado) cria um override no `.csproj`; Repor remove-o e o valor volta a "herdado".
4. Uma propriedade com `Condition` aparece só em leitura.
5. Um `.csproj` com comentários, BOM e CRLF fica igual byte a byte, exceto a linha editada.
6. Criar um launch profile "Staging" com `ASPNETCORE_ENVIRONMENT=Staging` e escolhê-lo: Run arranca com `--launch-profile Staging`; Debug arranca com essa variável e abre o browser no URL da app.
7. Os comentários do `launchSettings.json` mantêm-se depois de editar um perfil.
8. Mover `Customer.cs` de `Models/` para `Domain/` e correr Sync Namespaces mostra a pré-visualização com a declaração e os `using` afetados; depois de aplicar, o projeto compila.
9. Um ficheiro com dois namespaces de topo fica de fora e aparece na lista "não alterados".
10. Uma escrita do `.csproj` que falhe a validação deixa o ficheiro original intacto e mostra o erro.

## 8. Deixado ao builder

- Layout exato da webview, controlos (checkbox, select, texto), mensagens e estados vazios.
- Lista de valores sugeridos para `LangVersion` e target frameworks.
- O desenho do tokenizador de C# para o Sync Namespaces, desde que ignore comentários, strings (incluindo verbatim, interpoladas e raw string literals) e diretivas de pré-processador.
- Ordem de implementação dentro da v3, respeitando a ordem de entrega da secção 1.
