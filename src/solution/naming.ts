import { isAbsolute, relative, sep } from 'node:path';

const KEYWORDS = new Set((
  'abstract as base bool break byte case catch char checked class const continue decimal default delegate do double ' +
  'else enum event explicit extern false finally fixed float for foreach goto if implicit in int interface internal is ' +
  'lock long namespace new null object operator out override params private protected public readonly ref return sbyte ' +
  'sealed short sizeof stackalloc static string struct switch this throw true try typeof uint ulong unchecked unsafe ' +
  'ushort using virtual void volatile while'
).split(' '));

export function toIdentifier(s: string): string {
  let r = s.replace(/[^\p{L}\p{Nd}_]/gu, '_');
  if (r === '') return '_';
  if (/^\p{Nd}/u.test(r)) r = `_${r}`;
  return KEYWORDS.has(r) ? `@${r}` : r;
}

export function namespaceFor(rootNamespace: string, projectDir: string, folderDir: string): string {
  const root = rootNamespace.split('.').map(toIdentifier).join('.');
  const rel = relative(projectDir, folderDir);
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return root;
  return [root, ...rel.split(sep).filter(Boolean).map(toIdentifier)].join('.');
}
