import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { PackageSource } from '../../../src/core/types';
import { FeedError } from '../../../src/nuget/feeds/types';
import { createV3Client } from '../../../src/nuget/feeds/v3';
import { createHttp, type HttpGet } from '../../../src/nuget/http';

const fx = (n: string): string => readFileSync(join(__dirname, '../../fixtures/v3', n), 'utf8');
const src: PackageSource = { name: 'nuget.org', url: 'https://api.nuget.org/v3/index.json', kind: 'v3' };
const R = 'https://api.nuget.org/v3/registration5-gz-semver2/';

function fake(routes: Record<string, string | number>, calls: string[] = []): HttpGet {
  return async (url) => {
    calls.push(url);
    const hit = Object.entries(routes).find(([k]) => url === k || url.startsWith(k + '?'));
    if (!hit) { return { status: 404, body: new Uint8Array() }; }
    if (typeof hit[1] === 'number') { return { status: hit[1], body: new Uint8Array() }; }
    return { status: 200, body: new TextEncoder().encode(hit[1]) };
  };
}

const base = (): Record<string, string | number> => ({
  [src.url]: fx('index.json'),
  [`${R}serilog/index.json`]: fx('registration-index.json'),
  [`${R}serilog/page/3.0.2-dev-02042/4.3.0-dev-02358.json`]: fx('registration-page.json'),
});

describe('v3 client', () => {
  it('search maps id, description, version, downloads', async () => {
    const calls: string[] = [];
    const c = createV3Client(src, fake({ [src.url]: fx('index.json'),
      'https://azuresearch-usnc.nuget.org/query': fx('search-serilog.json') }, calls));
    const r = await c.search('serilog', { prerelease: false, skip: 0, take: 2 });
    expect(r[0].id).toBe('Serilog');
    expect(r[0].description).not.toBe('');
    expect(r[0].latestVersion).toMatch(/^\d/);
    expect(r[0].totalDownloads).toBeGreaterThan(0);
    expect(r[0].sources).toEqual(['nuget.org']);
    const q = new URL(calls[1]).searchParams;
    expect(q.get('semVerLevel')).toBe('2.0.0');
    expect(q.get('prerelease')).toBe('false');
    expect(q.get('q')).toBe('serilog');
  });

  it('versions excludes prerelease unless asked and sorts descending', async () => {
    const calls: string[] = [];
    const c = createV3Client(src, fake({ [src.url]: fx('index.json'),
      'https://api.nuget.org/v3-flatcontainer/serilog/index.json': fx('flat-versions.json') }, calls));
    expect(await c.versions('Serilog', false)).toEqual(['4.4.0', '4.3.0', '4.2.0', '4.1.0', '4.0.0']);
    const all = await c.versions('Serilog', true);
    expect(all[0]).toBe('4.4.1-dev-02453');
    expect(all.indexOf('4.3.0')).toBeLessThan(all.indexOf('4.3.0-dev-02360'));
  });

  it('details reads deprecation and vulnerabilities', async () => {
    const dep = createV3Client(src, fake({ [src.url]: fx('index.json'),
      [`${R}microsoft.azure.servicebus/index.json`]: fx('registration-deprecated.json') }));
    const d = await dep.details('Microsoft.Azure.ServiceBus', '5.2.0');
    expect(d.deprecation?.reasons).toEqual(['Legacy']);
    expect(d.deprecation?.alternate).toBe('Azure.Messaging.ServiceBus');
    expect(d.deprecation?.message).toContain('obsolete');

    const vul = createV3Client(src, fake({ [src.url]: fx('index.json'),
      [`${R}newtonsoft.json/index.json`]: fx('registration-vulnerable.json') }));
    const v = await vul.details('Newtonsoft.Json', '12.0.1');
    expect(v.vulnerabilities).toEqual([
      { severity: '2', advisoryUrl: 'https://github.com/advisories/GHSA-5crp-9r3c-p9vr' }]);
  });

  it('details follows non-inline pages and picks the one containing the version', async () => {
    const calls: string[] = [];
    const c = createV3Client(src, fake(base(), calls));
    const d = await c.details('Serilog', '4.2.0');
    expect(d.version).toBe('4.2.0');
    expect(d.license).toBe('Apache-2.0');
    expect(d.dependencies.length).toBeGreaterThan(0);
    expect(d.deprecation).toBeUndefined();
    expect(calls.some((u) => u.includes('page/3.0.2-dev-02042'))).toBe(true);
    expect(calls.some((u) => u.includes('page/4.3.0-dev-02360'))).toBe(false);
  });

  it('details includes readme when template present', async () => {
    const calls: string[] = [];
    const c = createV3Client(src, fake({ ...base(),
      'https://api.nuget.org/v3-flatcontainer/serilog/4.2.0/readme': fx('readme.md') }, calls));
    expect((await c.details('Serilog', '4.2.0')).readme).toContain('# Serilog');
  });

  it('readme 404 means no readme, not an error', async () => {
    const c = createV3Client(src, fake(base()));
    expect((await c.details('Serilog', '4.2.0')).readme).toBeUndefined();
  });

  it('retries the service index after a failed fetch', async () => {
    let n = 0;
    const ok = fake({ [src.url]: fx('index.json'),
      'https://azuresearch-usnc.nuget.org/query': fx('search-serilog.json') });
    const http: HttpGet = async (url) =>
      (url === src.url && n++ === 0) ? { status: 503, body: new Uint8Array() } : ok(url);
    const c = createV3Client(src, http);
    await expect(c.search('serilog', { prerelease: false, skip: 0, take: 1 })).rejects.toBeInstanceOf(FeedError);
    expect((await c.search('serilog', { prerelease: false, skip: 0, take: 1 }))[0].id).toBe('Serilog');
  });

  it('401 throws FeedError with status 401', async () => {
    const c = createV3Client(src, fake({ [src.url]: 401 }));
    const err = await c.search('x', { prerelease: true, skip: 0, take: 1 }).catch((e) => e);
    expect(err).toBeInstanceOf(FeedError);
    expect(err.status).toBe(401);
    expect(err.source).toBe('nuget.org');
  });
});

describe('createHttp', () => {
  it('adds basic auth header when credential set', async () => {
    const f = vi.fn(async () => new Response('ok'));
    await createHttp({ ...src, credential: { username: 'u', password: 'p' } }, f as unknown as typeof fetch)('https://x/y');
    const init = (f.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect((init.headers as Record<string, string>).Authorization).toBe('Basic dTpw');
  });

  it('wraps network errors in FeedError', async () => {
    const f = vi.fn(async () => { throw new Error('boom'); });
    const err = await createHttp(src, f as unknown as typeof fetch)('https://x').catch((e) => e);
    expect(err).toBeInstanceOf(FeedError);
    expect(err.source).toBe('nuget.org');
  });
});
