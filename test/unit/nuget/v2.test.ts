import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PackageSource } from '../../../src/core/types';
import { createV2Client } from '../../../src/nuget/feeds/v2';
import { FeedError } from '../../../src/nuget/feeds/types';
import type { HttpGet } from '../../../src/nuget/http';

const fx = (n: string): string => readFileSync(join(__dirname, '../../fixtures/v2', n), 'utf8');
const src: PackageSource = { name: 'old', url: 'https://www.nuget.org/api/v2/', kind: 'v2' };

function fake(body: string, status = 200, calls: string[] = []): HttpGet {
  return async (url) => { calls.push(url); return { status, body: new TextEncoder().encode(body) }; };
}

describe('v2 client', () => {
  it('v2 search parses atom entries', async () => {
    const calls: string[] = [];
    const c = createV2Client(src, fake(fx('search.xml'), 200, calls));
    const r = await c.search('serilog', { prerelease: false, skip: 0, take: 2 });
    expect(r.map((p) => p.id)).toEqual(['Serilog', 'Serilog.Sinks.File']);
    expect(r[0].latestVersion).toBe('4.4.0');
    expect(r[0].description).toContain('structured');
    expect(r[0].totalDownloads).toBeGreaterThan(0);
    expect(r[0].sources).toEqual(['old']);
    expect(calls[0]).toContain("Search()?searchTerm='serilog'");
    expect(calls[0]).toContain('includePrerelease=false');
    expect(calls[0]).toContain('$skip=0');
    expect(calls[0]).toContain('$top=2');
  });

  it('v2 versions from FindPackagesById', async () => {
    const calls: string[] = [];
    const c = createV2Client(src, fake(fx('findById.xml'), 200, calls));
    expect(await c.versions('Serilog', false)).toEqual(['2.10.0', '2.7.1', '0.1.6']);
    expect(await c.versions('Serilog', true)).toEqual(['2.10.0', '2.7.1', '2.7.1-dev-00990', '0.1.6']);
    expect(calls[0]).toContain("FindPackagesById()?id='Serilog'");
  });

  it('v2 details parse dependencies per framework', async () => {
    const calls: string[] = [];
    const c = createV2Client(src, fake(fx('details.xml'), 200, calls));
    const d = await c.details('Serilog', '4.4.0');
    expect(calls[0]).toBe("https://www.nuget.org/api/v2/Packages(Id='Serilog',Version='4.4.0')");
    expect(d.version).toBe('4.4.0');
    expect(d.readme).toBeUndefined();
    expect(d.projectUrl).toBe('https://serilog.net/');
    const net462 = d.dependencies.find((g) => g.framework === 'net462');
    expect(net462?.packages).toContainEqual({ id: 'System.Threading.Channels', range: '8.0.0' });
    expect(d.dependencies.find((g) => g.framework === 'net8.0')?.packages).toEqual([]);
  });

  it('non-2xx becomes FeedError', async () => {
    const c = createV2Client(src, fake('', 401));
    await expect(c.versions('x', true)).rejects.toMatchObject({ name: 'FeedError', source: 'old', status: 401 });
  });

  it('malformed xml becomes FeedError', async () => {
    const c = createV2Client(src, fake('<feed><entry>'));
    await expect(c.search('x', { prerelease: true, skip: 0, take: 1 })).rejects.toBeInstanceOf(FeedError);
  });
});
