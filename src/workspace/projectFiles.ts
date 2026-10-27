import { dirname, join } from 'node:path';
import { XMLParser } from 'fast-xml-parser';
import type { CpmInfo, PackageRef } from '../core/types';

// Values stay strings: `1.10` must not become the number 1.1.
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', parseTagValue: false, parseAttributeValue: false });

const asArray = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

/** Value from an attribute or a child element, as a trimmed string. */
function field(node: any, name: string): string | undefined {
  if (!node || typeof node !== 'object') return undefined;
  const v = node[`@_${name}`] ?? node[name];
  if (v === undefined || v === null) return undefined;
  const s = String(typeof v === 'object' ? (v['#text'] ?? '') : v).trim();
  return s === '' ? undefined : s;
}

function items(xml: string, element: string): any[] {
  const root = parser.parse(xml)?.Project;
  if (!root || typeof root !== 'object') return [];
  return asArray<any>(root.ItemGroup).flatMap((g) => asArray<any>(g?.[element]));
}

export function readPackageRefs(csprojXml: string): PackageRef[] {
  const refs: PackageRef[] = [];
  for (const n of items(csprojXml, 'PackageReference')) {
    const id = field(n, 'Include');
    if (!id) continue;
    const ref: PackageRef = { id, requested: field(n, 'Version') };
    const vo = field(n, 'VersionOverride');
    if (vo) ref.versionOverride = vo;
    refs.push(ref);
  }
  return refs;
}

const strip = (p: string) => (p.length > 1 ? p.replace(/\/+$/, '') : p);

export async function findCentralPackagesFile(
  projectDir: string,
  exists: (p: string) => Promise<boolean>,
  stopAt: string,
): Promise<string | undefined> {
  const stop = strip(stopAt);
  let dir = strip(projectDir);
  for (;;) {
    const candidate = join(dir, 'Directory.Packages.props');
    if (await exists(candidate)) return candidate;
    if (dir === stop) return undefined;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

export function readCpm(propsXml: string, propsPath: string): CpmInfo | undefined {
  const root = parser.parse(propsXml)?.Project;
  if (!root || typeof root !== 'object') return undefined;
  const enabled = asArray<any>(root.PropertyGroup).some(
    (g) => field(g, 'ManagePackageVersionsCentrally')?.toLowerCase() === 'true',
  );
  if (!enabled) return undefined;
  const versions = new Map<string, string>();
  for (const n of items(propsXml, 'PackageVersion')) {
    const id = field(n, 'Include');
    const v = field(n, 'Version');
    if (id && v) versions.set(id.toLowerCase(), v);
  }
  return { propsPath, versions };
}
