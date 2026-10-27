import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PackageSource } from '../../../src/core/types';
import { createFeedClient } from '../../../src/nuget/feeds';
import { createLocalClient, parseNuspec } from '../../../src/nuget/feeds/local';
import { FeedError } from '../../../src/nuget/feeds/types';
import type { HttpGet } from '../../../src/nuget/http';

const dir = (n: string): string => join(__dirname, '../../fixtures/local', n);
const mk = (n: string): PackageSource => ({ name: n, url: dir(n), kind: 'local' });
const opts = { prerelease: true, skip: 0, take: 20 };

describe('local client', () => {
  it('local search finds by description case-insensitively', async () => {
    const c = createLocalClient(mk('flat'), fs);
    const r = await c.search('HANDY util', opts);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ id: 'Foo', latestVersion: '1.10.0', sources: ['flat'] });
    expect(r[0].totalDownloads).toBeUndefined();
    expect(await c.search('foo', opts)).toHaveLength(1);
    expect(await c.search('nomatch', opts)).toEqual([]);
  });

  it('local supports flat and hierarchical layouts', async () => {
    expect(await createLocalClient(mk('flat'), fs).versions('foo', true)).toEqual(['1.10.0', '1.0.0']);
    const hier = createLocalClient(mk('hier'), fs);
    expect(await hier.versions('foo', false)).toEqual(['2.0.0']);
    expect((await hier.search('', opts)).map((r) => r.id)).toEqual(['foo']);
  });

  it('local details read nuspec dependencies per framework', async () => {
    const d = await createLocalClient(mk('flat'), fs).details('Foo', '1.0.0');
    expect(d).toMatchObject({ id: 'Foo', version: '1.0.0', authors: 'Acme', license: 'MIT',
      projectUrl: 'https://example.com/Foo' });
    expect(d.dependencies).toEqual([
      { framework: 'net8.0', packages: [{ id: 'Bar', range: '[1.10.0, )' }] },
      { framework: '.NETStandard2.0', packages: [] },
    ]);
  });

  it('missing package and missing folder raise FeedError', async () => {
    await expect(createLocalClient(mk('flat'), fs).details('Nope', '1.0.0')).rejects.toBeInstanceOf(FeedError);
    await expect(createLocalClient({ ...mk('x'), url: dir('does-not-exist') }, fs).versions('a', true))
      .rejects.toBeInstanceOf(FeedError);
  });

  it('nuspec keeps trailing zeros in versions', () => {
    const d = parseNuspec('<package><metadata><id>A</id><version>1.10</version><description>d</description></metadata></package>');
    expect(d.version).toBe('1.10');
  });
});

describe('createFeedClient', () => {
  it('factory picks client by kind', async () => {
    const http: HttpGet = async () => ({ status: 200, body: new TextEncoder().encode('{"resources":[]}') });
    const local = createFeedClient(mk('flat'), { http, fs });
    expect(await local.versions('Foo', true)).toEqual(['1.10.0', '1.0.0']);
    const v3 = createFeedClient({ name: 'n', url: 'https://x/index.json', kind: 'v3' }, { http, fs });
    await expect(v3.versions('a', true)).rejects.toThrow(/PackageBaseAddress/);
    const atom: HttpGet = async () => ({ status: 200, body: new TextEncoder().encode('<feed xmlns="http://www.w3.org/2005/Atom"></feed>') });
    const v2 = createFeedClient({ name: 'o', url: 'https://x/api/v2', kind: 'v2' }, { http: atom, fs });
    await expect(v2.versions('a', true)).resolves.toEqual([]);
  });
});
