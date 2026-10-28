import * as path from 'node:path';
import { XMLParser } from 'fast-xml-parser';
import type { SolutionFolder, SolutionModel, SolutionProject } from './model';

const FOLDER_GUID = '{2150E333-8FDC-42A3-9474-1A3956D46DE8}';
const PROJECT_RE = /^Project\("(\{[^}]*\})"\)\s*=\s*"([^"]*)"\s*,\s*"([^"]*)"\s*,\s*"(\{[^}]*\})"/;
const NESTED_RE = /^\s*(\{[^}]*\})\s*=\s*(\{[^}]*\})\s*$/;

function resolveProjectPath(slnPath: string, rel: string): string {
  return path.resolve(path.dirname(slnPath), rel.replace(/\\/g, '/'));
}

/** Read-only, line-based parse of a .sln. Unknown sections are ignored. */
export function parseSln(text: string, slnPath: string): SolutionModel {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  if (!lines.some((l) => /^Microsoft Visual Studio Solution File/.test(l.trim()))) {
    throw new Error(`Not a solution file: ${slnPath}`);
  }
  const folders: SolutionFolder[] = [];
  const projects: Array<SolutionProject & { guid: string }> = [];
  const nested = new Map<string, string>();
  let inNested = false;
  for (const raw of lines) {
    const line = raw.trim();
    const m = PROJECT_RE.exec(line);
    if (m) {
      const typeGuid = m[1].toUpperCase();
      const id = m[4].toUpperCase();
      if (typeGuid === FOLDER_GUID) folders.push({ id, name: m[2] });
      else projects.push({ guid: id, name: m[2], path: resolveProjectPath(slnPath, m[3]), typeGuid });
      continue;
    }
    if (/^GlobalSection\(NestedProjects\)/.test(line)) { inNested = true; continue; }
    if (inNested) {
      if (/^EndGlobalSection/.test(line)) { inNested = false; continue; }
      const n = NESTED_RE.exec(line);
      if (n) nested.set(n[1].toUpperCase(), n[2].toUpperCase());
    }
  }
  const folderIds = new Set(folders.map((f) => f.id));
  for (const f of folders) {
    const p = nested.get(f.id);
    if (p && folderIds.has(p)) f.parentId = p;
  }
  const outProjects: SolutionProject[] = projects.map(({ guid, ...p }) => {
    const f = nested.get(guid);
    return f && folderIds.has(f) ? { ...p, folderId: f } : p;
  });
  return { path: slnPath, kind: 'sln', folders, projects: outProjects };
}

function asArray<T>(v: T | T[] | undefined): T[] {
  return v === undefined ? [] : Array.isArray(v) ? v : [v];
}

/** Read-only parse of a .slnx. */
export function parseSlnx(xml: string, slnxPath: string): SolutionModel {
  let doc: any;
  try {
    doc = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', allowBooleanAttributes: true }).parse(xml.replace(/^﻿/, ''));
  } catch {
    throw new Error(`Not a solution file: ${slnxPath}`);
  }
  const root = doc?.Solution;
  if (root === undefined || root === null) throw new Error(`Not a solution file: ${slnxPath}`);
  const body = typeof root === 'object' ? root : {};
  const folders: SolutionFolder[] = [];
  const projects: SolutionProject[] = [];
  const addProject = (p: any, folderId?: string): void => {
    const rel = p?.['@_Path'];
    if (typeof rel !== 'string') return;
    const abs = resolveProjectPath(slnxPath, rel);
    const proj: SolutionProject = { path: abs, name: path.basename(abs, path.extname(abs)) };
    if (folderId) proj.folderId = folderId;
    projects.push(proj);
  };
  for (const f of asArray<any>(body.Folder)) {
    const id = f?.['@_Name'];
    if (typeof id !== 'string') continue;
    const segs = id.split('/').filter(Boolean);
    if (!segs.length) continue;
    const folder: SolutionFolder = { id, name: segs[segs.length - 1] };
    if (segs.length > 1) folder.parentId = `/${segs.slice(0, -1).join('/')}/`;
    folders.push(folder);
    for (const p of asArray<any>(f.Project)) addProject(p, id);
  }
  for (const p of asArray<any>(body.Project)) addProject(p);
  return { path: slnxPath, kind: 'slnx', folders, projects };
}

export async function loadSolution(
  slnPath: string,
  readFile: (p: string) => Promise<string>,
): Promise<SolutionModel> {
  const text = await readFile(slnPath);
  return slnPath.toLowerCase().endsWith('.slnx') ? parseSlnx(text, slnPath) : parseSln(text, slnPath);
}
