import { basename, dirname, isAbsolute, join, posix, relative } from 'node:path';
import type { PackageRef } from '../core/types';
import type { ProjectInfoData, ProjectItems, SolutionModel, SolutionProject, TreeNode } from './model';
import { nestFiles } from './nesting';

const cmp = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true });

function node(n: Omit<TreeNode, 'contextValue'> & { contextValue?: string }, suffix = ''): TreeNode {
  return { ...n, contextValue: n.contextValue ?? `cw.${n.kind}${suffix}` };
}

export function buildSolutionNodes(model: SolutionModel, opts: { startupProject?: string }): TreeNode[] {
  const folderIds = new Set(model.folders.map((f) => f.id));
  const folderNode = (id: string | undefined, seen: Set<string>): TreeNode[] => {
    const folders = model.folders
      .filter((f) => (f.parentId && folderIds.has(f.parentId) ? f.parentId : undefined) === id && !seen.has(f.id))
      .sort((a, b) => cmp(a.name, b.name))
      .map((f) => {
        const next = new Set(seen).add(f.id);
        return node({
          id: `solutionFolder:${model.path}|${f.id}`, kind: 'solutionFolder', label: f.name,
          children: folderNode(f.id, next),
        });
      });
    const projects = model.projects
      .filter((p) => (p.folderId && folderIds.has(p.folderId) ? p.folderId : undefined) === id)
      .sort((a, b) => cmp(a.name, b.name))
      .map((p) => projectNode(p, opts.startupProject));
    return [...folders, ...projects];
  };
  const n = model.projects.length;
  const solName = basename(model.path).replace(/\.(sln|slnx)$/i, '');
  return [node({
    id: `solution:${model.path}`, kind: 'solution', path: model.path, count: n,
    label: `Solution '${solName}' (${n} project${n === 1 ? '' : 's'})`,
    children: folderNode(undefined, new Set()),
  })];
}

function projectNode(p: SolutionProject, startup?: string): TreeNode {
  return node({ id: `project:${p.path}`, kind: 'project', label: p.name, path: p.path, projectPath: p.path },
    p.path === startup ? '.startup' : '');
}

interface Entry { full: string; missing?: boolean; excluded?: boolean; linked?: boolean }
/** `real`: some non-linked file lives below, so the folder maps to a directory inside the project. */
interface Dir { dirs: Map<string, Dir>; files: Array<Entry & { name: string }>; real: boolean }
const newDir = (): Dir => ({ dirs: new Map(), files: [], real: false });

/** Normalises a `Link` (or relative path); a path that escapes the project collapses to its file name. */
function virtualPath(rel: string, full: string): string {
  const n = posix.normalize(rel.replace(/\\/g, '/'));
  return n === '.' || n === '..' || n.startsWith('../') || posix.isAbsolute(n) ? basename(full) : n;
}

export function buildProjectChildren(
  project: SolutionProject,
  info: ProjectInfoData,
  items: ProjectItems,
  packages: PackageRef[],
  opts: { showAllFiles: boolean; allFiles?: string[]; exists?: (path: string) => boolean },
): TreeNode[] {
  const pp = project.path;
  const projDir = dirname(pp);
  const root = newDir();
  const place = (rel: string, entry: Entry) => {
    const parts = virtualPath(rel, entry.full).split('/').filter((s) => s && s !== '.' && s !== '..');
    const name = parts.pop() ?? basename(entry.full);
    let d = root;
    for (const part of parts) {
      let next = d.dirs.get(part);
      if (!next) d.dirs.set(part, (next = newDir()));
      if (!entry.linked) next.real = true;
      d = next;
    }
    d.files.push({ name, ...entry });
  };
  const known = new Set<string>();
  for (const it of items.items) {
    known.add(it.fullPath);
    const own = relative(projDir, it.fullPath);
    const outside = own.startsWith('..') || isAbsolute(own);
    // Linked or outside items point at files other projects may share: never treat them as project files.
    const linked = !!it.link || outside;
    const missing = it.link && opts.exists ? !opts.exists(it.fullPath) : false;
    place(it.link ?? (outside ? basename(it.fullPath) : own),
      { full: it.fullPath, ...(linked ? { linked: true } : {}), ...(missing ? { missing: true } : {}) });
  }
  if (opts.showAllFiles) {
    for (const f of opts.allFiles ?? []) {
      if (known.has(f)) continue;
      const rel = relative(projDir, f);
      place(rel.startsWith('..') || isAbsolute(rel) ? basename(f) : rel, { full: f, excluded: true });
    }
  }

  const out: TreeNode[] = [];
  if (!items.evaluated) {
    out.push(node({
      id: `warning:${pp}`, kind: 'warning', projectPath: pp,
      label: 'Could not evaluate project — showing files on disk', description: items.error,
    }));
  }
  const pkgNodes = packages.map((r) => node({
    id: `package:${pp}|${r.id}`, kind: 'package', label: r.id, projectPath: pp,
    description: r.requested ?? r.resolved ?? '',
  }));
  const refNodes = info.projectRefs.map((r) => node({
    id: `projectRef:${pp}|${r}`, kind: 'projectRef', path: r, projectPath: pp,
    label: basename(r).replace(/\.csproj$/i, ''),
  }));
  const fwNodes = info.targetFrameworks.map((t) => node({
    id: `framework:${pp}|${t}`, kind: 'framework', label: t, projectPath: pp,
  }));
  out.push(node({
    id: `dependencies:${pp}`, kind: 'dependencies', label: 'Dependencies', projectPath: pp,
    children: [
      node({ id: `packages:${pp}`, kind: 'packages', label: 'Packages', projectPath: pp, children: pkgNodes }),
      node({ id: `projectRefs:${pp}`, kind: 'projectRefs', label: 'Projects', projectPath: pp, children: refNodes }),
      node({ id: `frameworks:${pp}`, kind: 'frameworks', label: 'Frameworks', projectPath: pp, children: fwNodes }),
    ],
  }));
  out.push(...dirNodes(root, projDir, pp));
  return out;
}

function dirNodes(d: Dir, absDir: string, pp: string): TreeNode[] {
  const folders = [...d.dirs.entries()].sort((a, b) => cmp(a[0], b[0])).map(([name, sub]) => {
    const p = join(absDir, name);
    return node({ id: `folder:${p}`, kind: 'folder', label: name, path: p, projectPath: pp, children: dirNodes(sub, p, pp) },
      sub.real ? '' : '.virtual');
  });
  const nest = nestFiles(d.files.map((f) => f.name));
  const lower = (s: string) => s.toLowerCase();
  const top = (name: string): string => {
    let cur = name;
    const seen = new Set<string>();
    while (nest.has(cur) && !seen.has(cur)) { seen.add(cur); cur = nest.get(cur)!; }
    return cur;
  };
  const fileNode = (f: Dir['files'][number]): TreeNode => node({
    id: `file:${f.full}`, kind: 'file', label: f.name, path: f.full, projectPath: pp,
    ...(f.excluded ? { description: 'excluded' } : {}),
    ...(f.missing ? { missing: true } : {}),
  }, f.excluded ? '.excluded' : f.linked ? (f.missing ? '.linked.missing' : '.linked') : '');
  const children = new Map<string, TreeNode[]>();
  const tops: Dir['files'] = [];
  for (const f of d.files) {
    const t = top(f.name);
    if (t === f.name) tops.push(f);
    else {
      const arr = children.get(lower(t)) ?? [];
      arr.push(fileNode(f));
      children.set(lower(t), arr);
    }
  }
  const files = tops.sort((a, b) => cmp(a.name, b.name)).map((f) => {
    const n = fileNode(f);
    const kids = children.get(lower(f.name));
    if (kids?.length) n.children = kids.sort((a, b) => cmp(a.label, b.label));
    return n;
  });
  return [...folders, ...files];
}
