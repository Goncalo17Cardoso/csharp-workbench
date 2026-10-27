import { XMLParser } from 'fast-xml-parser';
import { strFromU8, unzipSync } from 'fflate';
import type { PackageDetails, PackageSource, SearchResult } from '../../core/types';
import { compareVersions, isPrerelease } from '../../core/version';
import { FeedError, type FeedClient } from './types';

export interface LocalFs {
  readdir(p: string): Promise<string[]>;
  readFile(p: string): Promise<Uint8Array>;
  stat(p: string): Promise<{ isDirectory(): boolean }>;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
  parseTagValue: false,
  parseAttributeValue: false,
  isArray: (name) => name === 'group' || name === 'dependency',
});

const text = (v: any): string => (typeof v === 'string' ? v : typeof v?.['#text'] === 'string' ? v['#text'] : '');
const trim = (v: any): string => text(v).trim();

export function parseNuspec(xml: string): PackageDetails {
  const m = parser.parse(xml)?.package?.metadata;
  if (!m) { throw new Error('nuspec has no metadata'); }
  const deps = m.dependencies ?? {};
  const toPkgs = (list: any[] | undefined): { id: string; range: string }[] =>
    (list ?? []).map((d) => ({ id: d['@_id'], range: d['@_version'] ?? '' }));
  const dependencies: PackageDetails['dependencies'] = deps.group
    ? (deps.group as any[]).map((g) => ({ framework: g['@_targetFramework'] ?? '', packages: toPkgs(g.dependency) }))
    : deps.dependency ? [{ framework: '', packages: toPkgs(deps.dependency) }] : [];
  return {
    id: trim(m.id),
    version: trim(m.version),
    description: trim(m.description),
    authors: trim(m.authors) || undefined,
    license: trim(m.license) || undefined,
    licenseUrl: trim(m.licenseUrl) || undefined,
    projectUrl: trim(m.projectUrl) || undefined,
    dependencies,
  };
}

export function createLocalClient(source: PackageSource, fs: LocalFs): FeedClient {
  const join = (a: string, b: string): string => (a.endsWith('/') ? a + b : `${a}/${b}`);
  const isDir = async (p: string): Promise<boolean> => (await fs.stat(p)).isDirectory();

  async function nupkgPaths(): Promise<string[]> {
    try {
      const out: string[] = [];
      const walk = async (dir: string, depth: number): Promise<void> => {
        for (const name of await fs.readdir(dir)) {
          const p = join(dir, name);
          if (name.toLowerCase().endsWith('.nupkg')) { out.push(p); }
          else if (depth < 2 && (await isDir(p))) { await walk(p, depth + 1); }
        }
      };
      await walk(source.url, 0);
      return out;
    } catch (e) {
      throw new FeedError(`${source.name}: cannot read ${source.url} (${(e as Error).message})`, source.name);
    }
  }

  async function readAll(): Promise<PackageDetails[]> {
    const pkgs: PackageDetails[] = [];
    for (const p of await nupkgPaths()) {
      try {
        const files = unzipSync(await fs.readFile(p), { filter: (f) => f.name.toLowerCase().endsWith('.nuspec') && !f.name.includes('/') });
        const name = Object.keys(files)[0];
        if (name) { pkgs.push(parseNuspec(strFromU8(files[name]))); }
      } catch {
        // skip unreadable or corrupt packages so one bad file does not hide the rest
      }
    }
    return pkgs;
  }

  return {
    async search(q, o) {
      const needle = q.toLowerCase();
      const byId = new Map<string, SearchResult>();
      for (const p of await readAll()) {
        if (!o.prerelease && isPrerelease(p.version)) { continue; }
        if (!p.id.toLowerCase().includes(needle) && !p.description.toLowerCase().includes(needle)) { continue; }
        const key = p.id.toLowerCase();
        const cur = byId.get(key);
        if (!cur || compareVersions(p.version, cur.latestVersion) > 0) {
          byId.set(key, { id: p.id, description: p.description, latestVersion: p.version, sources: [source.name] });
        }
      }
      return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id)).slice(o.skip, o.skip + o.take);
    },

    async versions(id, prerelease) {
      const key = id.toLowerCase();
      return (await readAll())
        .filter((p) => p.id.toLowerCase() === key && (prerelease || !isPrerelease(p.version)))
        .map((p) => p.version)
        .sort((a, b) => compareVersions(b, a));
    },

    async details(id, version) {
      const key = id.toLowerCase();
      const hit = (await readAll()).find((p) => p.id.toLowerCase() === key && compareVersions(p.version, version) === 0);
      if (!hit) { throw new FeedError(`${source.name}: ${id} ${version} not found`, source.name, 404); }
      return hit;
    },
  };
}
