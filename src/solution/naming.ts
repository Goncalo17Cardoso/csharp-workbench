import { isAbsolute, relative, sep } from 'node:path';
import { toIdentifier } from './identifier';

export { toIdentifier };

export function namespaceFor(rootNamespace: string, projectDir: string, folderDir: string): string {
  const root = rootNamespace.split('.').map(toIdentifier).join('.');
  const rel = relative(projectDir, folderDir);
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return root;
  return [root, ...rel.split(sep).filter(Boolean).map(toIdentifier)].join('.');
}
