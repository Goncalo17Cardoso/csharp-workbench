export type CodeKind = 'class' | 'interface' | 'enum' | 'record' | 'struct';

export function renderCodeTemplate(kind: CodeKind, name: string, ns: string, fileScoped: boolean): string {
  const type = [`public ${kind} ${name}`, '{', '}'];
  if (fileScoped) return `namespace ${ns};\n\n${type.join('\n')}\n`;
  return `namespace ${ns}\n{\n${type.map((l) => `    ${l}`).join('\n')}\n}\n`;
}
