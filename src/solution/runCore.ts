import * as path from 'node:path';

export type TaskKind = 'build' | 'rebuild' | 'clean' | 'run';

const isSolution = (p: string) => /\.slnx?$/i.test(p);
const baseName = (p: string) => path.basename(p).replace(/\.(csproj|slnx?)$/i, '');

/** Pure description of a dotnet task. `tfm` (build/rebuild only) pins the framework of a multi-target project. */
export function dotnetTask(kind: TaskKind, target: string, _dotnet: string, tfm?: string): { name: string; args: string[] } {
  const n = baseName(target);
  const label = isSolution(target) ? `Solution '${n}'` : n;
  const f = tfm ? ['-f', tfm] : [];
  switch (kind) {
    case 'build': return { name: `Build ${label}`, args: ['build', target, ...f] };
    case 'rebuild': return { name: `Rebuild ${label}`, args: ['build', target, '--no-incremental', ...f] };
    case 'clean': return { name: `Clean ${label}`, args: ['clean', target] };
    case 'run': return { name: `Run ${label}`, args: ['run', '--project', target, ...f] };
  }
}

export function debugConfigFor(projectPath: string, targetPath: string, name: string) {
  return {
    type: 'coreclr', request: 'launch', name: `C# Workbench: ${name}`, program: targetPath,
    cwd: path.dirname(projectPath), console: 'integratedTerminal', stopAtEntry: false,
  };
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
