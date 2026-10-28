import { basename, dirname, resolve } from 'node:path';
import { XMLParser } from 'fast-xml-parser';
import type { ProjectInfoData } from './model';

// Values stay strings: `1.10` must not become the number 1.1.
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', parseTagValue: false, parseAttributeValue: false });
const asArray = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

function text(v: any): string | undefined {
  if (v === undefined || v === null) return undefined;
  const s = String(typeof v === 'object' ? (v['#text'] ?? '') : v).trim();
  return s === '' ? undefined : s;
}

/** Last unconditional value of a property across all PropertyGroups; conditional groups are ignored. */
function prop(root: any, name: string): string | undefined {
  let value: string | undefined;
  for (const g of asArray<any>(root.PropertyGroup)) {
    if (!g || typeof g !== 'object' || g['@_Condition'] !== undefined) continue;
    const el = g[name];
    if (el === undefined) continue;
    const last = asArray<any>(el).filter((e) => !(e && typeof e === 'object' && e['@_Condition'] !== undefined));
    const v = text(last[last.length - 1]);
    if (v !== undefined) value = v;
  }
  return value;
}

function fileScoped(langVersion: string | undefined, tfms: string[]): boolean {
  if (langVersion !== undefined) {
    const lv = langVersion.toLowerCase();
    if (['latest', 'preview', 'default', 'latestmajor'].includes(lv)) return true;
    const n = parseFloat(lv);
    return Number.isFinite(n) && n >= 10;
  }
  return tfms.length > 0 && tfms.every((t) => {
    const m = /^net(\d+)\.\d+/.exec(t);
    return !!m && Number(m[1]) >= 6;
  });
}

export function readProjectInfo(csprojPath: string, xml: string): ProjectInfoData {
  const root = parser.parse(xml)?.Project;
  const r = root && typeof root === 'object' ? root : {};
  const tfmRaw = prop(r, 'TargetFrameworks') ?? prop(r, 'TargetFramework') ?? '';
  const targetFrameworks = tfmRaw.split(';').map((s) => s.trim()).filter(Boolean);
  const dir = dirname(csprojPath);
  const projectRefs = asArray<any>(r.ItemGroup)
    .flatMap((g) => asArray<any>(g?.ProjectReference))
    .map((n) => text(n?.['@_Include']))
    .filter((p): p is string => !!p)
    .map((p) => resolve(dir, p.replace(/\\/g, '/')));
  return {
    path: csprojPath,
    rootNamespace: prop(r, 'RootNamespace') ?? basename(csprojPath).replace(/\.csproj$/i, ''),
    targetFrameworks,
    projectRefs,
    userSecretsId: prop(r, 'UserSecretsId'),
    fileScopedNamespaces: fileScoped(prop(r, 'LangVersion'), targetFrameworks),
  };
}
