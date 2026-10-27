import * as path from 'node:path';
import * as os from 'node:os';
import { XMLParser } from 'fast-xml-parser';
import type { PackageSource, SourceKind } from '../core/types';
import type { DotnetCli } from '../dotnet/cli';

export interface ParsedConfig {
  filePath: string;
  sources: { name: string; url: string; protocolVersion?: string }[];
  clear: boolean;
  disabled: Record<string, boolean>; // key = lower-case source name
  credentials: Record<string, { username?: string; clearTextPassword?: string; password?: string }>; // key = encoded name
  mappings: { source: string; patterns: string[] }[];
}

export interface EffectiveConfig {
  sources: PackageSource[];
  mappings: { pattern: string; sources: string[] }[];
}

const ENCRYPTED_WARNING = 'Encrypted passwords are not supported on macOS/Linux. Use ClearTextPassword or an environment variable.';
const NUGET_ORG: PackageSource = { name: 'nuget.org', url: 'https://api.nuget.org/v3/index.json', kind: 'v3' };

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseTagValue: false,
  parseAttributeValue: false,
  isArray: (name) => name === 'add' || name === 'packageSource' || name === 'package',
});

type Node = Record<string, unknown>;
const asNode = (v: unknown): Node => (v && typeof v === 'object' ? (v as Node) : {});
const asList = (v: unknown): Node[] => (Array.isArray(v) ? v.map(asNode) : []);
const attr = (n: Node, k: string): string | undefined => {
  const v = n[`@_${k}`];
  return typeof v === 'string' ? v : undefined;
};
const isRemote = (u: string): boolean => /^[a-z][a-z0-9+.-]*:\/\//i.test(u) && !/^file:/i.test(u);

export function parseNugetConfig(xml: string, filePath: string): ParsedConfig {
  const root = asNode(asNode(parser.parse(xml)).configuration);
  const dir = path.dirname(filePath);
  const out: ParsedConfig = { filePath, sources: [], clear: false, disabled: {}, credentials: {}, mappings: [] };

  const ps = asNode(root.packageSources);
  if ('clear' in ps) { out.clear = true; }
  for (const a of asList(ps.add)) {
    const name = attr(a, 'key');
    let url = attr(a, 'value');
    if (!name || !url) { continue; }
    if (/^file:\/\//i.test(url)) { url = decodeURIComponent(url.replace(/^file:\/\//i, '')); }
    else if (!isRemote(url)) { url = path.resolve(dir, url); }
    out.sources.push({ name, url, protocolVersion: attr(a, 'protocolVersion') });
  }

  for (const a of asList(asNode(root.disabledPackageSources).add)) {
    const name = attr(a, 'key');
    if (name) { out.disabled[name.toLowerCase()] = attr(a, 'value')?.toLowerCase() === 'true'; }
  }

  for (const [elName, body] of Object.entries(asNode(root.packageSourceCredentials))) {
    const cred: ParsedConfig['credentials'][string] = {};
    for (const a of asList(asNode(body).add)) {
      const k = attr(a, 'key');
      const v = attr(a, 'value');
      if (v === undefined) { continue; }
      if (k === 'Username') { cred.username = v; }
      else if (k === 'ClearTextPassword') { cred.clearTextPassword = v; }
      else if (k === 'Password') { cred.password = v; }
    }
    out.credentials[elName] = cred;
  }

  for (const s of asList(asNode(root.packageSourceMapping).packageSource)) {
    const key = attr(s, 'key');
    if (!key) { continue; }
    const patterns = asList(s.package).map((p) => attr(p, 'pattern')).filter((p): p is string => !!p);
    out.mappings.push({ source: key, patterns });
  }
  return out;
}

function kindOf(url: string, protocolVersion?: string): SourceKind {
  if (!isRemote(url)) { return 'local'; }
  if (protocolVersion === '3' || /index\.json$/i.test(url)) { return 'v3'; }
  return 'v2';
}

const encodeName = (n: string): string => n.replace(/ /g, '_x0020_');

function expand(value: string, env: Record<string, string | undefined>): { value: string; missing?: string } {
  let missing: string | undefined;
  const v = value.replace(/%([^%]+)%/g, (m, name: string) => {
    const e = env[name];
    if (e === undefined) { missing ??= name; return m; }
    return e;
  });
  return { value: v, missing };
}

export function mergeConfigs(configs: ParsedConfig[], env: Record<string, string | undefined>): EffectiveConfig {
  const byName = new Map<string, { src: ParsedConfig['sources'][number]; cfg: ParsedConfig }>();
  const disabled = new Map<string, boolean>();
  const credFor = new Map<string, ParsedConfig['credentials'][string]>();
  let sawClear = false;

  for (const cfg of configs) {
    for (const s of cfg.sources) {
      const k = s.name.toLowerCase();
      if (!byName.has(k)) { byName.set(k, { src: s, cfg }); }
    }
    for (const [k, v] of Object.entries(cfg.disabled)) {
      if (!disabled.has(k)) { disabled.set(k, v); }
    }
    for (const [k, v] of Object.entries(cfg.credentials)) {
      const lk = k.toLowerCase();
      if (!credFor.has(lk)) { credFor.set(lk, v); }
    }
    if (cfg.clear) { sawClear = true; break; }
  }

  const sources: PackageSource[] = [];
  for (const { src } of byName.values()) {
    if (disabled.get(src.name.toLowerCase())) { continue; }
    const out: PackageSource = { name: src.name, url: src.url, kind: kindOf(src.url, src.protocolVersion) };
    const c = credFor.get(encodeName(src.name).toLowerCase());
    if (c) {
      if (c.clearTextPassword === undefined && c.password !== undefined) {
        out.warning = ENCRYPTED_WARNING;
      } else if (c.username !== undefined && c.clearTextPassword !== undefined) {
        const u = expand(c.username, env);
        const p = expand(c.clearTextPassword, env);
        const missing = u.missing ?? p.missing;
        if (missing) { out.warning = `Environment variable ${missing} is not set.`; }
        else { out.credential = { username: u.value, password: p.value }; }
      }
    }
    sources.push(out);
  }
  if (!sawClear && sources.length === 0 && byName.size === 0) { sources.push({ ...NUGET_ORG }); }

  const mapped = new Map<string, string[]>();
  for (const cfg of configs) {
    for (const m of cfg.mappings) {
      for (const p of m.patterns) {
        const list = mapped.get(p) ?? [];
        if (!list.includes(m.source)) { list.push(m.source); }
        mapped.set(p, list);
      }
    }
  }
  return { sources, mappings: [...mapped].map(([pattern, s]) => ({ pattern, sources: s })) };
}

const CONFIG_NAMES = ['nuget.config', 'NuGet.Config', 'NuGet.config'];

async function fallbackPaths(dir: string, readFile: (p: string) => Promise<string>, home: string): Promise<string[]> {
  const found: string[] = [];
  const tryDir = async (d: string, names: string[]): Promise<void> => {
    for (const n of names) {
      const p = path.join(d, n);
      try { await readFile(p); found.push(p); return; } catch { /* next */ }
    }
  };
  let cur = path.resolve(dir);
  for (;;) {
    await tryDir(cur, CONFIG_NAMES);
    const parent = path.dirname(cur);
    if (parent === cur) { break; }
    cur = parent;
  }
  await tryDir(path.join(home, '.nuget', 'NuGet'), ['NuGet.Config']);
  return found;
}

// `dotnet nuget config paths` prints closest-first (verified), which is what mergeConfigs expects.
export async function loadEffectiveConfig(
  dir: string,
  cli: Pick<DotnetCli, 'configPaths'>,
  readFile: (p: string) => Promise<string>,
  env: Record<string, string | undefined>,
  home: string = os.homedir(),
): Promise<EffectiveConfig> {
  let paths: string[];
  try {
    paths = await cli.configPaths(dir);
  } catch {
    paths = await fallbackPaths(dir, readFile, home);
  }
  const parsed: ParsedConfig[] = [];
  for (const p of paths) {
    try { parsed.push(parseNugetConfig(await readFile(p), p)); } catch { /* unreadable or invalid file: skip */ }
  }
  return mergeConfigs(parsed, env);
}
