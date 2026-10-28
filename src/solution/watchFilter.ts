import { extname } from 'node:path';

export type FsEvent = 'create' | 'change' | 'delete';

const TREE_SHAPING = new Set(['.csproj', '.props', '.targets']);

/** Whether a file-system event can change the tree. Content edits of ordinary files never do. */
export function shouldInvalidate(fsPath: string, event: FsEvent, showAllFiles: boolean): boolean {
  const ext = extname(fsPath).toLowerCase();
  if (ext === '.sln' || ext === '.slnx') return true;
  const segments = fsPath.split(/[\\/]/);
  if (segments.some((s) => s === '.git' || s === 'node_modules')) return false;
  if (!showAllFiles && segments.some((s) => s === 'bin' || s === 'obj')) return false;
  return event !== 'change' || TREE_SHAPING.has(ext);
}
