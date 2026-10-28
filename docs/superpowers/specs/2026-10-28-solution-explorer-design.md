# C# Workbench — Solution Explorer (v2) — Design

Data: 2026-10-28
Estado: rascunho para aprovação

## 1. Intenção e porquê

Em maio de 2026 (Dev Kit 3.20.195), a Microsoft retirou o Solution Explorer do C# Dev Kit. No lugar dele ficou a vista read-only "C# Project Details". O pedido para o recuperar (microsoft/vscode-dotnettools#3067) foi fechado como "not planned". A versão 11 do Dev Kit, ainda em pre-release em outubro de 2026, melhora o desempenho e acrescenta um editor de `.csproj`, mas não recupera o Solution Explorer, não traz templates de ficheiros e não tem menu de projeto.

O utilizador disse que o que mais lhe falta do Visual Studio Community é:
1. **criar ficheiros com o botão direito**, cobrindo tudo o que o Visual Studio oferecia;
2. **ver só a solução e os documentos dela**, não a pasta inteira.

A v2 do C# Workbench é um **Solution Explorer próprio**, ao estilo do Visual Studio, integrado com o gestor de NuGet da v1.

## 2. Objetivos

1. Um ícone próprio na barra de atividades (Activity Bar), com a vista "Solution Explorer" (opção "B" escolhida nos mockups). Ao abrir, mostra só a solução e não a árvore de pastas.
2. Árvore:
   - nó da solução com o número de projetos;
   - solution folders, tal como estão na `.sln`/`.slnx`;
   - projetos;
   - em cada projeto, um nó **Dependencies** com Packages, Projects e Frameworks, seguido das pastas e ficheiros do projeto.
3. Esconder `bin/` e `obj/`, e o que o projeto exclui. *(palpite do assistente, não contrariado)*
4. Agrupar ficheiros relacionados (file nesting) como no Visual Studio: `appsettings.*.json` sob `appsettings.json`, `X.xaml.cs` sob `X.xaml`, `X.razor.cs`/`.razor.css` sob `X.razor`, `X.Designer.cs` sob `X.resx`/`X.cs`, `X.cshtml.cs` sob `X.cshtml`. *(palpite, não contrariado)*
5. Seletor de solução quando a pasta tem várias `.sln`/`.slnx`. Se não houver nenhuma, mostrar os `.csproj` soltos. *(palpite, não contrariado)*
6. A árvore acompanha o ficheiro ativo no editor, com uma setting para desligar. *(palpite, não contrariado)*
7. Menus de contexto (abaixo), incluindo **Add ▸ New Item…** com todos os templates do Visual Studio que fazem sentido fora do Windows.

### Menus de contexto

**Solução:** Add ▸ New Project… / Existing Project… / New Solution Folder · Build Solution · Rebuild Solution · Clean Solution · Manage NuGet Packages for Solution… · Open in Terminal · Reveal in Finder. *(palpite, não contrariado)*

**Solution folder:** Add ▸ New Project… / Existing Project… / New Solution Folder · Rename · Remove. *(palpite)*

**Projeto:**
- Add ▸ New Item… · Class… · Interface… · New Folder · Existing Item… · Project Reference… · NuGet Package…
- Build · Rebuild · Clean
- Run · Debug · Set as Startup Project
- Manage NuGet Packages…, que abre o gestor da v1 com este projeto pré-selecionado
- Manage User Secrets
- Open in Terminal · Reveal in Finder · Rename · Remove from Solution

**Pasta de projeto:** Add ▸ (New Item…, Class…, Interface…, New Folder, Existing Item…) · Rename · Delete · Open in Terminal · Reveal in Finder. *(palpite)*

**Ficheiro:** Open · Rename · Delete · Copy · Paste · Copy Path · Reveal in Finder. Também se pode arrastar ficheiros e pastas para os mover dentro do mesmo projeto. *(palpite)*

**Dependencies ▸ Packages:** Manage NuGet Packages… Em cada pacote: Update… e Remove. *(palpite)*
**Dependencies ▸ Projects:** Add Project Reference… Em cada referência: Remove. *(palpite)*

### "New Item…"

- Uma janela de escolha de template (QuickPick com categorias ou webview, decisão do builder) com:
  - **Templates de código embutidos na extensão:** Class, Interface, Enum, Record, Struct. Com namespace correto e file-scoped namespaces quando o projeto usa C# 10+ *(palpite)*.
  - **Todos os templates de item instalados** no `dotnet new` do utilizador (`dotnet new list --type item`). Exemplos: JSON, XML, `.resx`, Razor Component, Razor Page, MVC Controller/View, `.editorconfig`, `.gitignore`, `global.json`, `nuget.config`, `appsettings.json`, Web Config, Protobuf.
- Pede o nome do ficheiro e cria-o na pasta onde fizeste o clique.
- **Namespace:** `RootNamespace` do projeto (ou o nome do projeto) + o caminho relativo da pasta, com separadores convertidos em `.` e caracteres inválidos substituídos, como no Visual Studio.
- Depois de criado, o ficheiro abre no editor.

## 3. Não-objetivos (v2)

- Designers visuais: WinForms, WPF, `.resx` em grelha.
- Project Properties com interface gráfica, editor de launch profiles e Sync Namespaces: ficam para a v3.
- Connected Services, Publish profiles e Docker support.
- Projetos antigos (não SDK-style) e `packages.config`.
- Substituir ou esconder o Explorer normal do VS Code. Os dois convivem.
- Outras linguagens além de C# (F#, VB) nos templates de código. Os templates do `dotnet new` aparecem se estiverem instalados.

## 4. Anti-objetivos

- **Editar `.sln`, `.slnx` ou `.csproj` à mão**, com uma única exceção para as solution folders (secção 7a). As alterações à solução e aos projetos passam pelo `dotnet` CLI:
  - `dotnet sln add/remove` (com `--solution-folder`) para projetos e solution folders;
  - `dotnet add/remove reference` para referências;
  - `dotnet new` para projetos e itens;
  - `dotnet user-secrets init` para user secrets;
  - `dotnet build`/`clean`/`run`.

  A mesma regra da v1.
- **Depender do C# Dev Kit.** O Dev Kit continua opcional.
- **Árvore lenta ou desatualizada.** Abrir uma solução de 20 projetos não pode bloquear o editor. Alterações no disco (incluindo as feitas fora da extensão) refletem-se na árvore sem recarregar a janela.
- **Mostrar ficheiros que não pertencem ao projeto, ou esconder ficheiros que pertencem.** A árvore tem de corresponder ao que o MSBuild considera parte do projeto (ver secção 6).
- **Ações destrutivas sem confirmação.** Delete de ficheiros ou pastas, Remove from Solution e Remove de referências pedem confirmação. Delete move para o Lixo quando possível.

## 5. Como é feito (decisões tomadas)

Decisões do assistente, apresentadas ao utilizador e não contrariadas:
- **Mesma extensão** (C# Workbench) e mesmas bases técnicas da v1: TypeScript, `dotnet` CLI, módulos puros testados com vitest, camada `vscode` fina, testes de integração num VS Code real.
- **Árvore:** `TreeDataProvider` nativo do VS Code, não uma webview. Assim herda o tema, os ícones do file icon theme, o teclado, a seleção múltipla e o drag-and-drop.
- **Localização:** `viewsContainers.activitybar` com um ícone próprio e a vista `csharpWorkbench.solutionExplorer`.
- **Reutiliza a v1:** `findDotnet`, `DotnetCli`, `selectTargets`, `parseSlnList`, os leitores de projeto e o `PanelManager` do NuGet.

## 6. Restrições e pontos técnicos

- **Conteúdo do projeto:** projetos SDK-style incluem os ficheiros por globbing. A árvore mostra os ficheiros do diretório do projeto e esconde `bin/`, `obj/` e os itens removidos com `Remove=`/`DefaultItemExcludes`. Também deve mostrar os itens explícitos de fora do diretório (`<Compile Include="..\Shared\X.cs" Link=...>`). O builder decide como obter isto de forma fiável, por exemplo com `dotnet msbuild -getItem:Compile,None,Content,EmbeddedResource` (SDK 8+), com cache e fallback para globbing simples se a avaliação falhar.
- **Solution folders:** o `dotnet sln list` não as devolve. É preciso ler a `.sln`/`.slnx` (só leitura) para obter a hierarquia. Escrever continua a ser só pelo CLI.
- **Run/Debug:**
  - Run usa `dotnet run --project` num terminal integrado.
  - Debug precisa da extensão C# (`ms-dotnettools.csharp`), que traz o debugger. Se não estiver instalada, a extensão avisa e oferece instalá-la. O debugger da Microsoft só está licenciado para o VS Code oficial; em forks (VSCodium, Cursor), o Debug pode não estar disponível, e isso deve aparecer numa mensagem clara.
- **Set as Startup Project:** guardado por workspace. É usado por um comando "Run/Debug Startup Project" e por uma configuração de launch que a extensão gera.
- **Manage User Secrets:**
  - Se o projeto ainda não tiver `UserSecretsId`, corre `dotnet user-secrets init --project`.
  - Depois abre `~/.microsoft/usersecrets/<id>/secrets.json` (criando `{}` se faltar).
- **Plataformas:** macOS e Linux, como na v1. SDK mínimo 8.0.
- **Coexistência:** convive com o Dev Kit, se estiver instalado, e com o Explorer normal.

## 7. Critérios de sucesso

Numa solução real com solution folders, 3 projetos (um ASP.NET Core, um classlib e um de testes), em macOS, sem o Dev Kit:
1. Clicar no ícone mostra a solução com as solution folders e os projetos em menos de 2 s, sem `bin/` nem `obj/`.
2. `appsettings.Development.json` aparece dentro de `appsettings.json`.
3. Botão direito numa pasta `Models` → Add ▸ Class… → "Customer" cria `Models/Customer.cs` com `namespace MyApp.Core.Models;` e abre-o.
4. "New Item…" lista os templates embutidos e os do `dotnet new` instalados. Criar um "Razor Component" dá o mesmo resultado que `dotnet new razorcomponent`.
5. Add ▸ Project Reference… liga a API ao classlib. O `.csproj` fica igual ao resultado de `dotnet add reference`, e o nó Dependencies ▸ Projects atualiza-se.
6. Add New Project… numa solution folder cria o projeto com `dotnet new` e adiciona-o a essa pasta com `dotnet sln add --solution-folder`.
7. Remove from Solution pede confirmação e usa `dotnet sln remove`.
8. Manage User Secrets abre o `secrets.json` certo.
9. Criar, renomear ou apagar um ficheiro pelo Finder ou pelo terminal aparece na árvore em menos de 1 s.
10. Manage NuGet Packages… abre o gestor da v1 com o projeto pré-selecionado.

## 7a. Decisões após revisão (decisões do assistente, salvo indicação)

Regra geral: quando houver dúvida, replicar o comportamento do Visual Studio.

- **Debug:** não escreve no `.vscode/launch.json` do utilizador.
  - A extensão faz Build, obtém o `TargetPath` com `dotnet msbuild -getProperty:TargetPath` (SDK 8+) e chama `vscode.debug.startDebugging` com uma configuração `coreclr` em memória (program = TargetPath, cwd = pasta do projeto).
  - Também regista um `DebugConfigurationProvider` dinâmico, para o projeto de arranque aparecer em "Run and Debug".
  - Sem a extensão C#: aviso com botão para a instalar. Num fork sem o debugger da Microsoft: mensagem clara de que o Debug não está disponível, e o Run continua a funcionar.
  - O `launchSettings.json` fica fora de âmbito (v3).
- **Estado:**
  - Solução escolhida: `workspaceState`, lembrada entre sessões.
  - Projeto de arranque: `workspaceState`, um por solução, com chave = caminho da solução e valor = caminho do projeto.
  - Se o projeto de arranque sair da solução ou mudar de nome, a escolha é limpa ou atualizada.
- **Rename de projeto:** como no Visual Studio, muda o nome do `.csproj` (não da pasta) e atualiza a solução e as referências dos outros projetos, tudo pelo CLI:
  1. `dotnet sln remove` + `dotnet sln add`, na mesma solution folder;
  2. `dotnet remove reference` + `dotnet add reference` em cada projeto dependente.
- **Rename, Delete e Move de ficheiros e pastas:** operações de disco. Com globbing, o projeto acompanha sozinho. Não muda nomes de classes nem namespaces. Itens explícitos com `Link` noutros `.csproj` não são atualizados; a árvore mostra-os como em falta.
- **Existing Item…:** copia os ficheiros escolhidos para a pasta, como o Visual Studio por omissão. Não cria `Link`.
- **Add ▸ NuGet Package…:** abre o gestor da v1 com o projeto pré-selecionado.
- **Sem solução:** mostra os `.csproj` soltos e esconde os menus de solução. Com solução, os projetos da pasta que não pertencem à solução não aparecem.
- **Seleção múltipla:** Delete, Copy, Paste, Remove reference e Remove package aceitam vários itens. Drag-and-drop só move ficheiros e pastas dentro do mesmo projeto. Projetos não se arrastam.
- **File nesting:** regras fixas, iguais às do Visual Studio (secção 2.4). Botão **Show All Files** na barra da vista, como no Visual Studio, para mostrar `bin/`, `obj/` e o que está excluído.
- **New Item… com `dotnet new`:**
  - A lista (`dotnet new list --type item`) fica em cache por sessão e atualiza-se em segundo plano.
  - A extensão pede só o nome.
  - Corre o CLI real (`dotnet new <template> -n <nome> -o <pasta>`, e `--namespace`/`--project` quando o template os aceitar, segundo `dotnet new <template> --help`, também em cache).
  - Se o template falhar, mostra o erro e o output.
  - Opções extra dos templates ficam para depois.
- **Solution folders (decidido pelo utilizador):** é aberta uma **exceção única** à regra "só pelo CLI". A extensão pode editar diretamente o `.sln`/`.slnx` para:
  - **New Solution Folder:** criar uma pasta vazia, na raiz ou dentro de outra;
  - **Rename** de uma solution folder;
  - **Remove** de uma solution folder vazia. Uma pasta com projetos pede confirmação e remove primeiro os projetos com `dotnet sln remove`, para depois remover a pasta.

  Regras:
  - um módulo dedicado e isolado faz a edição;
  - preserva tudo o resto do ficheiro byte a byte: formatação, BOM, fins de linha, GUIDs e secções que não conhece;
  - escreve de forma atómica (ficheiro temporário + rename);
  - depois de cada edição, valida o resultado com `dotnet sln <ficheiro> list`. Se falhar, repõe o original e mostra o erro;
  - os testes usam ficheiros `.sln` (Visual Studio 17) e `.slnx` reais.

  Nenhuma outra edição da solução ou dos projetos é feita à mão. Mover projetos entre solution folders continua a ser `dotnet sln remove` + `dotnet sln add --solution-folder`.

## 8. Deixado ao builder

- O formato da janela "New Item…" (QuickPick com categorias ou webview).
- Ícones, ordenação (pastas primeiro, como no Visual Studio), estados vazios e mensagens.
- Estratégia de cache e invalidação da árvore e da avaliação MSBuild.
- Como detetar a versão de C# / file-scoped namespaces.
- Detalhes de Copy/Paste e drag-and-drop, desde que fiquem dentro do mesmo projeto.
- Ordem de implementação dentro da v2.
