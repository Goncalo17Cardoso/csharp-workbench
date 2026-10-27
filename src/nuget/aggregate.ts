import type { PackageDetails, PackageSource, SearchResult } from '../core/types';
import { compareVersions, maxVersion } from '../core/version';
import { FeedError } from './feeds/types';
import type { FeedClient } from './feeds/types';

export interface SourceClient { source: PackageSource; client: FeedClient }

const messageOf = (e: unknown): string => (e instanceof FeedError ? e.message : String(e));

export async function searchAll(
  clients: SourceClient[],
  q: string,
  o: { prerelease: boolean; skip: number; take: number },
): Promise<{ results: SearchResult[]; failures: { source: string; message: string }[] }> {
  const settled = await Promise.allSettled(clients.map((c) => c.client.search(q, o)));
  const merged = new Map<string, SearchResult>();
  const failures: { source: string; message: string }[] = [];
  settled.forEach((s, i) => {
    const name = clients[i].source.name;
    if (s.status === 'rejected') {
      failures.push({ source: name, message: messageOf(s.reason) });
      return;
    }
    for (const item of s.value) {
      const key = item.id.toLowerCase();
      const cur = merged.get(key);
      if (!cur) {
        merged.set(key, { ...item, sources: [name] });
      } else {
        cur.latestVersion = maxVersion([cur.latestVersion, item.latestVersion]) ?? cur.latestVersion;
        if (!cur.sources.includes(name)) { cur.sources.push(name); }
      }
    }
  });
  return { results: [...merged.values()], failures };
}

export async function versionsAll(clients: SourceClient[], id: string, prerelease: boolean): Promise<string[]> {
  const settled = await Promise.allSettled(clients.map((c) => c.client.versions(id, prerelease)));
  const all = new Set<string>();
  for (const s of settled) {
    if (s.status === 'fulfilled') { s.value.forEach((v) => all.add(v)); }
  }
  return [...all].sort((a, b) => compareVersions(b, a));
}

export async function detailsFirst(clients: SourceClient[], id: string, version: string): Promise<PackageDetails> {
  let last: unknown = new Error(`No sources available for ${id}`);
  for (const c of clients) {
    try {
      return await c.client.details(id, version);
    } catch (e) {
      last = e;
    }
  }
  throw last;
}
