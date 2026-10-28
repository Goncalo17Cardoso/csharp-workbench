import type { DotnetCli } from '../dotnet/cli';

export interface ItemTemplate { name: string; shortNames: string[]; languages: string[]; tags: string }
export interface TemplateOptions { namespace: boolean; project: boolean }

export function parseNewList(stdout: string): ItemTemplate[] {
  const lines = stdout.split(/\r?\n/);
  const sep = lines.findIndex((l) => /^-+( +-+)+\s*$/.test(l));
  if (sep < 0) return [];
  const starts = [...lines[sep].matchAll(/-+/g)].map((m) => m.index!);
  const cell = (l: string, i: number) =>
    l.slice(starts[i], i + 1 < starts.length ? starts[i + 1] : undefined).trim();
  const out: ItemTemplate[] = [];
  for (const l of lines.slice(sep + 1)) {
    if (l.trim() === '') break;
    const name = cell(l, 0);
    if (!name) continue;
    out.push({
      name,
      shortNames: cell(l, 1).split(',').map((s) => s.trim()).filter(Boolean),
      languages: cell(l, 2).split(',').map((s) => s.replace(/[[\]]/g, '').trim()).filter(Boolean),
      tags: starts.length > 3 ? cell(l, 3) : '',
    });
  }
  return out;
}

export function parseTemplateOptions(help: string): TemplateOptions {
  return {
    namespace: /(^|\s)(--namespace|-na)(\s|,|$)/m.test(help),
    project: /(^|\s)--project(\s|,|$)/m.test(help),
  };
}

export function newItemArgs(name: string, outDir: string, ns: string, projectPath: string, opts: TemplateOptions): string[] {
  return ['-n', name, '-o', outDir, ...(opts.namespace ? ['--namespace', ns] : []), ...(opts.project ? ['--project', projectPath] : [])];
}

export class TemplateCatalog {
  private lists = new Map<'item' | 'project', Promise<ItemTemplate[]>>();
  private opts = new Map<string, Promise<TemplateOptions>>();

  constructor(private cli: Pick<DotnetCli, 'newList' | 'newHelp'>) {}

  list(type: 'item' | 'project' = 'item'): Promise<ItemTemplate[]> {
    return this.cached(this.lists, type, async () => parseNewList(await this.cli.newList(type)));
  }

  options(shortName: string): Promise<TemplateOptions> {
    const first = shortName.split(',')[0].trim();
    return this.cached(this.opts, first, async () => parseTemplateOptions(await this.cli.newHelp(first)));
  }

  refresh(): void {
    this.lists.clear();
    this.opts.clear();
  }

  private cached<K, V>(m: Map<K, Promise<V>>, k: K, load: () => Promise<V>): Promise<V> {
    let p = m.get(k);
    if (!p) {
      p = load();
      m.set(k, p);
      p.catch(() => { if (m.get(k) === p) m.delete(k); });
    }
    return p;
  }
}
