// Solution-folder edits: the single, user-approved exception to "only through the dotnet CLI".
// Every function is pure and returns the whole new file text. Edits are targeted text changes:
// every byte outside the edited lines (BOM, line endings, indentation, comments) is kept as is.
import type { SolutionModel } from './model';
import { parseSln } from './slnParse';

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

export function addFolder(text: string, kind: Kind, name: string, parentId: string | undefined, newGuid: () => string): string {
  return kind === 'sln' ? slnAdd(text, name, parentId, newGuid) : slnxAdd(text, name, parentId);
}

export function renameFolder(text: string, kind: Kind, id: string, newName: string): string {
  return kind === 'sln' ? slnRename(text, id, newName) : slnxRename(text, id, newName);
}

export function removeEmptyFolder(text: string, kind: Kind, id: string): string {
  return kind === 'sln' ? slnRemove(text, id) : slnxRemove(text, id);
}

// ---------------------------------------------------------------------------------------------
// Shared text helpers

/** Lines including their own terminators, so `join('')` reproduces the text exactly. */
const splitLines = (text: string): string[] => text.split(/(?<=\n)/);
/** The line without terminator and without a leading BOM. */
const bare = (line: string): string => line.replace(/\r?\n$/, '').replace(/^﻿/, '');
const leadingWs = (line: string): string => /^[ \t]*/.exec(bare(line))![0];

/** The file's own line ending: that of its first line, LF when there is none. */
function detectEol(text: string): string {
  const i = text.indexOf('\n');
  return i > 0 && text[i - 1] === '\r' ? '\r\n' : '\n';
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

function slnAdd(text: string, name: string, parentId: string | undefined, newGuid: () => string): string {
  const model = slnModel(text);
  const parent = parentId === undefined ? undefined : model.folders.find((f) => f.id === parentId.toUpperCase());
  if (parentId !== undefined && !parent) throw new Error(NOT_FOUND);
  assertValidName(name, model.folders.filter((f) => f.parentId === parent?.id).map((f) => f.name));
  const guid = normalizeGuid(newGuid());
  if (text.toUpperCase().includes(guid)) throw new Error(`GUID already in use: ${guid}`);

  const lines = splitLines(text);
  const eol = detectEol(text);
  let lastEndProject = -1;
  lines.forEach((l, i) => { if (bare(l).trim() === 'EndProject') lastEndProject = i; });
  const at = lastEndProject >= 0 ? lastEndProject + 1 : findLine(lines, (t) => t === 'Global');
  if (at < 0) throw new Error('Malformed solution file: no Global section');
  insertLines(lines, at, eol, `Project("${FOLDER_TYPE}") = "${name}", "${name}", "${guid}"`, 'EndProject');

  if (parent) {
    const section = nestedSection(lines);
    if (section) {
      const [start, end] = section;
      const entryIndent = end > start + 1 ? leadingWs(lines[start + 1]) : leadingWs(lines[start]).repeat(2);
      insertLines(lines, end, eol, `${entryIndent}${guid} = ${parent.id}`);
    } else {
      let endGlobal = -1;
      lines.forEach((l, i) => { if (bare(l).trim() === 'EndGlobal') endGlobal = i; });
      if (endGlobal < 0) throw new Error('Malformed solution file: no EndGlobal');
      const sectionLine = lines.find((l) => /^\s+GlobalSection\(/.test(bare(l)));
      const unit = sectionLine ? leadingWs(sectionLine) : '\t';
      insertLines(lines, endGlobal, eol,
        `${unit}GlobalSection(NestedProjects) = preSolution`,
        `${unit}${unit}${guid} = ${parent.id}`,
        `${unit}EndGlobalSection`);
    }
  }
  return lines.join('');
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

function slnxAdd(text: string, name: string, parentId: string | undefined): string {
  const folders = scanFolders(text);
  const parent = toSegs(parentId ?? '/');
  assertValidName(name, slnxChildNames(folders, parent));
  const target = [...parent, name];
  // Like `dotnet sln add --solution-folder a/b`, every missing ancestor gets its own element.
  const missing: string[][] = [];
  for (let i = 1; i <= target.length; i++) {
    const segs = target.slice(0, i);
    if (!folders.some((f) => sameSegs(f.segs, segs))) missing.push(segs);
  }
  const eol = detectEol(text);
  const last = folders[folders.length - 1];
  const indent = (last && indentAt(text, last.start)) ?? detectXmlIndent(text);
  const inserted = missing.map((segs) => `${eol}${indent}<Folder Name="${encodeXml(toPath(segs))}" />`).join('');
  if (last) return text.slice(0, last.end) + inserted + text.slice(last.end);

  const sol = SOLUTION_TAG.exec(maskComments(text))!;
  const solEnd = sol.index + sol[0].length;
  if (/\/\s*>$/.test(sol[0])) {
    const open = text.slice(sol.index, solEnd).replace(/\s*\/\s*>$/, '>');
    return text.slice(0, sol.index) + open + inserted + eol + '</Solution>' + text.slice(solEnd);
  }
  return text.slice(0, solEnd) + inserted + text.slice(solEnd);
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
