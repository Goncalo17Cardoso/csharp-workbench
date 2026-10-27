# C# Workbench — Gestor de NuGet (v1) — Design

Data: 2026-10-26
Estado: rascunho para aprovação

## 1. Intenção e porquê

O Visual Studio Community não existe para macOS nem Linux (o Visual Studio for Mac foi retirado a 31-08-2024). A Microsoft aponta o VS Code + C# Dev Kit como substituto, mas o Dev Kit não oferece várias facilidades que o Visual Studio dava. Em maio de 2026 (Dev Kit 3.20.195) a situação piorou: o Solution Explorer foi substituído pela vista read-only "C# Project Details", e o pedido para o recuperar (microsoft/vscode-dotnettools#3067) foi fechado como "not planned".

**C# Workbench** é uma extensão para o VS Code que porta para macOS/Linux as facilidades do Visual Studio Community que o C# Dev Kit não tem. O utilizador-alvo é quem programa em C# fora do Windows e vem do Visual Studio.

A primeira versão (v1) entrega uma única peça: **um gestor de pacotes NuGet com interface gráfica**, modelado no gestor do Visual Studio. A documentação oficial do VS Code diz literalmente "there is not a NuGet Package Manager user interface in Visual Studio Code"; o Dev Kit só tem comandos na Command Palette (Add / Update / Remove).

Fluxo principal descrito pelo utilizador: **procurar o pacote → escolher a versão → instalar.**

## 2. Objetivos (v1)

1. Um separador de editor "NuGet: <solução>" com quatro separadores — **Browse**, **Installed**, **Updates**, **Consolidate** — e um painel de detalhe, com a disposição do Visual Studio (opção "A" escolhida nos mockups; ver secção 5).
2. Instalar, atualizar e desinstalar pacotes em um ou vários projetos da solução de uma vez.
3. Funcionar com `.sln` e `.slnx`, e com um `.csproj` isolado sem solução.
4. Respeitar Central Package Management (`Directory.Packages.props`) quando existe.
5. Respeitar as fontes configuradas em `nuget.config`: feeds v3, feeds v2, pastas locais e feeds com credenciais no `nuget.config`. Só ficam de fora os feeds que exijam login interativo (detalhe na secção 8a).
6. Funcionar em macOS e Linux (Windows não é alvo, mas não deve ser partido de propósito).

## 3. Não-objetivos (v1)

- Autenticação interativa em feeds privados (Azure DevOps, GitHub Packages com login, credential providers).
- Package Manager Console (PowerShell).
- Projetos antigos com `packages.config` (.NET Framework não-SDK-style).
- Solution Explorer, templates "Add → Class/Interface…", abrir pela solução — são as próximas funcionalidades do C# Workbench, **não** desta versão.
- Gerir as fontes NuGet (adicionar/remover feeds) a partir da UI.

## 4. Anti-objetivos (falha mesmo que "funcione")

- **Editar `.csproj` / `Directory.Packages.props` de forma diferente do que o Visual Studio / `dotnet` CLI fariam.** O resultado no disco tem de ser o mesmo que `dotnet add package` produziria. Nada de escrever XML à mão.
- **Depender do C# Dev Kit.** A Microsoft muda o Dev Kit sem aviso (caso do Solution Explorer). A extensão tem de funcionar só com o .NET SDK instalado; o Dev Kit é opcional. Não declarar `extensionDependencies` no Dev Kit.
- **Alterar ficheiros sem o utilizador perceber.** Cada operação mostra o que vai mudar (projetos, versão) e reporta o resultado; erros do `dotnet` aparecem de forma legível, com o output completo disponível num Output channel.
- **UI lenta ou que bloqueia o editor.** Pesquisa com debounce, operações longas com indicador de progresso e sem congelar o VS Code.
- **Aspeto estranho ao VS Code.** A UI segue o tema ativo (claro/escuro/alto contraste) via variáveis CSS `--vscode-*`.

## 5. A interface (decidida com o utilizador)

Separador de editor (WebviewPanel), um por solução aberta.

**Barra de topo**
- Separadores: Browse · Installed · Updates (com contador) · Consolidate (com contador quando há divergências).
- Seletor de solução quando a pasta tem várias `.sln`/`.slnx` (ou o `.csproj` isolado).

**Barra de pesquisa** (Browse; também filtra Installed/Updates)
- Campo de pesquisa, checkbox "Include prerelease", seletor de fonte ("All" + cada fonte do `nuget.config`).

**Lista (esquerda)**
- Ícone, nome, descrição curta, downloads, versão mais recente (Browse) ou versão instalada → disponível (Installed/Updates).
- Updates: seleção múltipla + "Update selected" / "Update all". *(palpite meu, não contrariado pelo utilizador)*

**Painel de detalhe (direita)**
- Nome, descrição, autores, downloads, licença, link do projeto.
- Lista de projetos da solução com checkbox e a versão instalada em cada um (ou "não instalado").
- Dropdown de versões (marca "latest", "installed"; prerelease só se a checkbox estiver ligada).
- Botão contextual: **Install** / **Update** / **Uninstall** conforme os projetos marcados e o estado.
- Abaixo: README (renderizado), dependências por target framework, aviso de pacote deprecated / vulnerável se a fonte o reportar.

**Consolidate**
- Lista pacotes instalados com versões diferentes entre projetos; escolher a versão alvo e aplicar a todos os projetos selecionados.

**Pontos de entrada**
- Explorer, botão direito em `.sln`, `.slnx` ou `.csproj` → "Manage NuGet Packages…". Aberto a partir de um `.csproj`, esse projeto vem pré-selecionado no painel de detalhe.
- Command Palette: "C# Workbench: Manage NuGet Packages".
- Se o Dev Kit estiver instalado e expuser uma vista onde seja possível contribuir menus, adicionar a entrada lá também (opcional, só se for trivial).

## 6. Como é feito (decisões tomadas)

Estas são decisões do assistente, apresentadas ao utilizador e não contrariadas:

- **Linguagem:** TypeScript, extensão VS Code padrão.
- **UI:** Webview. Nota: `@vscode/webview-ui-toolkit` está descontinuado desde jan/2025 — não usar. Escolha de framework da webview é do builder (HTML/CSS simples ou framework leve), desde que siga o tema via `--vscode-*`.
- **Operações sobre projetos:** sempre via `dotnet` CLI:
  - instalar/atualizar: `dotnet add <projeto> package <id> --version <v>`
  - remover: `dotnet remove <projeto> package <id>`
  - listar instalados / desatualizados: `dotnet list <alvo> package [--outdated] --format json`
  - projetos da solução: `dotnet sln <sln> list` (suporta `.slnx` no SDK 9.0.200+)
- **Pesquisa, versões, metadados, README, ícones:** API NuGet v3 de cada fonte (service index → `SearchQueryService`, `RegistrationsBaseUrl`, `PackageBaseAddress`), feita a partir do processo da extensão (não da webview).
- **Fontes:** obtidas do `nuget.config` efetivo (ex.: `dotnet nuget list source`), não hardcoded.
- **Dev Kit:** opcional; nenhuma dependência declarada.
- **Nome / identificador:** "C# Workbench"; id da extensão `csharp-workbench`. Publisher a definir antes de publicar.

## 7. Restrições

- Plataformas-alvo: macOS e Linux.
- Requer .NET SDK instalado e no PATH. SDK mínimo: 8.0 (por causa de `--format json` em `dotnet list package`); `.slnx` exige 9.0.200+. Se o `dotnet` não for encontrado, mostrar mensagem clara com link de instalação, em vez de falhar em silêncio.
- Nota de ambiente: na máquina do utilizador, `dotnet` não está no PATH à data deste documento; Node 22 está instalado.
- Licença do C# Dev Kit exige conta Visual Studio para uso comercial — mais uma razão para não depender dele.
- Distribuição prevista: VS Code Marketplace (e Open VSX). *(palpite do assistente, não contrariado)*
- Idioma da UI: inglês por omissão, com strings preparadas para `vscode.l10n`. *(decisão do assistente)*

## 8. Critérios de sucesso (v1)

Num projeto real com uma `.sln` de 3 projetos, em macOS:

1. Botão direito na `.sln` → abre o gestor em < 2 s com a lista de Installed preenchida.
2. Pesquisar "serilog", escolher uma versão, marcar 2 projetos, Install → os dois `.csproj` ficam idênticos ao resultado de `dotnet add package` manual, e a UI atualiza sem recarregar.
3. Updates mostra os pacotes desatualizados; "Update all" atualiza-os.
4. Com versões diferentes do mesmo pacote em 2 projetos, Consolidate mostra-o e unifica.
5. Com `Directory.Packages.props`, as versões são alteradas lá, não nos `.csproj`.
6. Funciona sem o C# Dev Kit instalado.

## 8a. Decisões após revisão (decisões do assistente, salvo indicação)

Regra geral: quando houver dúvida, replicar o comportamento do gestor NuGet do Visual Studio.

- **CPM (`Directory.Packages.props`):** como no Visual Studio, a versão é central. Install num projeto adiciona o `PackageReference` sem versão a esse projeto e o `PackageVersion` central se ainda não existir. Update/Consolidate alteram a versão central, e a UI avisa que isso afeta todos os projetos que usam o pacote. As checkboxes por projeto continuam a decidir *quem referencia* o pacote, não a versão. `VersionOverride` existentes são mostrados no painel de detalhe e listados em Consolidate; "unificar" remove o override (via `dotnet` quando possível). Não se criam `VersionOverride` novos na v1.
- **Uninstall com CPM:** `dotnet remove package` pode deixar o `<PackageVersion>` órfão. Na v1 fica órfão, como no Visual Studio. Não há edição manual de XML.
- **Restore e tempo de abertura:** o critério "< 2 s" aplica-se a uma solução já restaurada. Installed é preenchido primeiro a partir dos ficheiros de projeto / `project.assets.json`, e depois confirmado com `dotnet list package`. Se não houver restore, a extensão corre `dotnet restore` em segundo plano com indicador de progresso, como o Visual Studio faz ao abrir uma solução.
- **Package Source Mapping:** a extensão respeita os mapeamentos existentes. Se uma instalação falhar por falta de mapeamento, mostra o erro de forma clara e indica o ficheiro `nuget.config` a corrigir. Na v1 não cria mapeamentos (isso seria gerir fontes, fora do âmbito).
- **Localizar `dotnet`:** a extensão procura primeiro no PATH e depois em `/usr/local/share/dotnet`, `/usr/share/dotnet`, `~/.dotnet` e `/opt/homebrew/bin`. Também há uma setting `csharpWorkbench.dotnetPath`. Isto resolve o caso do VS Code aberto pela Dock no macOS, que não herda o PATH do shell.
- **Tipos de fonte suportados (decidido pelo utilizador):** a v1 suporta todas as fontes do `nuget.config` efetivo, como o Visual Studio, exceto as que exigem login interativo:
  - feeds v3 (nuget.org e outros), com pesquisa completa;
  - feeds v2 antigos e pastas locais, que aparecem no seletor com pesquisa (para pastas locais, filtragem simples por id/descrição);
  - feeds autenticados com `<packageSourceCredentials>` no `nuget.config`: `ClearTextPassword` e referências a variáveis de ambiente (`%VAR%`). A hierarquia completa de `nuget.config` é respeitada (projeto → pastas acima → utilizador → máquina).
  - Passwords encriptadas (`Password`) não são suportadas, tal como no próprio NuGet fora do Windows. A extensão mostra um aviso claro nesse caso.
  - Credential providers e login interativo continuam fora da v1 (secção 3).

## 9. Deixado ao builder

- Estrutura do repositório, bundler, framework da webview, gestão de estado.
- Estratégia de testes (unitários + integração com `@vscode/test-electron` ou equivalente).
- Cache de resultados da API NuGet e de `dotnet list`.
- Como detetar alterações externas aos `.csproj` (file watcher) e refrescar.
- Detalhes visuais (espaçamentos, ícones, estados vazios), desde que respeitem a secção 5 e o tema.
- Ordem de implementação dentro da v1.

## 10. Roadmap depois da v1 (contexto, não âmbito)

Ordem indicada pelo utilizador para as próximas lacunas: (2) criar ficheiros com templates no botão direito ("Add → Class/Interface/Enum…" com namespace correto); (3) abrir/navegar pela solução em vez da pasta — provavelmente um Solution Explorer próprio, que é a maior queixa da comunidade após a remoção no Dev Kit. Prior art a estudar: `fernandoescolar/vscode-solution-explorer`.
