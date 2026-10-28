// Solution-folder edits: the single, user-approved exception to "only through the dotnet CLI".
// Every function is pure and returns the whole new file text. Edits are targeted text changes:
// every byte outside the edited lines (BOM, line endings, indentation, comments) is kept as is.
import { XMLValidator } from 'fast-xml-parser';
import type { SolutionFolder, SolutionModel, SolutionProject } from './model';
import { parseSln, parseSlnx } from './slnParse';

type Kind = SolutionModel['kind'];

const FOLDER_TYPE = '{2150E333-8FDC-42A3-9474-1A3956D46DE8}';
const INVALID_CHARS = /[/\\:*?"<>|\x00-\x1f]/;
const NOT_EMPTY = 'Solution folder is not empty';
const NOT_FOUND = 'Solution folder not found';

/** Returns an error message, or undefined when `name` is a valid new name among `siblingNames`. */
export function validateFolderName(name: string, siblingNames: readonly string[] = []): string | undefined {
  if (name.trim() === '') return 'Name cannot be empty.';
  if (INVALID_CHARS.test(name)) return 'Name contains invalid characters.';
  const lower = name.toLowerCase();
  if (siblingNames.some((s) => s.toLowerCase() === lower)) return 'A solution folder with this name already exists.';
  return undefined;
}

function assertValidName(name: string, siblingNames: readonly string[]): void {
  const error = validateFolderName(name, siblingNames);
  if (error) throw new Error(error);
}

/** The single intended change of an edit, used to check its result. */
export type FolderChange =
  | { op: 'add'; id: string; name: string; parentId?: string }
  | { op: 'rename'; id: string; newName: string }
  | { op: 'remove'; id: string };

export function addFolder(text: string, kind: Kind, name: string, parentId: string | undefined, newGuid: () => string): string {
  const [out, id] = kind === 'sln' ? slnAdd(text, name, parentId, newGuid) : slnxAdd(text, name, parentId);
  assertFolderEdit(kind, text, out, { op: 'add', id, name, parentId });
  return out;
}

export function renameFolder(text: string, kind: Kind, id: string, newName: string): string {
  const out = kind === 'sln' ? slnRename(text, id, newName) : slnxRename(text, id, newName);
  assertFolderEdit(kind, text, out, { op: 'rename', id, newName });
  return out;
}

export function removeEmptyFolder(text: string, kind: Kind, id: string): string {
  const out = kind === 'sln' ? slnRemove(text, id) : slnxRemove(text, id);
  assertFolderEdit(kind, text, out, { op: 'remove', id });
  return out;
}

// ---------------------------------------------------------------------------------------------
// Postconditions. `dotnet sln list` accepts many structurally broken .sln files, so every edit
// is checked here before anything is written:
// 1. the re-parsed model equals the old one plus or minus exactly the intended folder (every
//    other folder keeps its name and parent, every project keeps its folder);
// 2. the edit introduces no structural problem (sln: Project/EndProject balance, Global/EndGlobal,
//    NestedProjects GUIDs that resolve, ...; slnx: well-formed XML, unique folder names).
// Problems already present in the original file are tolerated; new ones are not.

const CHECK_FAILED = 'Solution folder edit failed its consistency check';

export function assertFolderEdit(kind: Kind, before: string, after: string, change: FolderChange): void {
  const parse = (t: string) => (kind === 'sln' ? slnModel(t) : parseSlnx(t, '/solution.slnx'));
  let actual: SolutionModel;
  try {
    actual = parse(after);
  } catch (e) {
    throw new Error(`${CHECK_FAILED}: ${e instanceof Error ? e.message : String(e)}`);
  }
  const expected = expectedModel(kind, parse(before), change);
  const folderKey = (f: SolutionFolder) => `folder ${f.id} "${f.name}" in ${f.parentId ?? '/'}`;
  const projectKey = (p: SolutionProject) => `project ${p.path} (${p.name}, ${p.typeGuid ?? ''}) in ${p.folderId ?? '/'}`;
  const keys = (m: Pick<SolutionModel, 'folders' | 'projects'>) =>
    [...m.folders.map(folderKey), ...m.projects.map(projectKey)].sort();
  const want = keys(expected);
  const got = keys(actual);
  if (want.join('\n') !== got.join('\n')) {
    const missing = want.filter((k) => !got.includes(k));
    const extra = got.filter((k) => !want.includes(k));
    throw new Error(`${CHECK_FAILED}: missing [${missing.join('; ')}], unexpected [${extra.join('; ')}]`);
  }
  const problems = kind === 'sln' ? slnProblems : slnxProblems;
  const old = problems(before);
  const added = [...problems(after)].filter((p) => !old.has(p));
  if (added.length) throw new Error(`${CHECK_FAILED}: ${added.join('; ')}`);
}

function expectedModel(kind: Kind, m: SolutionModel, change: FolderChange): Pick<SolutionModel, 'folders' | 'projects'> {
  const folders = m.folders.map((f) => ({ ...f }));
  let projects = m.projects.map((p) => ({ ...p }));
  if (change.op === 'add') {
    if (kind === 'sln') {
      folders.push(withParent({ id: change.id, name: change.name }, change.parentId?.toUpperCase()));
    } else {
      const target = toSegs(change.id);
      for (let i = 1; i <= target.length; i++) {
        const segs = target.slice(0, i);
        if (folders.some((f) => sameSegs(toSegs(f.id), segs))) continue;
        folders.push(withParent({ id: toPath(segs), name: segs[i - 1] }, i > 1 ? toPath(segs.slice(0, -1)) : undefined));
      }
    }
    return { folders, projects };
  }
  if (change.op === 'remove') {
    const key = kind === 'sln' ? change.id.toUpperCase() : change.id;
    return { folders: folders.filter((f) => f.id !== key), projects };
  }
  if (kind === 'sln') {
    const key = change.id.toUpperCase();
    return { folders: folders.map((f) => (f.id === key ? { ...f, name: change.newName } : f)), projects };
  }
  const old = toSegs(change.id);
  const prefix = [...old.slice(0, -1), change.newName];
  const move = (id: string | undefined): string | undefined => {
    if (id === undefined) return undefined;
    const segs = toSegs(id);
    return startsWith(segs, old) ? toPath([...prefix, ...segs.slice(old.length)]) : id;
  };
  const renamed = folders.map((f) => {
    const segs = toSegs(f.id);
    if (!startsWith(segs, old)) return f;
    const id = move(f.id)!;
    return withParent({ id, name: toSegs(id).pop()! }, move(f.parentId));
  });
  projects = projects.map((p) => withFolder(p, move(p.folderId)));
  return { folders: renamed, projects };
}

function withParent(f: SolutionFolder, parentId: string | undefined): SolutionFolder {
  return parentId === undefined ? { id: f.id, name: f.name } : { id: f.id, name: f.name, parentId };
}

function withFolder(p: SolutionProject, folderId: string | undefined): SolutionProject {
  const { folderId: _, ...rest } = p;
  return folderId === undefined ? rest : { ...rest, folderId };
}

/** Structural problems of a .sln, as stable strings so the sets of two versions can be compared. */
function slnProblems(text: string): Set<string> {
  const problems = new Set<string>();
  const trimmed = splitLines(text).map((l) => bare(l).trim());
  const guids = new Map<string, string>(); // project GUID -> type GUID
  let open = false;
  let global = 0;
  let endGlobal = -1;
  trimmed.forEach((t, i) => {
    const m = PROJECT_LINE.exec(t);
    if (/^Project\(/.test(t)) {
      if (open) problems.add('Project without EndProject');
      open = true;
      if (m) {
        const id = m[7].toUpperCase();
        if (guids.has(id)) problems.add(`duplicate GUID ${id}`);
        guids.set(id, m[2].toUpperCase());
      } else problems.add(`unreadable Project line ${t}`);
    } else if (t === 'EndProject') {
      if (!open) problems.add('EndProject without Project');
      open = false;
    } else if (t === 'Global') global++;
    else if (t === 'EndGlobal') endGlobal = endGlobal < 0 ? i : (problems.add('duplicate EndGlobal'), i);
  });
  if (open) problems.add('Project without EndProject');
  if (global !== 1) problems.add('missing or duplicate Global');
  if (endGlobal < 0) problems.add('missing EndGlobal');
  else if (trimmed.slice(endGlobal + 1).some((t) => t !== '')) problems.add('content after EndGlobal');

  const parents = new Map<string, string>();
  let sections = 0;
  for (let i = 0; i < trimmed.length; i++) {
    if (!/^GlobalSection\(NestedProjects\)/.test(trimmed[i])) continue;
    sections++;
    let j = i + 1;
    for (; j < trimmed.length && trimmed[j] !== 'EndGlobalSection'; j++) {
      if (/^(GlobalSection|EndGlobal$)/.test(trimmed[j])) break;
      const n = NESTED_LINE.exec(trimmed[j]);
      if (!n) {
        if (trimmed[j] !== '') problems.add(`unreadable nesting line ${trimmed[j]}`);
        continue;
      }
      const child = n[1].toUpperCase();
      const parent = n[2].toUpperCase();
      for (const g of [child, parent]) if (!guids.has(g)) problems.add(`nesting refers to unknown ${g}`);
      if (guids.has(parent) && guids.get(parent) !== FOLDER_TYPE) problems.add(`${child} nested under non-folder ${parent}`);
      if (parents.has(child)) problems.add(`duplicate nesting of ${child}`);
      parents.set(child, parent);
    }
    if (trimmed[j] !== 'EndGlobalSection') problems.add('unterminated NestedProjects section');
    i = j;
  }
  if (sections > 1) problems.add('multiple NestedProjects sections');
  for (const start of parents.keys()) {
    const seen = new Set<string>();
    for (let g: string | undefined = start; g !== undefined; g = parents.get(g)) {
      if (seen.has(g)) { problems.add(`nesting cycle through ${start}`); break; }
      seen.add(g);
    }
  }
  try {
    duplicateSiblings(slnModel(text).folders).forEach((d) => problems.add(d));
  } catch {
    problems.add('not a solution file');
  }
  return problems;
}

function slnxProblems(text: string): Set<string> {
  const problems = new Set<string>();
  const valid = XMLValidator.validate(text.replace(/^﻿/, ''));
  if (valid !== true) problems.add(`malformed XML: ${valid.err.msg}`);
  // The validator accepts several root elements; a solution has exactly one.
  const outside = maskComments(text.replace(/^﻿/, ''))
    .replace(/^\s*<\?xml\b[^>]*\?>/, '')
    .replace(/<Solution\b(?:[^>"']|"[^"]*"|'[^']*')*\/\s*>|<Solution\b[\s\S]*<\/Solution\s*>/, '');
  if (outside.trim() !== '') problems.add('content outside <Solution>');
  try {
    const ids = new Set<string>();
    for (const f of scanFolders(text)) {
      const id = toPath(f.segs);
      if (ids.has(id)) problems.add(`duplicate folder ${id}`);
      ids.add(id);
    }
    duplicateSiblings(parseSlnx(text, '/solution.slnx').folders).forEach((d) => problems.add(d));
  } catch (e) {
    problems.add(`unreadable: ${e instanceof Error ? e.message : String(e)}`);
  }
  return problems;
}

function duplicateSiblings(folders: SolutionFolder[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const f of folders) {
    const key = `${f.parentId ?? '/'}|${f.name.toLowerCase()}`;
    if (seen.has(key)) out.push(`duplicate folder name "${f.name}" in ${f.parentId ?? '/'}`);
    seen.add(key);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Shared text helpers

/** Lines including their own terminators, so `join('')` reproduces the text exactly. */
const splitLines = (text: string): string[] => text.split(/(?<=\n)/);
/** The line without terminator and without a leading BOM. */
const bare = (line: string): string => line.replace(/\r?\n$/, '').replace(/^﻿/, '');
const leadingWs = (line: string): string => /^[ \t]*/.exec(bare(line))![0];

/** The file's first line ending, LF when there is none. Only a fallback: edits use their anchor line's. */
function detectEol(text: string): string {
  const i = text.indexOf('\n');
  return i > 0 && text[i - 1] === '\r' ? '\r\n' : '\n';
}

/** The terminator of `line`, or `fallback` when it has none. */
const lineEol = (line: string | undefined, fallback: string): string =>
  line?.endsWith('\r\n') ? '\r\n' : line?.endsWith('\n') ? '\n' : fallback;

/** The terminator of the line that `pos` sits on. */
function eolAt(text: string, pos: number): string {
  const nl = text.indexOf('\n', pos);
  return nl < 0 ? detectEol(text) : nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
}

/** Inserts whole lines at `at`, terminating the previous line first if it had no terminator. */
function insertLines(lines: string[], at: number, eol: string, ...added: string[]): void {
  if (at > 0 && !lines[at - 1].endsWith('\n')) lines[at - 1] += eol;
  lines.splice(at, 0, ...added.map((l) => l + eol));
}

// ---------------------------------------------------------------------------------------------
// .sln

const PROJECT_LINE = /^(\s*Project\("(\{[^}]*\})"\)\s*=\s*")([^"]*)("\s*,\s*")([^"]*)("\s*,\s*"(\{[^}]*\})".*)$/s;
const NESTED_LINE = /^\s*(\{[^}]*\})\s*=\s*(\{[^}]*\})\s*$/;

const slnModel = (text: string) => parseSln(text, '/solution.sln');

function normalizeGuid(raw: string): string {
  const g = raw.trim().replace(/^\{/, '').replace(/\}$/, '').toUpperCase();
  if (!/^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/.test(g)) throw new Error(`Invalid GUID: ${raw}`);
  return `{${g}}`;
}

/** Index of the `Project(...)` line declaring solution folder `id`, or -1. */
function findFolderLine(lines: string[], id: string): number {
  return lines.findIndex((l) => {
    const m = PROJECT_LINE.exec(bare(l));
    return !!m && m[2].toUpperCase() === FOLDER_TYPE && m[7].toUpperCase() === id;
  });
}

function findLine(lines: string[], test: (trimmed: string) => boolean, from = 0): number {
  for (let i = from; i < lines.length; i++) if (test(bare(lines[i]).trim())) return i;
  return -1;
}

/** [header, end] line indexes of the NestedProjects section, or undefined. */
function nestedSection(lines: string[]): [number, number] | undefined {
  const start = findLine(lines, (t) => /^GlobalSection\(NestedProjects\)/.test(t));
  if (start < 0) return undefined;
  const end = findLine(lines, (t) => t === 'EndGlobalSection', start + 1);
  if (end < 0) throw new Error('Malformed solution file: unterminated NestedProjects section');
  return [start, end];
}

function slnAdd(text: string, name: string, parentId: string | undefined, newGuid: () => string): [string, string] {
  const model = slnModel(text);
  const parent = parentId === undefined ? undefined : model.folders.find((f) => f.id === parentId.toUpperCase());
  if (parentId !== undefined && !parent) throw new Error(NOT_FOUND);
  assertValidName(name, model.folders.filter((f) => f.parentId === parent?.id).map((f) => f.name));
  const guid = normalizeGuid(newGuid());
  if (text.toUpperCase().includes(guid)) throw new Error(`GUID already in use: ${guid}`);

  const lines = splitLines(text);
  const fallback = detectEol(text);
  let lastEndProject = -1;
  lines.forEach((l, i) => { if (bare(l).trim() === 'EndProject') lastEndProject = i; });
  const at = lastEndProject >= 0 ? lastEndProject + 1 : findLine(lines, (t) => t === 'Global');
  if (at < 0) throw new Error('Malformed solution file: no Global section');
  const blockEol = lineEol(lines[lastEndProject >= 0 ? lastEndProject : at], fallback);
  insertLines(lines, at, blockEol, `Project("${FOLDER_TYPE}") = "${name}", "${name}", "${guid}"`, 'EndProject');

  if (parent) {
    const section = nestedSection(lines);
    if (section) {
      const [start, end] = section;
      const entryIndent = end > start + 1 ? leadingWs(lines[start + 1]) : leadingWs(lines[start]).repeat(2);
      insertLines(lines, end, lineEol(lines[end - 1], fallback), `${entryIndent}${guid} = ${parent.id}`);
    } else {
      let endGlobal = -1;
      lines.forEach((l, i) => { if (bare(l).trim() === 'EndGlobal') endGlobal = i; });
      if (endGlobal < 0) throw new Error('Malformed solution file: no EndGlobal');
      const sectionLine = lines.find((l) => /^\s+GlobalSection\(/.test(bare(l)));
      const unit = sectionLine ? leadingWs(sectionLine) : '\t';
      insertLines(lines, endGlobal, lineEol(lines[endGlobal - 1], fallback),
        `${unit}GlobalSection(NestedProjects) = preSolution`,
        `${unit}${unit}${guid} = ${parent.id}`,
        `${unit}EndGlobalSection`);
    }
  }
  return [lines.join(''), guid];
}

function slnRename(text: string, id: string, newName: string): string {
  const key = id.toUpperCase();
  const model = slnModel(text);
  const folder = model.folders.find((f) => f.id === key);
  if (!folder) throw new Error(NOT_FOUND);
  assertValidName(newName, model.folders.filter((f) => f.parentId === folder.parentId && f.id !== key).map((f) => f.name));
  const lines = splitLines(text);
  const i = findFolderLine(lines, key);
  if (i < 0) throw new Error(NOT_FOUND);
  const eol = /\r?\n$/.exec(lines[i])?.[0] ?? '';
  const m = PROJECT_LINE.exec(lines[i].slice(0, lines[i].length - eol.length))!;
  lines[i] = `${m[1]}${newName}${m[4]}${newName}${m[6]}${eol}`;
  return lines.join('');
}

function slnRemove(text: string, id: string): string {
  const key = id.toUpperCase();
  const model = slnModel(text);
  if (!model.folders.some((f) => f.id === key)) throw new Error(NOT_FOUND);
  if (model.folders.some((f) => f.parentId === key) || model.projects.some((p) => p.folderId === key)) {
    throw new Error(NOT_EMPTY);
  }
  const lines = splitLines(text);
  const start = findFolderLine(lines, key);
  const end = findLine(lines, (t) => t === 'EndProject', start + 1);
  if (start < 0 || end < 0) throw new Error(NOT_FOUND);
  // Solution items (ProjectSection(SolutionItems)) would be lost with the block, so they count as content.
  if (lines.slice(start + 1, end).some((l) => bare(l).trim() !== '')) throw new Error(NOT_EMPTY);

  const drop = new Set<number>();
  for (let i = start; i <= end; i++) drop.add(i);
  const section = nestedSection(lines);
  if (section) {
    for (let i = section[0] + 1; i < section[1]; i++) {
      const n = NESTED_LINE.exec(bare(lines[i]));
      if (n && (n[1].toUpperCase() === key || n[2].toUpperCase() === key)) drop.add(i);
    }
  }
  return lines.filter((_, i) => !drop.has(i)).join('');
}

// ---------------------------------------------------------------------------------------------
// .slnx

interface FolderElement {
  /** Normalized folder path segments, e.g. ['src', 'web'] for "/src/web/". */
  segs: string[];
  start: number;
  /** Index just past the start tag. */
  tagEnd: number;
  /** Index just past the whole element. */
  end: number;
  selfClosing: boolean;
  /** Range of the raw Name attribute value, and its quote character. */
  nameStart: number;
  nameEnd: number;
  quote: string;
}

const TAG_BODY = `(?:[^>"']|"[^"]*"|'[^']*')*`;
const FOLDER_TAG = new RegExp(`<Folder\\b${TAG_BODY}>`, 'g');
const SOLUTION_TAG = new RegExp(`<Solution\\b${TAG_BODY}>`);
const NAME_ATTR = /\sName\s*=\s*(["'])([^]*?)\1/;

/** Replaces comments with spaces of equal length so offsets stay valid while commented-out markup is ignored. */
const maskComments = (text: string): string => text.replace(/<!--[\s\S]*?-->/g, (c) => ' '.repeat(c.length));

const toSegs = (folderPath: string): string[] => folderPath.split('/').filter(Boolean);
const toPath = (segs: readonly string[]): string => `/${segs.map((s) => `${s}/`).join('')}`;
const startsWith = (segs: readonly string[], prefix: readonly string[]): boolean =>
  prefix.length <= segs.length && prefix.every((s, i) => segs[i] === s);
const sameSegs = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && startsWith(a, b);

function decodeXml(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|lt|gt|quot|apos|amp);/g, (_, e: string) =>
    e[0] === '#'
      ? String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10))
      : ({ lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' } as Record<string, string>)[e]);
}

function encodeXml(s: string, quote = '"'): string {
  const out = s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return quote === '"' ? out.replace(/"/g, '&quot;') : out.replace(/'/g, '&apos;');
}

function scanFolders(text: string): FolderElement[] {
  const masked = maskComments(text);
  if (!SOLUTION_TAG.test(masked)) throw new Error('Not a solution file');
  const out: FolderElement[] = [];
  for (const m of masked.matchAll(FOLDER_TAG)) {
    const start = m.index!;
    const tag = m[0];
    const tagEnd = start + tag.length;
    const selfClosing = /\/\s*>$/.test(tag);
    let end = tagEnd;
    if (!selfClosing) {
      const close = /<\/Folder\s*>/g;
      close.lastIndex = tagEnd;
      const c = close.exec(masked);
      if (!c) throw new Error('Malformed solution file: unterminated <Folder>');
      end = c.index + c[0].length;
    }
    const n = NAME_ATTR.exec(tag);
    if (!n) continue;
    const nameStart = start + n.index + n[0].length - 1 - n[2].length;
    out.push({
      segs: toSegs(decodeXml(n[2])), start, tagEnd, end, selfClosing,
      nameStart, nameEnd: nameStart + n[2].length, quote: n[1],
    });
  }
  return out.filter((f) => f.segs.length > 0);
}

/** Names of the folders directly under `parent`, including folders only implied by a deeper path. */
function slnxChildNames(folders: FolderElement[], parent: readonly string[]): string[] {
  const names = new Set<string>();
  for (const f of folders) if (f.segs.length > parent.length && startsWith(f.segs, parent)) names.add(f.segs[parent.length]);
  return [...names];
}

/** Indentation of the line `pos` sits on, if only whitespace precedes it there. */
function indentAt(text: string, pos: number): string | undefined {
  const lineStart = text.lastIndexOf('\n', pos - 1) + 1;
  const before = text.slice(lineStart, pos).replace(/^﻿/, '');
  return /^[ \t]*$/.test(before) ? before : undefined;
}

function detectXmlIndent(text: string): string {
  const m = /\n([ \t]+)</.exec(text);
  return m ? m[1] : '  ';
}

function slnxAdd(text: string, name: string, parentId: string | undefined): [string, string] {
  const folders = scanFolders(text);
  const parent = toSegs(parentId ?? '/');
  if (parent.length && !folders.some((f) => sameSegs(f.segs, parent))) throw new Error(NOT_FOUND);
  assertValidName(name, slnxChildNames(folders, parent));
  const target = [...parent, name];
  // Like `dotnet sln add --solution-folder a/b`, every missing ancestor of the parent gets its own element.
  const missing: string[][] = [];
  for (let i = 1; i <= target.length; i++) {
    const segs = target.slice(0, i);
    if (!folders.some((f) => sameSegs(f.segs, segs))) missing.push(segs);
  }
  const id = toPath(target);
  const last = folders[folders.length - 1];
  const sol = SOLUTION_TAG.exec(maskComments(text))!;
  const solEnd = sol.index + sol[0].length;
  const anchor = last ? last.end : solEnd;
  const eol = eolAt(text, anchor);
  const indent = (last && indentAt(text, last.start)) ?? detectXmlIndent(text);
  const inserted = missing.map((segs) => `${eol}${indent}<Folder Name="${encodeXml(toPath(segs))}" />`).join('');
  if (last) return [text.slice(0, last.end) + inserted + text.slice(last.end), id];

  if (/\/\s*>$/.test(sol[0])) {
    const open = text.slice(sol.index, solEnd).replace(/\s*\/\s*>$/, '>');
    return [text.slice(0, sol.index) + open + inserted + eol + '</Solution>' + text.slice(solEnd), id];
  }
  return [text.slice(0, solEnd) + inserted + text.slice(solEnd), id];
}

function slnxRename(text: string, id: string, newName: string): string {
  const folders = scanFolders(text);
  const old = toSegs(id);
  if (!folders.some((f) => sameSegs(f.segs, old))) throw new Error(NOT_FOUND);
  const parent = old.slice(0, -1);
  const ownName = old[old.length - 1];
  assertValidName(newName, slnxChildNames(folders, parent).filter((n) => n !== ownName));
  let out = text;
  // Rewrite from the end so earlier offsets stay valid.
  for (const f of [...folders].reverse()) {
    if (!startsWith(f.segs, old)) continue;
    const renamed = toPath([...parent, newName, ...f.segs.slice(old.length)]);
    out = out.slice(0, f.nameStart) + encodeXml(renamed, f.quote) + out.slice(f.nameEnd);
  }
  return out;
}

function slnxRemove(text: string, id: string): string {
  const folders = scanFolders(text);
  const segs = toSegs(id);
  const f = folders.find((x) => sameSegs(x.segs, segs));
  if (!f) throw new Error(NOT_FOUND);
  if (folders.some((x) => x.segs.length > segs.length && startsWith(x.segs, segs))) throw new Error(NOT_EMPTY);
  if (!f.selfClosing) {
    const inner = maskComments(text).slice(f.tagEnd, f.end).replace(/<\/Folder\s*>$/, '');
    if (inner.includes('<')) throw new Error(NOT_EMPTY);
  }
  // Drop the whole line when the element is alone on it; otherwise only the element itself.
  let from = f.start;
  let to = f.end;
  const nl = text.indexOf('\n', f.end);
  const rest = text.slice(f.end, nl < 0 ? text.length : nl);
  const lineStart = text.lastIndexOf('\n', f.start - 1) + 1;
  if (indentAt(text, f.start) !== undefined && /^[ \t\r]*$/.test(rest)) {
    if (nl >= 0) {
      from = lineStart + (text[lineStart] === '\uFEFF' ? 1 : 0);
      to = nl + 1;
    } else if (lineStart > 0) {
      from = lineStart - (text[lineStart - 2] === '\r' ? 2 : 1);
      to = text.length;
    }
  }
  return text.slice(0, from) + text.slice(to);
}
