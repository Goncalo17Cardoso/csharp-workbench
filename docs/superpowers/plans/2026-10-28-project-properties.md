# Project Properties, Launch Profiles and Sync Namespaces (v3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a VS-style Project Properties page with a launch profile editor, make Run/Debug use the active launch profile, and add Sync Namespaces with a refactor preview.

**Architecture:**
- Pure modules with no `vscode` import:
  - an offset-tracking `.csproj` property scanner and editor;
  - a properties model;
  - a `jsonc-parser`-based launch profile store;
  - a C# tokenizer and a namespace-sync planner.
- Thin adapters:
  - a webview panel and controller, following the v1 NuGet panel pattern;
  - commands and menus on the v2 Solution Explorer;
  - Run/Debug changes in `runCore.ts`/`run.ts`;
  - a `WorkspaceEdit` with confirmation for Sync Namespaces.
- `.csproj` writes go through a generalized version of the v2 atomic writer, with an MSBuild postcondition.

**Tech Stack:** TypeScript, VS Code API ≥1.95, esbuild, vitest (+ happy-dom for webview), `@vscode/test-cli` e2e, `fast-xml-parser` (existing), `jsonc-parser` (new).

**Spec:** `docs/superpowers/specs/2026-10-28-project-properties-design.md`

## Global Constraints

- **Edits by hand.** Never edit `.sln`, `.slnx` or `.csproj` text by hand, with two exceptions:
  - the v2 solution-folder module;
  - the v3 `.csproj` property editor (`src/properties/csprojEdit.ts`). It only edits property elements in **unconditional** `PropertyGroup`s of the project file itself. Everything else in the file stays byte-identical. Writes are atomic, keep a `.cw-bak` until validated, and validate with `dotnet msbuild -getProperty`.
- **Other files.** `launchSettings.json` is edited with `jsonc-parser` minimal edits and an atomic write. Source files are changed only through a `WorkspaceEdit` that the user confirms in the refactor preview.
- **Processes.** Run them with `execFile` and argument arrays, never through a shell.
- **No C# Dev Kit dependency.** Debug needs `ms-dotnettools.csharp`, and Run must work without it.
- **Command ids:**
  - `csharpWorkbench.projectProperties` (title "Properties");
  - `csharpWorkbench.selectLaunchProfile` (title "Select Launch Profile");
  - `csharpWorkbench.syncNamespaces` (title "Sync Namespaces").
- **Other ids.**
  - Webview panel view type: `csharpWorkbench.properties`.
  - workspaceState key: `cw.launchProfile:<project path>`.
- **Strings:** every visible string goes through `vscode.l10n.t` or `package.nls.json`. Add keys to `l10n/bundle.l10n.json` by hand, appending; never overwrite it with `l10n-dev export`. `test/unit/l10nBundle.test.ts` must pass.
- **Platforms:** macOS and Linux, minimum SDK 8.0. Paths with spaces and `#` must work.
- **Tests:**
  - unit tests run with `npm run test:unit -- <path>`, never `npx vitest`;
  - e2e tests run with `npm run test:int`, after `export PATH="$HOME/.dotnet:$PATH" DOTNET_ROOT="$HOME/.dotnet"`.
- **Commits:** use Conventional Commits, with **no `Co-Authored-By` or any attribution trailer**.
- **Version:** `0.3.0`.

## Review Focus

1. **A `.csproj` written by hand or by Visual Studio.** It may have a UTF-8 BOM, CRLF, tabs, comments, attributes on property elements, a self-closing `<Nullable />` or a value containing `&amp;`. It must stay byte-identical outside the edited element. → Task 3 tests.
2. **MSBuild evaluation fails or times out** (missing restore, broken import). The page must show the error and go read-only, never write, and never show values from the XML as if they were evaluated. → Task 4 and Task 5 tests.
3. **The `.csproj` changes on disk while the page has unsaved edits, or between read and write.** Save must refuse with the "changed on disk" message, the page must offer Reload, and nothing may be written. → Task 2 and Task 5 tests.
4. **Unusual `launchSettings.json` files:** comments, trailing commas, no file, no `profiles` key, profile names with spaces or non-ASCII, or a non-object profile value. Each must load without throwing, and edits must keep comments. → Task 7 tests.
5. **Namespace-like text that is not code.** Text inside comments, strings (verbatim, interpolated, raw `"""`) or `#if` blocks around a namespace must never be edited. A file with `#if` around its namespace declaration is skipped. → Task 10 and Task 11 tests.

---

## File structure

| File | Responsibility |
|---|---|
| `src/core/atomicWrite.ts` (new; `slnWriter.ts` re-exports it) | Generic atomic text-file replace with backup, realpath, mode, expected-original and validate. |
| `src/dotnet/cli.ts` (modify) | `getProperties(project, names)`. |
| `src/properties/csprojScan.ts` | Offset-tracking scan of property elements in a `.csproj`. |
| `src/properties/csprojEdit.ts` | `applyPropertyEdits(xml, edits)` with byte preservation and postcondition. |
| `src/properties/schema.ts` | Sections, fields and validators. |
| `src/properties/model.ts` | Builds `PropertiesModel` from evaluation + scan; `saveProperties` flow. |
| `src/properties/protocol.ts` | Webview ↔ host message types. |
| `src/properties/controller.ts` | Pure controller (load, dirty, save, reload, launch-profile actions). |
| `src/properties/PropertiesPanel.ts` | Thin `WebviewPanel` wrapper, one per project. |
| `src/properties/commands.ts` | Command registration, menu wiring, file watching. |
| `src/webview/properties/main.ts`, `views/*.ts`, `properties.css` | Webview UI. |
| `src/launch/launchSettings.ts` | Parse, list and edit launch profiles with `jsonc-parser`. |
| `src/launch/activeProfile.ts` | `workspaceState` active-profile helpers and fallback. |
| `src/solution/runCore.ts`, `commands/run.ts` (modify) | Run/Debug with the profile. |
| `src/sync/csTokens.ts` | C# tokenizer: namespace decls, usings, top-level type names, qualified names, with offsets. |
| `src/sync/plan.ts` | Pure sync planner: edits per file and skipped files. |
| `src/sync/command.ts` | `WorkspaceEdit` adapter, progress/cancel, Output, Build offer. |

---

### Task 1: Generic atomic writer and `getProperties`

**Files:**
- Create: `src/core/atomicWrite.ts`
- Modify: `src/solution/slnWriter.ts`, `src/dotnet/cli.ts`
- Test: `test/unit/core/atomicWrite.test.ts`, `test/unit/dotnet/getProperties.test.ts`; `test/unit/solution/slnWriter.test.ts` stays green unchanged.

**Interfaces:**
- Produces:
  - `writeTextAtomically(path: string, newText: string, deps: TextWriterDeps, expectedOriginal: string): Promise<void>`;
  - `TextWriterDeps` (same shape as today's `SolutionWriterDeps`), `TextFs`, `nodeTextFs`, `ChangedOnDiskError` (thrown when the current text ≠ `expectedOriginal`), `ReadOnlyFileError`.
  - `slnWriter.ts` keeps `writeSolutionAtomically`, `nodeSolutionFs`, `SolutionFs` and `SolutionWriterDeps` as re-exports/aliases.
  - `DotnetCli.getProperties(project: string, names: string[]): Promise<Record<string, string>>`. It runs `msbuild <project> -getProperty:A -getProperty:B …` with `MSBUILD_EVAL_TIMEOUT_MS`. It parses the JSON `{"Properties":{…}}` and, for a single name, plain text. Every requested name appears in the result, `''` when empty.

- [ ] **Step 1:** Move the body of `writeSolutionAtomically` to `writeTextAtomically` and make the two error classes typed. Run `npm run test:unit -- test/unit/solution/slnWriter.test.ts`. Expected: PASS, unchanged.
- [ ] **Step 2:** Write `atomicWrite.test.ts`:
  - `throws ChangedOnDiskError and writes nothing when the file text differs from expectedOriginal`;
  - `throws ReadOnlyFileError for a non-writable file`.
- [ ] **Step 3:** Write `getProperties.test.ts` with a fake `Exec`:
  - `parses JSON output for two names` expects `{ Nullable: 'enable', Version: '1.2.0' }`;
  - `returns plain text for one name`;
  - `fills missing names with ''`;
  - `passes the timeout`.
- [ ] **Step 4:** Implement. Run the three test files. Expected: PASS.
- [ ] **Step 5:** Commit `refactor: generic atomic text writer and multi-property evaluation`.

### Task 2: `.csproj` property scanner

**Files:**
- Create: `src/properties/csprojScan.ts`
- Test: `test/unit/properties/csprojScan.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface PropertyOccurrence {
    name: string;            // element name, e.g. 'Nullable'
    rawValue: string;        // inner text exactly as written ('' for <X/> or <X></X>)
    value: string;           // rawValue with XML entities decoded
    start: number; end: number;          // offsets of the whole element incl. tags
    valueStart: number; valueEnd: number; // offsets of the inner text (equal for self-closing)
    selfClosing: boolean;
    conditional: boolean;    // element or its PropertyGroup has a Condition attribute
    groupIndex: number;      // index of the PropertyGroup in document order
  }
  export interface CsprojScan {
    occurrences: PropertyOccurrence[];
    groups: { index: number; conditional: boolean; openEnd: number; closeStart: number; indent: string; childIndent: string }[];
    projectOpenEnd: number;  // offset just after the <Project …> open tag
    eol: '\n' | '\r\n';
  }
  export function scanCsproj(xml: string): CsprojScan;
  export type PropertyOrigin = 'project' | 'conditional' | 'inherited';
  export function originOf(scan: CsprojScan, name: string): { origin: PropertyOrigin; duplicates: boolean; last?: PropertyOccurrence };
  ```
- `originOf` rules:
  - `'project'` when at least one unconditional occurrence exists; `last` is the last unconditional one.
  - Otherwise `'conditional'` when only conditional occurrences exist.
  - Otherwise `'inherited'`.
  - `duplicates` is true when there is more than one unconditional occurrence.
- Hand-written scanner. It skips comments, `<?xml?>` and CDATA, and only looks at direct children of top-level `PropertyGroup` elements. A `PropertyGroup` inside a `Choose`/`When` counts as conditional.

- [ ] **Step 1: Write failing tests**:
  - `finds a simple property with exact offsets`: `xml.slice(o.start, o.end) === '<Nullable>enable</Nullable>'`;
  - `marks properties in a Condition group as conditional`;
  - `marks an element with its own Condition as conditional`;
  - `ignores commented-out properties`;
  - `handles self-closing <Nullable />` with `rawValue ''` and `selfClosing true`;
  - `decodes &amp; in value but keeps rawValue`;
  - `detects CRLF and BOM files without shifting offsets`, where offsets index the string including U+FEFF;
  - `originOf returns last unconditional and duplicates`;
  - `PropertyGroup inside Choose/When is conditional`;
  - `records group indent and child indent` for tab- and 2-space-indented files.
- [ ] **Step 2:** Run `npm run test:unit -- test/unit/properties/csprojScan.test.ts`. Expected: FAIL, module not found.
- [ ] **Step 3:** Implement `scanCsproj` and `originOf`.
- [ ] **Step 4:** Run the test. Expected: PASS.
- [ ] **Step 5:** Commit `feat: scan csproj property elements with offsets`.

### Task 3: `.csproj` property editor

**Files:**
- Create: `src/properties/csprojEdit.ts`
- Test: `test/unit/properties/csprojEdit.test.ts`, `test/fixtures/properties/*.csproj`. These are real files: one `dotnet new webapi` csproj, plus one hand-made file with a BOM, CRLF, tabs, comments, a Condition group and attributes. Add `test/fixtures/properties/*.csproj -text` to `.gitattributes`.

**Interfaces:**
- Consumes: `scanCsproj`, `originOf` (Task 2).
- Produces:
  ```ts
  export type PropertyEdit =
    | { kind: 'set'; name: string; value: string }
    | { kind: 'remove'; name: string }
    | { kind: 'targetFrameworks'; tfms: string[] }; // 1 → TargetFramework, >1 → TargetFrameworks; removes the other one
  export class PropertyEditError extends Error { code: 'conditional' | 'postcondition' | 'invalidName' }
  export function applyPropertyEdits(xml: string, edits: PropertyEdit[]): string;
  ```
- Rules:
  - **`set` on an existing `'project'` property:** replace the value range of the last unconditional occurrence. A self-closing element becomes `<X>v</X>`, keeping its attributes.
  - **`set` on an `'inherited'` property:** append `<childIndent><X>v</X><eol>` before the close tag of the **first** unconditional group.
  - **No unconditional group:** insert `<eol><indent><PropertyGroup><eol><childIndent><X>v</X><eol><indent></PropertyGroup>` right after `projectOpenEnd`. Use the indentation found in the file, or 2 spaces.
  - **`set` on a `'conditional'`-only property:** throw `PropertyEditError('conditional')`.
  - **`remove`:** delete the last unconditional occurrence, together with its leading whitespace back to the previous newline and its line break. If the property isn't there, do nothing.
  - **Escaping:** encode `&`, `<` and `>` in values.
  - **Names:** validate against `/^[A-Za-z_][A-Za-z0-9_.-]*$/`.
  - **Postcondition:** rescan the output. Every edited name must have the intended effective unconditional value (or be absent after `remove`). Every other occurrence must have the same `rawValue`, and its text must be identical. Otherwise throw `PropertyEditError('postcondition')`.

- [ ] **Step 1: Write failing tests**:
  - `set existing changes only that element`: the output equals the input with exactly that substring replaced;
  - `set inherited appends to first unconditional group with matching indent and CRLF`;
  - `set when no unconditional group creates one after <Project>`;
  - `set on conditional-only throws conditional`;
  - `remove deletes the element and its line`;
  - `targetFrameworks with 2 tfms replaces TargetFramework by TargetFrameworks` (`net8.0;net10.0`);
  - `targetFrameworks with 1 tfm on a multi-target project goes back to TargetFramework`;
  - `escapes & < >`;
  - `self-closing element becomes element with value`;
  - `BOM, comments and Condition groups of the hand-made fixture stay byte-identical outside the edit`. Compare prefix and suffix around the edit offsets;
  - `rejects invalid property names`.
- [ ] **Step 2:** Run the test. Expected: FAIL.
- [ ] **Step 3:** Implement `applyPropertyEdits`. Apply the edits in descending offset order on one original scan, then run the postcondition.
- [ ] **Step 4:** Run the test. Expected: PASS.
- [ ] **Step 5:** Commit `feat: minimal csproj property editor with postconditions`.

### Task 4: Properties schema, model and save flow

**Files:**
- Create: `src/properties/schema.ts`, `src/properties/model.ts`
- Test: `test/unit/properties/schema.test.ts`, `test/unit/properties/model.test.ts`, `test/integration/properties.int.test.ts` (real SDK 8; add it to `test:cli`).

**Interfaces:**
- Consumes: `getProperties` (Task 1), `writeTextAtomically` (Task 1), `scanCsproj`/`originOf` (Task 2), `applyPropertyEdits` (Task 3), `toIdentifier` from `src/solution/naming.ts`.
- Produces:
  ```ts
  // schema.ts
  export type FieldKind = 'text' | 'bool' | 'choice' | 'tfms' | 'list'; // list = ';'-separated
  export interface FieldDef { property: string; section: SectionId; kind: FieldKind; label: string; choices?: string[]; validate?: (v: string) => string | undefined /* l10n key or undefined */ }
  export type SectionId = 'application' | 'build' | 'package' | 'assembly' | 'debug' | 'secrets';
  export const FIELDS: FieldDef[];   // exactly the properties listed in spec §2.1, in that order
  export const ALL_PROPERTIES: string[]; // FIELDS.map(f => f.property) plus 'TargetFrameworks'
  export function validateTfm(v: string): string | undefined;      // /^(net\d+\.\d+(-[a-z]+(\d+(\.\d+)*)?)?|netstandard\d\.\d|netcoreapp\d\.\d|net\d{2,3})$/
  export function validateVersion(v: string): string | undefined;  // SemVer 2 or a.b[.c[.d]]
  export function validateIdentifierPath(v: string): string | undefined; // each dot segment === toIdentifier(segment), no '@'
  // model.ts
  export interface FieldState { property: string; evaluated: string; raw?: string; origin: PropertyOrigin; duplicates: boolean }
  export interface PropertiesModel { projectPath: string; text: string; fields: FieldState[]; readOnly: boolean; error?: string }
  export interface PropertiesDeps { readText(p: string): Promise<string>; getProperties(p: string, names: string[]): Promise<Record<string, string>>; writer: Omit<TextWriterDeps, 'validate'> }
  export async function loadProperties(projectPath: string, deps: PropertiesDeps): Promise<PropertiesModel>;
  export async function saveProperties(model: PropertiesModel, edits: PropertyEdit[], deps: PropertiesDeps): Promise<PropertiesModel>;
  ```
- `loadProperties` reads the text and scans it, then evaluates `ALL_PROPERTIES`. TargetFramework(s) is one field of kind `'tfms'`, shown from `TargetFrameworks` when that is set and from `TargetFramework` otherwise. If evaluation throws, return `readOnly: true` with `error`, and leave every `evaluated` value at `''`. Never fill those values from the XML.
- `saveProperties` computes `applyPropertyEdits(model.text, edits)`. It then calls `writeTextAtomically` with `expectedOriginal = model.text`. Its `validate` re-evaluates the edited names and throws when one doesn't match:
  - `set` must give exactly the value;
  - `remove` must give an origin that is no longer `'project'` after a rescan;
  - `targetFrameworks` must give the joined list.

  On success it returns a freshly loaded model.

- [ ] **Step 1: Write failing tests**:
  - `FIELDS covers spec sections in order` (a snapshot of `property` names per section);
  - `validateTfm accepts net8.0 net10.0 netstandard2.0 net8.0-ios17.0 rejects net8 and 8.0`;
  - `validateVersion accepts 1.2.3 1.2.3-beta.1 1.2.3.4 rejects 1.x`;
  - `loadProperties marks Nullable inherited when absent from csproj but evaluated`;
  - `loadProperties goes readOnly with error and empty values when evaluation throws`;
  - `saveProperties refuses when file changed on disk` (`ChangedOnDiskError`, nothing written);
  - `saveProperties restores original when validation value mismatches`.
- [ ] **Step 2:** Write `properties.int.test.ts` against SDK 8:
  - a temp dir whose name has a space and `#`;
  - `dotnet new console`, plus a `Directory.Build.props` that sets `Nullable`;
  - test `set LangVersion, then remove it`: after each save, `dotnet msbuild -getProperty` agrees and `dotnet build` exits 0;
  - test `TargetFramework → TargetFrameworks net8.0;net10.0 builds`. Use the SDK 10 at `$HOME/.dotnet` and skip with a message if net10 is not installed.
- [ ] **Step 3:** Implement. Run the unit tests and `npm run test:cli`. Expected: PASS.
- [ ] **Step 4:** Commit `feat: project properties model with validated save`.

### Task 5: Properties panel host (controller, panel, command, menu)

**Files:**
- Create: `src/properties/protocol.ts`, `src/properties/controller.ts`, `src/properties/PropertiesPanel.ts`, `src/properties/commands.ts`
- Modify: `src/extension.ts`, `package.json` (command, `view/item/context` entry `"when": "viewItem =~ /^cw\\.project(\\.|$)/"`, `"group": "9_properties@1"`, commandPalette entry), `package.nls.json`, `l10n/bundle.l10n.json`, `esbuild.mjs` (second webview entry `src/webview/properties/main.ts` → `dist/webview/properties.js`, `properties.css`)
- Test: `test/unit/properties/controller.test.ts`, `test/unit/solution/menus.test.ts` (extend)

**Interfaces:**
- Consumes: `loadProperties`, `saveProperties`, `PropertyEdit`, `FIELDS`.
- Produces:
  ```ts
  // protocol.ts
  export type PropsToHost =
    | { type: 'ready' } | { type: 'save'; edits: PropertyEdit[] } | { type: 'reload' }
    | { type: 'dirty'; dirty: boolean } | { type: 'openCsproj'; property: string }
    | { type: 'manageSecrets' } | { type: 'profiles'; action: ProfileAction }; // ProfileAction from Task 7
  export type PropsToWebview =
    | { type: 'loading' } | { type: 'model'; model: PropertiesModel; labels: Record<string, string> }
    | { type: 'saved' } | { type: 'error'; message: string }
    | { type: 'changedOnDisk' } | { type: 'profilesModel'; model: LaunchProfilesView }; // Task 8
  // controller.ts
  export class PropertiesController {
    constructor(projectPath: string, deps: PropertiesDeps & { post(m: PropsToWebview): void; onSecrets(): void; openAt(property: string): void; t(key: string, ...a: string[]): string });
    handle(m: PropsToHost): Promise<void>;
    onFileChanged(): void;    // dirty → post changedOnDisk; clean → reload silently
    get dirty(): boolean;
  }
  ```
- One panel per project path, through a `Map` in `commands.ts`. Reopening reveals the existing panel.
- Title: `l10n.t('{0} Properties', projectName)`.
- A `FileSystemWatcher` on the project file calls `controller.onFileChanged`.
- On close with `dirty`, show a modal with Save / Don't Save. The VS Code API cannot cancel a webview close, so a "Save" choice runs the save and keeps the changes, using `retainContextWhenHidden`.
- `Cmd+S`: a keybinding for `csharpWorkbench.projectProperties.save` with `when: activeWebviewPanelId == 'csharpWorkbench.properties'`.

- [ ] **Step 1: Write failing tests**:
  - `ready posts loading then model`;
  - `save posts saved and a reloaded model`;
  - `save with ChangedOnDiskError posts changedOnDisk and does not write`;
  - `onFileChanged while dirty posts changedOnDisk, while clean reloads`;
  - `readOnly model rejects save` (error posted, nothing written);
  - in `menus.test.ts`, `Properties appears for cw.project and cw.project.startup but not cw.projectRef`.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement the controller, panel (HTML/CSP like `NugetPanel`), command, menu, keybinding and esbuild entry. For now, the webview entry is a stub that posts `ready`.
- [ ] **Step 4:** Run the tests, `npx tsc --noEmit` and `npm run build`. Expected: PASS, with `dist/webview/properties.js` produced.
- [ ] **Step 5:** Commit `feat: project properties panel host and command`.

### Task 6: Properties webview UI

**Files:**
- Create: `src/webview/properties/main.ts`, `src/webview/properties/views/form.ts`, `src/webview/properties/properties.css`
- Test: `test/unit/webview/properties.test.ts` (happy-dom)

**Interfaces:**
- Consumes: `PropsToHost`, `PropsToWebview`, `FIELDS`, the validators (Task 4).
- Produces: `renderProperties(root: HTMLElement, model: PropertiesModel, labels: Record<string,string>, send: (m: PropsToHost) => void): { collectEdits(): PropertyEdit[] }`
- Layout: a left nav with the sections in spec order and a right form. Each field gets a badge:
  - "inherited", with a **Reset** button that becomes `remove`;
  - "set per configuration", read-only, with an **Open in .csproj** link;
  - "duplicate".
- **Field controls:**
  - `bool`: a checkbox mapped to `true`/`false`.
  - `choice`: a select, plus free text for `LangVersion`.
  - `tfms`: chips and an input; changing it emits one `targetFrameworks` edit.
  - `list`: a text field with `;` separators.
- **Edits:** only fields whose value changed emit edits. An empty text on a `'project'` field becomes `remove`.
- **Validation:** an invalid value shows the message under the field and disables Save.
- **Dirty state:** posts `dirty` on every change.
- **Read-only model:** shows a banner with the error, and every control is disabled.
- **Debug section:** a placeholder until Task 8.
- **Secrets section:** a button that sends `manageSecrets`.

- [ ] **Step 1: Write failing tests**:
  - `renders sections in order`;
  - `changing Nullable emits set edit and dirty true`;
  - `Reset on inherited override emits remove`;
  - `conditional field is disabled with Open in .csproj`;
  - `invalid TFM disables Save and shows message`;
  - `read-only model disables all inputs and shows banner`;
  - `two TFMs emit one targetFrameworks edit`.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement. Reuse `src/webview/chrome.ts` helpers and theme CSS variables.
- [ ] **Step 4:** Run the tests and `npm run build`. Expected: PASS.
- [ ] **Step 5:** Commit `feat: project properties webview`.

### Task 7: Launch settings store

**Files:**
- Create: `src/launch/launchSettings.ts`
- Modify: `package.json` dependencies (`jsonc-parser`, latest 3.x)
- Test: `test/unit/launch/launchSettings.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface LaunchProfile { name: string; commandName: string; supported: boolean; commandLineArgs?: string; workingDirectory?: string; environmentVariables: Record<string, string>; applicationUrl?: string; launchBrowser?: boolean; launchUrl?: string; executablePath?: string }
  export function launchSettingsPath(projectPath: string): string;         // <dir>/Properties/launchSettings.json
  export function parseProfiles(text: string | undefined): LaunchProfile[]; // never throws; non-object entries skipped
  export type ProfileAction =
    | { kind: 'new'; name: string; commandName: 'Project' | 'Executable' } | { kind: 'duplicate'; from: string; name: string }
    | { kind: 'rename'; from: string; name: string } | { kind: 'delete'; name: string }
    | { kind: 'set'; name: string; field: keyof Omit<LaunchProfile, 'name' | 'supported' | 'environmentVariables'>; value: string | boolean | undefined }
    | { kind: 'env'; name: string; env: Record<string, string> };
  export class ProfileError extends Error { code: 'exists' | 'missing' | 'emptyName' }
  export function applyProfileAction(text: string | undefined, action: ProfileAction): string; // text undefined → creates {"profiles":{}}
  ```
- `supported` is `commandName === 'Project' || commandName === 'Executable'`.
- Edits use `jsonc-parser` `modify` + `applyEdits`, with `formattingOptions` detected from the file (tabs or spaces, size, EOL).
- `rename` must keep the profile's position. Rebuild the `profiles` object through a single `modify` of the `profiles` value only when the name changes. A comment that sits inside the renamed profile may be lost; document that in a code comment.
- Writing goes through `writeTextAtomically` in Task 8's adapter, not here.

- [ ] **Step 1: Write failing tests**:
  - `parses Project, Executable and IISExpress with supported flags`;
  - `tolerates comments and trailing commas`;
  - `undefined, {} and {"profiles":5} give []`;
  - `new on undefined creates file text with profile`;
  - `set keeps comments elsewhere byte-identical`;
  - `env replaces environmentVariables`;
  - `rename keeps order and rejects existing name`;
  - `delete removes only that profile`;
  - `profile names with spaces and non-ASCII round-trip`.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** `npm install jsonc-parser@^3`, then implement.
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5:** Commit `feat: launch settings store with minimal edits`.

### Task 8: Launch profiles in the Debug section, active profile, Run/Debug integration

**Files:**
- Create: `src/launch/activeProfile.ts`, `src/webview/properties/views/profiles.ts`
- Modify:
  - `src/solution/runCore.ts`, `src/solution/commands/run.ts`;
  - `src/properties/controller.ts`, `protocol.ts`;
  - `src/solution/treeCore.ts` or `tree.ts` (startup node description);
  - `package.json` (`csharpWorkbench.selectLaunchProfile` on `cw.project.startup` and the palette), `package.nls.json`, `l10n/bundle.l10n.json`.
- Test: `test/unit/launch/activeProfile.test.ts`, `test/unit/solution/run.test.ts` (extend), `test/unit/properties/controller.test.ts` (extend), `test/unit/webview/profiles.test.ts`

**Interfaces:**
- Consumes: `LaunchProfile`, `parseProfiles`, `applyProfileAction`, `launchSettingsPath` (Task 7), `writeTextAtomically` (Task 1), `Memento` (`src/solution/state.ts`).
- Produces:
  ```ts
  // activeProfile.ts
  export const getActiveProfileName = (ws: Memento, projectPath: string): string | undefined;   // key `cw.launchProfile:${projectPath}`
  export const setActiveProfileName = (ws: Memento, projectPath: string, name: string | undefined): PromiseLike<void>;
  export function resolveActiveProfile(profiles: LaunchProfile[], stored: string | undefined): LaunchProfile | undefined; // stored if exists and supported, else first supported
  // runCore.ts
  export function dotnetTask(kind: TaskKind, target: string, _dotnet: string, tfm?: string, launchProfile?: string): { name: string; args: string[] }; // run adds ['--launch-profile', name]
  export function expandEnv(value: string, env: Record<string, string | undefined>): string; // %VAR% and $VAR / ${VAR}; unknown → ''
  export function debugConfigFor(projectPath: string, targetPath: string, name: string, profile?: LaunchProfile, env?: Record<string, string | undefined>): object;
  // LaunchProfilesView (protocol): { profiles: LaunchProfile[]; active?: string; path: string; exists: boolean }
  ```
- **`debugConfigFor` with a profile:**
  - `args` = `commandLineArgs` split like a shell, honouring quotes, with no expansion;
  - `env` = `environmentVariables` with `expandEnv` applied, plus `ASPNETCORE_URLS: applicationUrl` for Project profiles with a URL;
  - `cwd` = `workingDirectory` (expanded, relative to the project dir), or the project dir when there is none;
  - with `launchBrowser`: `serverReadyAction: { action: 'openExternally', pattern: '\\bNow listening on:\\s+(https?://\\S+)', uriFormat: '%s/' + (launchUrl ?? '') }`;
  - Executable profiles: `program` = expanded `executablePath`.
- Without a profile, the output is exactly as before (existing tests stay green).
- **The dynamic `DebugConfigurationProvider`** returns one entry per supported profile of the startup project, named `C# Workbench: <project> (<profile>)`. It keeps today's entry when there are no profiles.
- **Run** passes `--launch-profile` only when a profile resolves.
- **`selectLaunchProfile`** shows a QuickPick of supported profiles, plus unsupported ones disabled with the description "not supported on this system". It stores the choice and refreshes the tree. The startup node description becomes `<profile>`.
- **The controller** handles `{type:'profiles'}`. It applies the action and writes atomically, with `expectedOriginal` set to the text it loaded (`''` when the file is absent). It creates `Properties/` when needed, then posts `profilesModel`. A `delete` asks for confirmation through `confirmAction`.

- [ ] **Step 1: Write failing tests**:
  - `resolveActiveProfile falls back to first supported when stored was deleted`;
  - `dotnetTask run adds --launch-profile with names containing spaces as one arg`;
  - `debugConfigFor sets env, ASPNETCORE_URLS, args, cwd and serverReadyAction`;
  - `debugConfigFor without profile is unchanged` (deep-equal with the old output);
  - `expandEnv expands %HOME% $HOME ${HOME}`;
  - `Executable profile uses executablePath as program`;
  - controller: `profiles new on missing file creates Properties/launchSettings.json`, and `delete asks confirmation`;
  - webview: `selecting a profile shows its fields`, `editing env table emits env action`, `unsupported profile is read-only`.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npm run test:unit`, `npx tsc --noEmit` and `npm run build`. Expected: PASS.
- [ ] **Step 5:** Commit `feat: launch profiles editor and run/debug with the active profile`.

### Task 9: C# tokenizer

**Files:**
- Create: `src/sync/csTokens.ts`
- Test: `test/unit/sync/csTokens.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface NsDecl { name: string; nameStart: number; nameEnd: number; fileScoped: boolean; depth: number } // depth 0 = top level
  export interface UsingDirective { name: string; nameStart: number; nameEnd: number; isGlobal: boolean; isStatic: boolean; alias?: string; start: number; end: number; inNamespace: boolean }
  export interface QualifiedName { text: string; start: number; end: number } // dotted identifier chains in code (not in using/namespace lines)
  export interface CsFileInfo { namespaces: NsDecl[]; usings: UsingDirective[]; typeNames: string[] /* top-level types per namespace */; qualified: QualifiedName[]; hasPreprocessorAroundNamespace: boolean }
  export function analyzeCs(text: string): CsFileInfo;
  ```
- The tokenizer skips these, in this order of precedence:
  - `//` and `/* */` comments;
  - `"…"` strings with escapes;
  - verbatim `@"…"` with `""`;
  - interpolated `$"…{expr}…"`, where the code inside `{}` is still tokenized and nested strings in it are handled;
  - `$@`/`@$` strings;
  - raw `"""…"""` strings with any quote count, including `$"""` with multiple `$`;
  - char literals.
- Preprocessor lines (`#…`) are skipped. `hasPreprocessorAroundNamespace` is true when a `#if` is open at a top-level namespace declaration.
- `typeNames` holds the names of top-level `class|struct|interface|enum|record|delegate` declarations, directly in a namespace.

- [ ] **Step 1: Write failing tests**:
  - `file-scoped namespace with offsets`;
  - `block namespace and nested namespace depth`;
  - `namespace text inside // /* */ "…" @"…" $"…" and """…""" is ignored`;
  - `interpolation holes are code`, where `$"{Foo.Bar.Baz}"` reports a qualified `Foo.Bar.Baz`;
  - `using, global using, using static, using alias = X.Y`;
  - `type names of top-level types`;
  - `#if around namespace sets flag`;
  - `qualified names exclude using and namespace lines`.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement as a single-pass scanner with a mode stack.
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5:** Commit `feat: c# tokenizer for namespace sync`.

### Task 10: Sync Namespaces planner

**Files:**
- Create: `src/sync/plan.ts`
- Test: `test/unit/sync/plan.test.ts`

**Interfaces:**
- Consumes: `analyzeCs` (Task 9), `namespaceFor` (`src/solution/naming.ts`).
- Produces:
  ```ts
  export interface SyncInputFile { path: string; text: string; projectDir: string; rootNamespace: string; inScope: boolean } // inScope = belongs to a project being synced (not linked, not obj/)
  export interface TextEdit { start: number; end: number; newText: string }
  export interface SyncPlan { edits: Map<string, TextEdit[]>; skipped: { path: string; reason: 'noNamespace' | 'multipleNamespaces' | 'nested' | 'preprocessor' }[]; moves: { from: string; to: string; types: string[] }[] }
  export function planSync(files: SyncInputFile[]): SyncPlan; // files = every .cs of the solution; only inScope files get declaration edits
  ```
- **Declaration edits.** For each in-scope file with exactly one top-level namespace, no nesting and no preprocessor flag, compute `expected = namespaceFor(rootNamespace, projectDir, dirname(path))`. When `name !== expected`, replace `[nameStart, nameEnd)` and record a move `{from: name, to: expected, types: typeNames}`. Other in-scope files go to `skipped`.
- **Reference edits**, applied to every file in `files`, including out-of-scope ones:
  - After the moves, an old namespace is **gone** when no file, edited or not, still declares it.
  - For `using Old;`, ignoring aliases and statics: when `Old` is gone, replace the name with the first target and insert `using <Target>;` lines after it for the other targets, keeping the directive's indentation, `global` prefix and EOL. When `Old` still exists, insert `using <Target>;` after it for each target that is not already imported.
  - For a qualified name `Old.Type…` whose prefix is a moved namespace and whose next segment is a moved type, replace that prefix with the type's new namespace.
  - A file that itself declares a target namespace doesn't get a `using` for it.
- Edits within one file never overlap and are sorted by start.

- [ ] **Step 1: Write failing tests**:
  - `moved file gets new file-scoped namespace` (`MyApp.Models` → `MyApp.Domain`, `Customer` in `Domain/`);
  - `block namespace keeps braces`;
  - `using of gone namespace is replaced`;
  - `using of still-existing namespace gets an added using`;
  - `qualified MyApp.Models.Customer becomes MyApp.Domain.Customer`;
  - `files with two namespaces, nested, #if, none are skipped with reasons`;
  - `out-of-scope files only get reference edits`;
  - `folder named 2D and class keyword folder use namespaceFor sanitising` (`MyApp._2D`, `MyApp.@class`);
  - `no change when already in sync gives empty plan`.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5:** Commit `feat: sync namespaces planner`.

### Task 11: Sync Namespaces command

**Files:**
- Create: `src/sync/command.ts`
- Modify: `src/extension.ts`, `package.json` (command `csharpWorkbench.syncNamespaces` on `viewItem =~ /^cw\\.(project(\\.|$)|solution$)/`, group `8_sync@1`; palette), `package.nls.json`, `l10n/bundle.l10n.json`
- Test: `test/unit/sync/command.test.ts` (pure helper `toWorkspaceEditSpec`), `test/unit/solution/menus.test.ts` (extend)

**Interfaces:**
- Consumes: `planSync` (Task 10), project items (`loadProjectItems`, v2), `ProjectInfoData.rootNamespace`, the tree core's solution model, `dotnetTask('build', …)` and the v2 task runner.
- Produces:
  - `toWorkspaceEditSpec(plan: SyncPlan, texts: Map<string,string>): { path: string; range: { startLine: number; startCol: number; endLine: number; endCol: number }; newText: string; label: string }[]`. It converts offsets to positions, so it handles CRLF and the BOM. The label is "Namespace declaration" or "Using directive"/"Qualified name".
  - The command builds a `vscode.WorkspaceEdit`. Every entry carries `WorkspaceEditEntryMetadata { needsConfirmation: true, label }`. It applies the edit with `vscode.workspace.applyEdit(edit, { isRefactoring: true })`, which opens the refactor preview.
- **Scope.** On a project node, only that project is in scope. On the solution node, every project is in scope. Every project of the solution feeds reference edits.
- **Excluded files:** linked items, items outside the project dir, and `obj/`/`bin/`.
- **Progress.** Reading and planning run under `withProgress` with cancellation.
- **Empty plan.** Show the info message `"Namespaces are already in sync."`.
- **After apply.** Write the skipped files and their reasons to the Output channel, then show an info message with a **Build** button that runs the v2 build task.
- **Open documents.** Read text from open documents when they are dirty, and from disk otherwise.

- [ ] **Step 1: Write failing tests**:
  - `toWorkspaceEditSpec maps offsets in CRLF+BOM text to positions`;
  - `labels per edit kind`;
  - in `menus.test.ts`, `Sync Namespaces on cw.project* and cw.solution, not on folders or projectRef`.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npm run test:unit`, `npx tsc --noEmit` and `npm run build`. Expected: PASS.
- [ ] **Step 5:** Commit `feat: sync namespaces with refactor preview`.

### Task 12: End-to-end tests, docs, version

**Files:**
- Modify:
  - the `src/extension.ts` Test-mode API: add `properties: { open(projectPath), controllerFor(projectPath) }` and `sync: { plan(nodeOrPath) }`, Test mode only;
  - `test/integration/helpers/fixtures.ts`;
  - `README.md` (Project Properties, Launch Profiles, Sync Namespaces, the `.csproj` exception and its rules, limitations);
  - `CHANGELOG.md` (0.3.0);
  - `package.json` and `package-lock.json` (version `0.3.0`).
- Create: `test/integration/properties.e2e.test.ts`

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1:** Write one mocha e2e test per spec §7 criterion (1–10). Use a real SDK 8 `webapi` project with a `Directory.Build.props` setting `Nullable`, in a temp dir with a space and `#`.
  - Criteria 2, 3, 5 and 10 assert on file bytes and `dotnet msbuild -getProperty`.
  - Criterion 6 asserts on the run task's args and the debug configuration object built for the active profile. Do not start a real debug session.
  - Criterion 8 checks the plan's edits, applies them with `applyEdit` without confirmation in Test mode, and then checks that `dotnet build` exits 0.
- [ ] **Step 2:** Run `npm run test:int`. Expected: every new test plus the 18 existing ones pass.
- [ ] **Step 3:** Update the docs and the version, then run `npm run package` and paste the `vsce ls` output. Expected: `dist/webview/properties.js` is included.
- [ ] **Step 4:** Commit `test: project properties end-to-end and docs`.
