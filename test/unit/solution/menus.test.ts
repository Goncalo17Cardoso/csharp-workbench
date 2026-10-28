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

describe('run menus', () => {
  const ctx = menus['view/item/context'];
  it('start-up item is hidden on the startup project, others match both', () => {
    const set = ctx.find((m) => m.command === 'csharpWorkbench.setStartupProject')!;
    expect(regexOf(set.when!).test('cw.project')).toBe(true);
    expect(regexOf(set.when!).test('cw.project.startup')).toBe(false);
    const build = ctx.find((m) => m.command === 'csharpWorkbench.build')!;
    expect(regexOf(build.when!).test('cw.project.startup')).toBe(true);
    expect(regexOf(build.when!).test('cw.projectRef')).toBe(false);
  });
});

describe('task 10 menu scopes', () => {
  const RUN = /^csharpWorkbench\.(build|rebuild|clean|run|debug|setStartupProject|buildSolution|rebuildSolution|cleanSolution)$/;
  const items = menus['view/item/context'].filter((m) => RUN.test(m.command ?? ''));
  it('covers every item', () => expect(items.length).toBe(9));
  it('never matches refs or solution folders', () => {
    for (const m of items) for (const v of ['cw.projectRef', 'cw.projectRefs', 'cw.solutionFolder'])
      expect(regexOf(m.when!).test(v), `${m.command} ${v}`).toBe(false);
  });
  it('project items match project and startup project', () => {
    for (const m of items.filter((i) => !/Solution$/.test(i.command!))) {
      expect(regexOf(m.when!).test('cw.project'), m.command).toBe(true);
      expect(regexOf(m.when!).test('cw.project.startup'), m.command).toBe(m.command !== 'csharpWorkbench.setStartupProject');
    }
  });
  it('solution items match only the solution', () => {
    for (const m of items.filter((i) => /Solution$/.test(i.command!))) {
      expect(regexOf(m.when!).test('cw.solution')).toBe(true);
      expect(regexOf(m.when!).test('cw.project')).toBe(false);
    }
  });
});

describe('task 11 final menus', () => {
  const ctx = menus['view/item/context'] as Array<{ command?: string; submenu?: string; when?: string; group?: string }>;
  const VALUES = ['cw.solution', 'cw.solutionFolder', 'cw.project', 'cw.project.startup', 'cw.folder', 'cw.file', 'cw.packages', 'cw.package', 'cw.projectRefs', 'cw.projectRef'];
  it('every entry has group@order', () => {
    for (const m of ctx) expect(m.group, m.command ?? m.submenu).toMatch(/^[1-9]_[a-z]+@\d+(\.\d+)?$/);
  });
  it('no command twice in the same menu with overlapping when', () => {
    for (const [name, list] of Object.entries(menus)) {
      const seen = new Map<string, string[]>();
      for (const m of list.filter((x) => x.command && x.when && /viewItem =~/.test(x.when))) {
        const re = regexOf(m.when!);
        const hits = VALUES.filter((v) => re.test(v));
        const prev = seen.get(m.command!) ?? [];
        expect(hits.filter((h) => prev.includes(h)), `${name} ${m.command}`).toEqual([]);
        seen.set(m.command!, [...prev, ...hits]);
      }
    }
  });
  it('user secrets matches projects only', () => {
    const m = ctx.find((x) => x.command === 'csharpWorkbench.manageUserSecrets')!;
    const re = regexOf(m.when!);
    expect(re.test('cw.project')).toBe(true);
    expect(re.test('cw.project.startup')).toBe(true);
    expect(re.test('cw.projectRef')).toBe(false);
    expect(re.test('cw.projectRefs')).toBe(false);
    expect(m.group).toBe('4_manage@2');
  });
  it('commands are hidden from the palette except the allowed ones', () => {
    const shown = menus.commandPalette.filter((m) => m.when !== 'false').map((m) => m.command);
    expect(shown.sort()).toEqual(['csharpWorkbench.manageNuget']);
    expect(menus.commandPalette.some((m) => m.command === 'csharpWorkbench.manageUserSecrets' && m.when === 'false')).toBe(true);
  });
  it('os items cover solution but not solution folders', () => {
    for (const c of ['revealInFinder', 'openInTerminal']) {
      const re = regexOf(ctx.find((x) => x.command === `csharpWorkbench.${c}`)!.when!);
      expect(re.test('cw.solution'), c).toBe(true);
      expect(re.test('cw.solutionFolder'), c).toBe(false);
    }
  });
});

describe('linked items and virtual folders', () => {
  const ctx = menus['view/item/context'];
  const when = (c: string) => regexOf(ctx.find((m) => m.command === `csharpWorkbench.${c}`)!.when!);
  it('delete and rename never match linked files or virtual folders', () => {
    for (const c of ['delete', 'rename']) {
      for (const v of ['cw.file.linked', 'cw.file.linked.missing', 'cw.folder.virtual']) expect(when(c).test(v), `${c} ${v}`).toBe(false);
      for (const v of ['cw.file', 'cw.file.excluded', 'cw.folder']) expect(when(c).test(v), `${c} ${v}`).toBe(true);
    }
  });
});

describe('solution-only menus', () => {
  const SOLUTION_ONLY = ['renameProject', 'removeFromSolution', 'setStartupProject', 'addProjectReference', 'runStartup', 'debugStartup'];
  const entries = Object.values(menus).flat().filter((m) => SOLUTION_ONLY.includes((m.command ?? '').replace('csharpWorkbench.', '')));
  it('found every entry', () => expect(new Set(entries.map((m) => m.command)).size).toBe(SOLUTION_ONLY.length));
  it('require an open solution', () => {
    for (const m of entries.filter((x) => x.when !== 'false')) expect(m.when, m.command).toMatch(/(^|&& )csharpWorkbench\.hasSolution( &&|$)/);
  });
});

describe('project properties menu', () => {
  const item = menus['view/item/context'].find((m) => m.command === 'csharpWorkbench.projectProperties')!;
  it('Properties appears for cw.project and cw.project.startup but not cw.projectRef', () => {
    expect(regexOf(item.when!).test('cw.project')).toBe(true);
    expect(regexOf(item.when!).test('cw.project.startup')).toBe(true);
    expect(regexOf(item.when!).test('cw.projectRef')).toBe(false);
  });
  it('save command is hidden from the palette', () => {
    expect(menus.commandPalette.some((m) => m.command === 'csharpWorkbench.projectProperties.save' && m.when === 'false')).toBe(true);
  });
});
