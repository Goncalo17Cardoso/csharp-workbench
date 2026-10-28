import { dirname, join } from 'node:path';
import type { DotnetCli } from '../dotnet/cli';
import { parseGetItems } from '../dotnet/parse';
import type { ProjectItem, ProjectItems } from './model';

export interface WalkEntry { name: string; isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }
export interface WalkFs { readdir(dir: string): Promise<WalkEntry[]> }

const SKIP_DIRS = new Set(['bin', 'obj', '.git', 'node_modules', '.vs']);
const ITEM_TYPES = ['Compile', 'None', 'Content', 'EmbeddedResource', 'AdditionalFiles'];

export async function walkProjectDir(dir: string, fs: WalkFs): Promise<string[]> {
  const out: string[] = [];
  for (const e of await fs.readdir(dir)) {
    const p = join(dir, e.name);
    if (e.isSymbolicLink()) { if (e.isFile()) out.push(p); continue; } // never follow symlinked dirs
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) out.push(...(await walkProjectDir(p, fs)));
    } else if (e.isFile() && !e.name.endsWith('.user')) out.push(p);
  }
  return out;
}

export async function loadProjectItems(
  projectPath: string,
  cli: Pick<DotnetCli, 'getItems'>,
  fs: WalkFs,
): Promise<ProjectItems> {
  try {
    const raw = await cli.getItems(projectPath, ITEM_TYPES);
    const start = raw.indexOf('{');
    const doc = JSON.parse(start >= 0 ? raw.slice(start) : raw);
    if (!doc || typeof doc !== 'object' || !doc.Items || typeof doc.Items !== 'object') throw new Error('msbuild output has no Items');
    const byType = parseGetItems(raw);
    const merged = new Map<string, ProjectItem>();
    for (const list of Object.values(byType)) {
      for (const i of list) {
        const prev = merged.get(i.fullPath);
        const link = i.link ?? prev?.link;
        merged.set(i.fullPath, { fullPath: i.fullPath, ...(link ? { link } : {}) });
      }
    }
    return { items: [...merged.values()], evaluated: true };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    try {
      const files = await walkProjectDir(dirname(projectPath), fs);
      return { items: files.map((fullPath) => ({ fullPath })), evaluated: false, error: message };
    } catch (w) {
      return { items: [], evaluated: false, error: `${message}; ${w instanceof Error ? w.message : String(w)}` };
    }
  }
}
