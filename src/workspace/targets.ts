import { basename, extname } from 'node:path';
import type { Target, TargetKind } from '../core/types';

const KINDS: Record<string, TargetKind> = { '.sln': 'sln', '.slnx': 'slnx', '.csproj': 'csproj' };

function toTarget(path: string): Target | undefined {
  const ext = extname(path).toLowerCase();
  const kind = KINDS[ext];
  return kind ? { kind, path, name: basename(path, extname(path)) } : undefined;
}

const depth = (p: string) => p.split('/').filter(Boolean).length;

/** Solutions win; standalone projects are targets only when no solution exists. */
export function selectTargets(files: string[]): Target[] {
  const all = files.map(toTarget).filter((t): t is Target => !!t);
  const sols = all.filter((t) => t.kind !== 'csproj');
  const chosen = sols.length > 0 ? sols : all;
  return chosen.sort(
    (a, b) => depth(a.path) - depth(b.path) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
  );
}
