import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const menus = pkg.contributes.menus as Record<string, Array<{ command?: string; submenu?: string; when?: string }>>;
const FILE_OPS = new Set(['newItem', 'newClass', 'newInterface', 'newFolder', 'addExistingItem', 'rename', 'delete', 'copy', 'paste', 'copyPath', 'revealInFinder', 'openInTerminal']);
const regexOf = (when: string) => new RegExp(/viewItem =~ \/(.*)\/$/.exec(when)![1]);

const clauses = [
  ...menus['csharpWorkbench.add'].filter((m) => FILE_OPS.has(m.command!.replace('csharpWorkbench.', ''))),
  ...menus['view/item/context'].filter((m) => m.submenu === 'csharpWorkbench.add' || FILE_OPS.has((m.command ?? '').replace('csharpWorkbench.', ''))),
].filter((m) => m.when);

describe('file-operation menu scopes', () => {
  it('found the clauses', () => expect(clauses.length).toBeGreaterThan(10));
  it('never match reference nodes', () => {
    for (const m of clauses) {
      const re = regexOf(m.when!);
      expect(re.test('cw.projectRef'), m.when).toBe(false);
      expect(re.test('cw.projectRefs'), m.when).toBe(false);
    }
  });
  it('still match projects and folders where intended', () => {
    const add = menus['csharpWorkbench.add'].find((m) => m.command === 'csharpWorkbench.newItem')!;
    for (const v of ['cw.project', 'cw.project.startup', 'cw.folder']) expect(regexOf(add.when!).test(v)).toBe(true);
  });
});
