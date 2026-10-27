import { describe, it, expect } from 'vitest';
import { searchAll, versionsAll, detailsFirst } from '../../../src/nuget/aggregate';
import { FeedError } from '../../../src/nuget/feeds/types';
import type { FeedClient } from '../../../src/nuget/feeds/types';
import type { PackageSource, SearchResult } from '../../../src/core/types';

const src = (name: string): PackageSource => ({ name, url: `https://${name}`, kind: 'v3' });
const r = (id: string, v: string): SearchResult => ({ id, description: '', latestVersion: v, sources: [] });
const client = (over: Partial<FeedClient>): FeedClient => ({
  search: async () => [], versions: async () => [], details: async () => { throw new Error('no'); }, ...over,
});
const o = { prerelease: false, skip: 0, take: 20 };

describe('aggregate', () => {
  it('merges same id with different casing from two sources', async () => {
    const { results } = await searchAll([
      { source: src('a'), client: client({ search: async () => [r('Serilog', '3.0.0')] }) },
      { source: src('b'), client: client({ search: async () => [r('serilog', '3.1.0')] }) },
    ], 'ser', o);
    expect(results).toHaveLength(1);
    expect(results[0].sources).toEqual(['a', 'b']);
  });

  it('failing source is reported but others still return results', async () => {
    const { results, failures } = await searchAll([
      { source: src('bad'), client: client({ search: async () => { throw new FeedError('401 Unauthorized', 'bad', 401); } }) },
      { source: src('ok'), client: client({ search: async () => [r('X', '1.0.0')] }) },
    ], 'x', o);
    expect(failures).toEqual([{ source: 'bad', message: '401 Unauthorized' }]);
    expect(results).toHaveLength(1);
  });

  it('latestVersion is the max across sources and order follows first source', async () => {
    const { results } = await searchAll([
      { source: src('a'), client: client({ search: async () => [r('B', '1.0.0'), r('A', '2.0.0-beta.9')] }) },
      { source: src('b'), client: client({ search: async () => [r('a', '2.0.0-beta.10'), r('C', '1.0.0')] }) },
    ], 'x', o);
    expect(results.map((x) => x.id)).toEqual(['B', 'A', 'C']);
    expect(results[1].latestVersion).toBe('2.0.0-beta.10');
  });

  it('versionsAll unions descending; detailsFirst takes first success', async () => {
    const cs = [
      { source: src('a'), client: client({ versions: async () => ['1.0.0', '2.0.0'] }) },
      { source: src('b'), client: client({ versions: async () => ['2.0.0', '10.0.0'], details: async (id, version) => ({ id, version, description: 'd', dependencies: [] }) }) },
    ];
    expect(await versionsAll(cs, 'x', true)).toEqual(['10.0.0', '2.0.0', '1.0.0']);
    expect((await detailsFirst(cs, 'x', '1.0.0')).description).toBe('d');
  });
});
