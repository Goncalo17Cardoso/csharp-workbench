// Pure module: no vscode, fs or node imports (webview-safe).
import { applyEdits, type ParseError, findNodeAtLocation, getNodeValue, modify, parse, parseTree, type FormattingOptions } from 'jsonc-parser';

export interface LaunchProfile {
  name: string;
  commandName: string;
  supported: boolean;
  commandLineArgs?: string;
  workingDirectory?: string;
  environmentVariables: Record<string, string>;
  applicationUrl?: string;
  launchBrowser?: boolean;
  launchUrl?: string;
  executablePath?: string;
}

export type ProfileAction =
  | { kind: 'new'; name: string; commandName: 'Project' | 'Executable' }
  | { kind: 'duplicate'; from: string; name: string }
  | { kind: 'rename'; from: string; name: string }
  | { kind: 'delete'; name: string }
  | { kind: 'set'; name: string; field: keyof Omit<LaunchProfile, 'name' | 'supported' | 'environmentVariables'>; value: string | boolean | undefined }
  | { kind: 'env'; name: string; env: Record<string, string> };

export class ProfileError extends Error {
  constructor(public code: 'exists' | 'missing' | 'emptyName' | 'invalid', message: string) {
    super(message);
    this.name = 'ProfileError';
  }
}

export function launchSettingsPath(projectPath: string): string {
  const i = Math.max(projectPath.lastIndexOf('/'), projectPath.lastIndexOf('\\'));
  const dir = i >= 0 ? projectPath.slice(0, i) : '.';
  const sep = projectPath.includes('\\') && !projectPath.includes('/') ? '\\' : '/';
  return `${dir}${sep}Properties${sep}launchSettings.json`;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown) => (typeof v === 'string' ? v : undefined);

// `dotnet new` writes launchSettings.json with a UTF-8 BOM, which jsonc-parser reports as an error.
const BOM = '\uFEFF';
const stripBom = (t: string) => (t.startsWith(BOM) ? t.slice(1) : t);

/** True when the text is empty (no file yet) or a JSON object, allowing comments, trailing commas and a BOM. */
export function isValidLaunchSettings(text: string | undefined): boolean {
  if (!text?.trim()) return true;
  const errors: ParseError[] = [];
  return isObj(parse(stripBom(text), errors, { allowTrailingComma: true })) && errors.length === 0;
}

export function parseProfiles(text: string | undefined): LaunchProfile[] {
  if (!text) return [];
  text = stripBom(text);
  let root: unknown;
  try { root = parse(text, [], { allowTrailingComma: true }); } catch { return []; }
  if (!isObj(root) || !isObj(root.profiles)) return [];
  const out: LaunchProfile[] = [];
  for (const [name, v] of Object.entries(root.profiles)) {
    if (!isObj(v)) continue;
    const commandName = str(v.commandName) ?? '';
    const env: Record<string, string> = {};
    if (isObj(v.environmentVariables)) for (const [k, e] of Object.entries(v.environmentVariables)) if (typeof e === 'string' || typeof e === 'number' || typeof e === 'boolean') env[k] = String(e);
    const p: LaunchProfile = { name, commandName, supported: commandName === 'Project' || commandName === 'Executable', environmentVariables: env };
    for (const f of ['commandLineArgs', 'workingDirectory', 'applicationUrl', 'launchUrl', 'executablePath'] as const) {
      const s = str(v[f]);
      if (s !== undefined) p[f] = s;
    }
    if (typeof v.launchBrowser === 'boolean') p.launchBrowser = v.launchBrowser;
    out.push(p);
  }
  return out;
}

function detectFormat(text: string): FormattingOptions {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const m = /^([ \t]+)\S/m.exec(text);
  if (m && m[1][0] === '\t') return { insertSpaces: false, tabSize: 1, eol };
  return { insertSpaces: true, tabSize: m ? m[1].length : 2, eol };
}

export function applyProfileAction(text: string | undefined, action: ProfileAction): string {
  const bom = text?.startsWith(BOM) ? BOM : '';
  if (bom) text = stripBom(text!);
  let src = text && text.trim() ? text : '{"profiles":{}}';
  const errors: ParseError[] = [];
  const parsed = parse(src, errors, { allowTrailingComma: true });
  if (errors.length || !isObj(parsed)) throw new ProfileError('invalid', 'launchSettings.json is not a valid JSON object');
  const fmt = detectFormat(text ?? '');
  const opts = { formattingOptions: fmt };
  const edit = (path: (string | number)[], value: unknown) => { src = applyEdits(src, modify(src, path, value, opts)); };

  // Ensure a profiles object exists (e.g. "{}" or non-object profiles).
  const root = parse(src, [], { allowTrailingComma: true });
  if (!isObj(root) || !isObj(root.profiles)) edit(['profiles'], {});
  const has = (n: string) =>
    !!findNodeAtLocation(parseTree(src, [], { allowTrailingComma: true })!, ['profiles'])?.children?.some((c) => c.children?.[0]?.value === n);
  const need = (n: string) => { if (!has(n)) throw new ProfileError('missing', `Profile not found: ${n}`); };
  const fresh = (n: string) => {
    if (!n.trim()) throw new ProfileError('emptyName', 'Profile name is empty');
    if (has(n)) throw new ProfileError('exists', `Profile already exists: ${n}`);
  };

  switch (action.kind) {
    case 'new':
      fresh(action.name);
      edit(['profiles', action.name], { commandName: action.commandName });
      break;
    case 'duplicate': {
      need(action.from);
      fresh(action.name);
      const tree = parseTree(src, [], { allowTrailingComma: true })!;
      edit(['profiles', action.name], getNodeValue(findNodeAtLocation(tree, ['profiles', action.from])!));
      break;
    }
    case 'rename': {
      need(action.from);
      if (action.name === action.from) break;
      fresh(action.name);
      // Replace only the key token, so order, comments and all other bytes stay identical.
      const tree = parseTree(src, [], { allowTrailingComma: true })!;
      const prop = findNodeAtLocation(tree, ['profiles'])!.children!.find((c) => c.children?.[0]?.value === action.from)!;
      const key = prop.children![0];
      src = src.slice(0, key.offset) + JSON.stringify(action.name) + src.slice(key.offset + key.length);
      break;
    }
    case 'delete':
      need(action.name);
      edit(['profiles', action.name], undefined);
      break;
    case 'set':
      need(action.name);
      edit(['profiles', action.name, action.field], action.value);
      break;
    case 'env':
      need(action.name);
      edit(['profiles', action.name, 'environmentVariables'], action.env);
      break;
  }
  return bom + src;
}
