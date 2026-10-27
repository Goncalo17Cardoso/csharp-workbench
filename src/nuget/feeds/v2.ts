import { XMLParser } from 'fast-xml-parser';
import type { PackageDetails, PackageSource, SearchResult } from '../../core/types';
import { compareVersions, isPrerelease } from '../../core/version';
import type { HttpGet } from '../http';
import { FeedError, type FeedClient } from './types';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Xml = any;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
  parseTagValue: false,
  parseAttributeValue: false,
  isArray: (name) => name === 'entry' || name === 'link',
});

const str = (v: any): string => (typeof v === 'string' ? v : typeof v?.['#text'] === 'string' ? v['#text'] : '');
const lit = (s: string): string => `'${s.replace(/'/g, "''")}'`;

function parseDependencies(raw: string): PackageDetails['dependencies'] {
  const groups = new Map<string, { id: string; range: string }[]>();
  for (const part of raw.split('|').filter(Boolean)) {
    const [id = '', range = '', framework = ''] = part.split(':');
    const g = groups.get(framework) ?? [];
    groups.set(framework, g);
    if (id) { g.push({ id, range }); }
  }
  return [...groups].map(([framework, packages]) => ({ framework, packages }));
}

export function createV2Client(source: PackageSource, http: HttpGet): FeedClient {
  const base = source.url.replace(/\/+$/, '');

  async function getXml(url: string): Promise<Xml> {
    const res = await http(url);
    if (res.status < 200 || res.status >= 300) {
      throw new FeedError(`${source.name}: HTTP ${res.status} for ${url}`, source.name, res.status);
    }
    try {
      const doc = parser.parse(new TextDecoder().decode(res.body), true);
      if (!('feed' in doc) && !('entry' in doc)) { throw new Error('not an Atom document'); }
      return doc;
    } catch (e) {
      throw new FeedError(`${source.name}: invalid response from ${url} (${(e as Error).message})`, source.name);
    }
  }

  const entriesOf = (doc: Xml): Xml[] => (doc.feed && typeof doc.feed === 'object' ? doc.feed.entry ?? [] : doc.feed === undefined ? doc.entry : []);

  return {
    async search(q, o) {
      const url = `${base}/Search()?searchTerm=${encodeURIComponent(lit(q))}&targetFramework=''` +
        `&includePrerelease=${o.prerelease}&$skip=${o.skip}&$top=${o.take}&semVerLevel=2.0.0`;
      const doc = await getXml(url);
      return entriesOf(doc).map((e): SearchResult => {
        const p = e.properties;
        const downloads = Number(str(p.DownloadCount));
        return {
          id: str(p.Id),
          description: str(p.Description),
          latestVersion: str(p.Version),
          totalDownloads: Number.isFinite(downloads) && str(p.DownloadCount) !== '' ? downloads : undefined,
          iconUrl: str(p.IconUrl) || undefined,
          sources: [source.name],
        };
      });
    },

    async versions(id, prerelease) {
      const out: string[] = [];
      let url: string | undefined = `${base}/FindPackagesById()?id=${encodeURIComponent(lit(id))}&semVerLevel=2.0.0`;
      for (let page = 0; url && page < 50; page++) {
        const doc: Xml = await getXml(url);
        for (const e of entriesOf(doc)) { out.push(str(e.properties.Version)); }
        const next: Xml = ((typeof doc.feed === 'object' ? doc.feed.link ?? [] : []) as Xml[]).find((l) => l['@_rel'] === 'next');
        url = next?.['@_href'];
      }
      return out.filter((v) => v && (prerelease || !isPrerelease(v))).sort((a, b) => compareVersions(b, a));
    },

    async details(id, version) {
      const url = `${base}/Packages(Id=${lit(id)},Version=${lit(version)})`;
      const [e] = entriesOf(await getXml(url));
      if (!e?.properties) { throw new FeedError(`${source.name}: ${id} ${version} not found`, source.name, 404); }
      const p = e.properties;
      return {
        id: str(p.Id) || id,
        version: str(p.Version) || version,
        description: str(p.Description),
        authors: str(p.Authors) || undefined,
        licenseUrl: str(p.LicenseUrl) || undefined,
        projectUrl: str(p.ProjectUrl) || undefined,
        dependencies: parseDependencies(str(p.Dependencies)),
      };
    },
  };
}
