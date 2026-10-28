import { basename, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { renderCodeTemplate, type CodeKind } from '../codeTemplates';
import type { ProjectInfoData } from '../model';
import { namespaceFor, toIdentifier } from '../naming';
import { newItemArgs, type ItemTemplate, type TemplateOptions } from '../templateCatalog';

/** Pure helpers for the Add menu and file operations; no `vscode` imports. */

export const BUILT_INS: { kind: CodeKind; label: string }[] = [
  { kind: 'class', label: 'Class' }, { kind: 'interface', label: 'Interface' }, { kind: 'enum', label: 'Enum' },
  { kind: 'record', label: 'Record' }, { kind: 'struct', label: 'Struct' },
];
const BUILT_IN_SHORT = new Set<string>(BUILT_INS.map((b) => b.kind));

export type NewItemChoice =
  | { kind: 'separator'; label: string }
  | { kind: 'builtin'; label: string; code: CodeKind }
  | { kind: 'template'; label: string; description: string; shortName: string };

export function targetPathFor(folder: string, name: string, ext: string): string {
  return join(folder, name.toLowerCase().endsWith(ext.toLowerCase()) ? name : `${name}${ext}`);
}

/** Thrown instead of an English message so the glue can translate it. */
export class FileExistsError extends Error {
  readonly code = 'exists';
  constructor(readonly fileName: string) { super(`File already exists: ${fileName}`); }
}

export async function ensureNotExists(path: string, exists: (p: string) => Promise<boolean>): Promise<void> {
  if (await exists(path)) throw new FileExistsError(basename(path));
}

/** Drops every path that lies inside another path of the list (and duplicates). */
export function dedupeNested(paths: string[]): string[] {
  const uniq = [...new Set(paths)];
  return uniq.filter((p) => !uniq.some((o) => o !== p && isDescendantOrSelf(o, p)));
}

/** True when `target` is the same path as `source` ignoring case (a case-only rename). */
export function isSamePathIgnoreCase(source: string, target: string): boolean {
  return resolve(source).toLowerCase() === resolve(target).toLowerCase();
}

export function canPasteInto(sources: string[], folder: string): boolean {
  return !sources.some((s) => isDescendantOrSelf(s, folder));
}

/** VS-style clash names: `X - Copy.cs`, then `X - Copy (2).cs`. Returns `name` itself when free. */
export function copyName(existing: Set<string>, name: string): string {
  if (!existing.has(name)) return name;
  const ext = extname(name);
  const stem = name.slice(0, name.length - ext.length);
  let candidate = `${stem} - Copy${ext}`;
  for (let n = 2; existing.has(candidate); n++) candidate = `${stem} - Copy (${n})${ext}`;
  return candidate;
}

export type NameError = { code: 'empty' } | { code: 'chars' } | { code: 'exists'; name: string };

export function validateName(name: string, exists: (fileName: string) => boolean): NameError | undefined {
  if (name.trim() === '') return { code: 'empty' };
  if (/[/\\:*?"<>|]/.test(name)) return { code: 'chars' };
  if (exists(name)) return { code: 'exists', name };
  return undefined;
}

type ProjectLookup = { projectForPath(p: string): { path: string } | undefined };

export function isSameProject(core: ProjectLookup, a: string, b: string): boolean {
  const pa = core.projectForPath(a);
  return !!pa && pa.path === core.projectForPath(b)?.path;
}

export function isDescendantOrSelf(dir: string, p: string): boolean {
  const r = relative(dir, p);
  return r === '' || (!r.startsWith('..') && !isAbsolute(r));
}

/** Returns an error message when dropping `sources` onto the folder `target` is not allowed. */
export function validateDrop(core: ProjectLookup, sources: string[], target: string): string | undefined {
  if (sources.some((s) => !isSameProject(core, s, target))) return 'Files can only be moved within the same project.';
  if (sources.some((s) => isDescendantOrSelf(s, target))) return 'A folder cannot be moved into itself.';
  return undefined;
}

export function newItemChoices(catalog: ItemTemplate[]): NewItemChoice[] {
  const templates = catalog
    .filter((t) => (t.languages.length === 0 || t.languages.includes('C#')) && !t.shortNames.some((s) => BUILT_IN_SHORT.has(s)))
    .sort((a, b) => a.name.localeCompare(b.name));
  return [
    { kind: 'separator', label: 'Code' },
    ...BUILT_INS.map((b): NewItemChoice => ({ kind: 'builtin', label: b.label, code: b.kind })),
    { kind: 'separator', label: 'Templates' },
    ...templates.map((t): NewItemChoice => ({
      kind: 'template', label: t.name, description: t.shortNames.join(', '), shortName: t.shortNames[0],
    })),
  ];
}

export interface BuiltInDeps { exists(p: string): Promise<boolean>; write(p: string, content: string): Promise<void> }

export async function createBuiltIn(
  deps: BuiltInDeps, kind: CodeKind, name: string, folder: string, projectDir: string, info: ProjectInfoData,
): Promise<string> {
  const file = targetPathFor(folder, name, '.cs');
  await ensureNotExists(file, deps.exists);
  const ns = namespaceFor(info.rootNamespace, projectDir, folder);
  await deps.write(file, renderCodeTemplate(kind, toIdentifier(name.replace(/\.cs$/i, '')), ns, info.fileScopedNamespaces));
  return file;
}

export interface CatalogDeps {
  cli: { newTemplate(shortName: string, args: string[], cwd: string): Promise<void> };
  options(shortName: string): Promise<TemplateOptions>;
  /** Files currently under `dir` (recursive). */
  listFiles(dir: string): Promise<string[]>;
}

/** Runs `dotnet new` and returns the files that did not exist before. */
export async function createFromCatalog(
  deps: CatalogDeps, shortName: string, name: string, folder: string, ns: string, projectPath: string,
): Promise<string[]> {
  const before = new Set(await deps.listFiles(folder));
  const opts = await deps.options(shortName);
  await deps.cli.newTemplate(shortName, newItemArgs(name, folder, ns, projectPath, opts), folder);
  return (await deps.listFiles(folder)).filter((f) => !before.has(f));
}

