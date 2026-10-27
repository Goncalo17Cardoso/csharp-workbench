import type { PackageDetails, PackageSource, SearchResult } from '../../core/types';
import { compareVersions, isPrerelease } from '../../core/version';
import type { HttpGet } from '../http';
import { FeedError, type FeedClient } from './types';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

export function createV3Client(source: PackageSource, http: HttpGet): FeedClient {
  let index: Promise<Json[]> | undefined;

  async function getJson(url: string): Promise<Json> {
    const res = await http(url);
    if (res.status < 200 || res.status >= 300) {
      throw new FeedError(`${source.name}: HTTP ${res.status} for ${url}`, source.name, res.status);
    }
    return JSON.parse(new TextDecoder().decode(res.body));
  }

  async function resource(prefix: string, exact = false): Promise<string | undefined> {
    index ??= getJson(source.url).then((d) => d.resources as Json[]);
    const rs = (await index).filter((r) => (exact ? r['@type'] === prefix : String(r['@type']).startsWith(prefix)));
    return rs[0]?.['@id'];
  }

  async function registrationBase(): Promise<string> {
    index ??= getJson(source.url).then((d) => d.resources as Json[]);
    const rs = (await index).filter((r) => /^RegistrationsBaseUrl\/\d/.test(r['@type']));
    rs.sort((a, b) => compareVersions(b['@type'].split('/')[1], a['@type'].split('/')[1]));
    const id = rs[0]?.['@id'] ?? (await resource('RegistrationsBaseUrl', true));
    if (!id) { throw new FeedError(`${source.name}: no registration resource`, source.name); }
    return id.endsWith('/') ? id : id + '/';
  }

  async function flatBase(): Promise<string> {
    const id = await resource('PackageBaseAddress/');
    if (!id) { throw new FeedError(`${source.name}: no PackageBaseAddress resource`, source.name); }
    return id.endsWith('/') ? id : id + '/';
  }

  return {
    async search(q, o) {
      const base = await resource('SearchQueryService', true);
      if (!base) { throw new FeedError(`${source.name}: no SearchQueryService resource`, source.name); }
      const params = new URLSearchParams({
        q, skip: String(o.skip), take: String(o.take),
        prerelease: String(o.prerelease), semVerLevel: '2.0.0',
      });
      const data = await getJson(`${base}?${params}`);
      return (data.data as Json[]).map((p): SearchResult => ({
        id: p.id,
        description: p.description ?? '',
        latestVersion: p.version,
        totalDownloads: p.totalDownloads,
        iconUrl: p.iconUrl || undefined,
        sources: [source.name],
      }));
    },

    async versions(id, prerelease) {
      const data = await getJson(`${await flatBase()}${id.toLowerCase()}/index.json`);
      return (data.versions as string[])
        .filter((v) => prerelease || !isPrerelease(v))
        .sort((a, b) => compareVersions(b, a));
    },

    async details(id, version) {
      const reg = await getJson(`${await registrationBase()}${id.toLowerCase()}/index.json`);
      const pages = (reg.items as Json[]).filter(
        (p) => compareVersions(p.lower, version) <= 0 && compareVersions(version, p.upper) <= 0);
      let entry: Json | undefined;
      for (const page of pages) {
        const full = page.items ? page : await getJson(page['@id']);
        entry = (full.items as Json[]).find((e) => compareVersions(e.catalogEntry.version, version) === 0);
        if (entry) { break; }
      }
      if (!entry) { throw new FeedError(`${source.name}: ${id} ${version} not found`, source.name, 404); }
      const c = entry.catalogEntry;

      const out: PackageDetails = {
        id: c.id ?? id,
        version: c.version,
        description: c.description ?? '',
        authors: c.authors || undefined,
        license: c.licenseExpression || c.license || undefined,
        licenseUrl: c.licenseUrl || undefined,
        projectUrl: c.projectUrl || undefined,
        dependencies: ((c.dependencyGroups ?? []) as Json[]).map((g) => ({
          framework: g.targetFramework ?? '',
          packages: ((g.dependencies ?? []) as Json[]).map((d) => ({ id: d.id, range: d.range })),
        })),
      };
      if (c.deprecation) {
        out.deprecation = {
          reasons: c.deprecation.reasons ?? [],
          message: c.deprecation.message || undefined,
          alternate: c.deprecation.alternatePackage?.id,
        };
      }
      if (c.vulnerabilities) {
        out.vulnerabilities = (c.vulnerabilities as Json[]).map((v) => ({
          severity: String(v.severity), advisoryUrl: v.advisoryUrl,
        }));
      }

      const template = await resource('ReadmeUriTemplate/6.13.0', true);
      if (template) {
        const url = template
          .replace('{lower_id}', id.toLowerCase())
          .replace('{lower_version}', c.version.toLowerCase());
        const res = await http(url);
        if (res.status === 404) { /* no readme */ }
        else if (res.status >= 200 && res.status < 300) { out.readme = new TextDecoder().decode(res.body); }
        else { throw new FeedError(`${source.name}: HTTP ${res.status} for ${url}`, source.name, res.status); }
      }
      return out;
    },
  };
}
