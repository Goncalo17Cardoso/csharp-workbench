import { basename, resolve } from 'node:path';
import type { PackageRef, ProjectInfo, ProjectPackages } from '../core/types';

const projectName = (p: string): string => basename(p).replace(/\.csproj$/i, '');

/** Parses `dotnet sln list` output: 2 header lines, then one relative path per line. */
export function parseSlnList(stdout: string, slnDir: string): ProjectInfo[] {
  return stdout
    .split(/\r?\n/)
    .slice(2)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((rel) => {
      const path = resolve(slnDir, rel.replace(/\\/g, '/'));
      return { path, name: projectName(path) };
    });
}

interface RawPkg { id: string; requestedVersion?: string; resolvedVersion?: string; latestVersion?: string }
interface RawJson {
  projects?: { path: string; frameworks?: { framework: string; topLevelPackages?: RawPkg[] }[] }[];
}

/** Parses `dotnet list package --format json`; one PackageRef per (package, framework). */
export function parseListPackageJson(json: string): ProjectPackages[] {
  // Tolerate any notice text printed before the JSON document.
  const start = json.indexOf('{');
  const data = JSON.parse(start >= 0 ? json.slice(start) : json) as RawJson;
  return (data.projects ?? []).map((p) => {
    const packages: PackageRef[] = [];
    for (const fw of p.frameworks ?? []) {
      for (const t of fw.topLevelPackages ?? []) {
        packages.push({
          id: t.id,
          requested: t.requestedVersion,
          resolved: t.resolvedVersion,
          latest: t.latestVersion,
          framework: fw.framework,
        });
      }
    }
    return { project: { path: p.path, name: projectName(p.path) }, packages };
  });
}

export function parseSdkVersion(stdout: string): string {
  return stdout.trim().split(/\r?\n/)[0].trim();
}

export interface EvaluatedItem { identity: string; fullPath: string; link?: string }

interface RawItem { Identity: string; FullPath: string; Link?: string }

/** Parses `dotnet msbuild -getItem:...` JSON into items per type; Link separators are normalised to `/`. */
export function parseGetItems(json: string): Record<string, EvaluatedItem[]> {
  const start = json.indexOf('{');
  const data = JSON.parse(start >= 0 ? json.slice(start) : json) as { Items?: Record<string, RawItem[]> };
  const out: Record<string, EvaluatedItem[]> = {};
  for (const [type, items] of Object.entries(data.Items ?? {})) {
    out[type] = items.map((i) => ({
      identity: i.Identity,
      fullPath: i.FullPath,
      ...(i.Link ? { link: i.Link.replace(/\\/g, '/') } : {}),
    }));
  }
  return out;
}
