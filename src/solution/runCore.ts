import * as path from 'node:path';
import type { LaunchProfile } from '../launch/launchSettings';

export type TaskKind = 'build' | 'rebuild' | 'clean' | 'run';

const isSolution = (p: string) => /\.slnx?$/i.test(p);
const baseName = (p: string) => path.basename(p).replace(/\.(csproj|slnx?)$/i, '');

/** Pure description of a dotnet task. `tfm` (build/rebuild only) pins the framework of a multi-target project. */
export function dotnetTask(kind: TaskKind, target: string, _dotnet: string, tfm?: string, launchProfile?: string): { name: string; args: string[] } {
  const n = baseName(target);
  const label = isSolution(target) ? `Solution '${n}'` : n;
  const f = tfm ? ['-f', tfm] : [];
  switch (kind) {
    case 'build': return { name: `Build ${label}`, args: ['build', target, ...f] };
    case 'rebuild': return { name: `Rebuild ${label}`, args: ['build', target, '--no-incremental', ...f] };
    case 'clean': return { name: `Clean ${label}`, args: ['clean', target] };
    case 'run': return { name: `Run ${label}`, args: ['run', '--project', target, ...f, ...(launchProfile ? ['--launch-profile', launchProfile] : [])] };
  }
}

/** Expands %VAR%, $VAR and ${VAR}; unknown variables become ''. */
export function expandEnv(value: string, env: Record<string, string | undefined>): string {
  return value.replace(/%([^%]+)%|\$\{([^}]+)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_m, a?: string, b?: string, c?: string) => env[(a ?? b ?? c)!] ?? '');
}

/** Splits a command line like a shell would, honouring quotes, without any expansion. */
export function splitArgs(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let has = false;
  let quote: string | undefined;
  for (const ch of line) {
    if (quote) {
      if (ch === quote) quote = undefined; else cur += ch;
    } else if (ch === '"' || ch === "'") { quote = ch; has = true; }
    else if (/\s/.test(ch)) { if (has || cur) out.push(cur); cur = ''; has = false; }
    else cur += ch;
  }
  if (has || cur) out.push(cur);
  return out;
}

export interface DebugConfig { type: string; request: string; name: string; [key: string]: unknown }

export function debugConfigFor(
  projectPath: string, targetPath: string, name: string,
  profile?: LaunchProfile, env: Record<string, string | undefined> = {},
): DebugConfig {
  const projDir = path.dirname(projectPath);
  const base: DebugConfig = {
    type: 'coreclr', request: 'launch', name: `C# Workbench: ${name}`, program: targetPath,
    cwd: projDir, console: 'integratedTerminal', stopAtEntry: false,
  };
  if (!profile) return base;
  const config: DebugConfig = { ...base };
  if (profile.commandName === 'Executable' && profile.executablePath) config.program = expandEnv(profile.executablePath, env);
  if (profile.commandLineArgs) config.args = splitArgs(profile.commandLineArgs);
  const penv: Record<string, string> = {};
  for (const [k, v] of Object.entries(profile.environmentVariables)) penv[k] = expandEnv(v, env);
  if (profile.commandName === 'Project' && profile.applicationUrl) penv.ASPNETCORE_URLS = profile.applicationUrl;
  if (Object.keys(penv).length) config.env = penv;
  if (profile.workingDirectory) config.cwd = path.resolve(projDir, expandEnv(profile.workingDirectory, env));
  if (profile.launchBrowser) {
    config.serverReadyAction = {
      action: 'openExternally', pattern: '\\bNow listening on:\\s+(https?://\\S+)', uriFormat: '%s/' + (profile.launchUrl ?? ''),
    };
  }
  return config;
}

/** Pure description of running an Executable launch profile (Run); the same expansion rules as Debug. */
export function executableRun(
  profile: LaunchProfile, projectDir: string, env: Record<string, string | undefined> = {},
): { name: string; file: string; args: string[]; cwd: string; env: Record<string, string> } {
  const file = expandEnv(profile.executablePath ?? '', env);
  const penv: Record<string, string> = {};
  for (const [k, v] of Object.entries(profile.environmentVariables)) penv[k] = expandEnv(v, env);
  return {
    name: `Run ${profile.name}`, file,
    args: profile.commandLineArgs ? splitArgs(profile.commandLineArgs) : [],
    cwd: profile.workingDirectory ? path.resolve(projectDir, expandEnv(profile.workingDirectory, env)) : projectDir,
    env: penv,
  };
}

/** Per-profile debug configurations of the dynamic provider (one per supported profile). */
export function profileDebugConfigs(proj: string, name: string, profiles: LaunchProfile[], env: Record<string, string | undefined>): DebugConfig[] {
  const supported = profiles.filter((p) => p.supported);
  if (!supported.length) return [{ ...debugConfigFor(proj, '', name), program: '', csharpWorkbenchProject: proj }];
  return supported.map((p) => {
    const exe = p.commandName === 'Executable' && !!p.executablePath;
    const c = debugConfigFor(proj, '', `${name} (${p.name})`, p, env);
    return { ...c, ...(exe ? { csharpWorkbenchKeepProgram: true } : { program: '' }), csharpWorkbenchProject: proj };
  });
}

/** Decides what to do with a `TargetPath` evaluation: use it, retry with the first TFM, or give up. */
export function targetPathStep(output: string, tfms: readonly string[]):
  { kind: 'path'; path: string } | { kind: 'retry'; tfm: string } | { kind: 'fail' } {
  const lines = output.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 1) return { kind: 'path', path: lines[0] };
  return tfms.length ? { kind: 'retry', tfm: tfms[0] } : { kind: 'fail' };
}

/** `dotnet run` needs an explicit framework only for multi-target projects: the first one. */
export const runTfm = (tfms: readonly string[]): string | undefined => (tfms.length > 1 ? tfms[0] : undefined);

/**
 * Resolves with the process exit code of one task execution. A task-end event alone only starts a grace
 * period, so a process-end event that races it still wins; otherwise the result is `undefined`.
 */
export function createEndWaiter<E>(setTimer: (fn: () => void, ms: number) => unknown, clearTimer: (t: unknown) => void, graceMs: number) {
  let target: E | undefined;
  let hasTarget = false;
  let settled = false;
  let timer: unknown;
  let res: (code: number | undefined) => void = () => undefined;
  const promise = new Promise<number | undefined>((r) => { res = r; });
  const procs: Array<{ e: E; code: number | undefined }> = [];
  const taskEnds: E[] = [];
  const dispose = () => { if (timer !== undefined) { clearTimer(timer); timer = undefined; } };
  const resolve = (code: number | undefined) => { if (settled) return; settled = true; dispose(); res(code); };
  const evaluate = () => {
    if (!hasTarget || settled) return;
    const p = procs.find((x) => x.e === target);
    if (p) resolve(p.code);
    else if (taskEnds.includes(target as E) && timer === undefined) timer = setTimer(() => { timer = undefined; resolve(undefined); }, graceMs);
  };
  return {
    promise,
    setExecution(e: E) { target = e; hasTarget = true; evaluate(); },
    onProcessEnd(e: E, code: number | undefined) { procs.push({ e, code }); evaluate(); },
    onTaskEnd(e: E) { taskEnds.push(e); evaluate(); },
    dispose,
  };
}
