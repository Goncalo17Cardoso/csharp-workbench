import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { addFolder, assertFolderEdit, removeEmptyFolder, renameFolder, validateFolderName } from '../../../src/solution/slnFolders';
import { parseSln, parseSlnx } from '../../../src/solution/slnParse';

const dir = path.resolve(__dirname, '../../fixtures/solution');
const vsSln = readFileSync(path.join(dir, 'vs.sln'), 'utf8');
const basicSlnx = readFileSync(path.join(dir, 'basic.slnx'), 'utf8');

const FOLDER = '{2150E333-8FDC-42A3-9474-1A3956D46DE8}';
const G1 = '{11111111-AAAA-4BBB-8CCC-DDDDDDDDDDDD}';
const G2 = '{22222222-AAAA-4BBB-8CCC-DDDDDDDDDDDD}';
/** newGuid stub returning bare lower-case GUIDs, like crypto.randomUUID(). */
const guids = (...ids: string[]) => {
  const q = ids.map((g) => g.slice(1, -1).toLowerCase());
  return () => q.shift()!;
};

/** Lines with their own terminators, so joining them reproduces the text byte for byte. */
const lines = (text: string) => text.split(/(?<=\n)/);
const splice = (text: string, at: number, del: number, ...ins: string[]) => {
  const l = lines(text);
  l.splice(at, del, ...ins);
  return l;
};
const indexOfLine = (text: string, line: string, from = 0) => lines(text).indexOf(line, from);
const lastIndexOfLine = (text: string, line: string) => lines(text).lastIndexOf(line);

const sln = (t: string) => parseSln(t, '/repo/App.sln');
const slnx = (t: string) => parseSlnx(t, '/repo/App.slnx');
const folderId = (t: string, name: string) => sln(t).folders.find((f) => f.name === name)!.id;

/** What `dotnet new sln --format sln` (SDK 10) writes: BOM, CRLF, no projects, no NestedProjects. */
const EMPTY_SLN = [
  '﻿',
  'Microsoft Visual Studio Solution File, Format Version 12.00',
  '# Visual Studio Version 17',
  'VisualStudioVersion = 17.0.31903.59',
  'MinimumVisualStudioVersion = 10.0.40219.1',
  'Global',
  '\tGlobalSection(SolutionConfigurationPlatforms) = preSolution',
  '\t\tDebug|Any CPU = Debug|Any CPU',
  '\t\tRelease|Any CPU = Release|Any CPU',
  '\tEndGlobalSection',
  '\tGlobalSection(SolutionProperties) = preSolution',
  '\t\tHideSolutionNode = FALSE',
  '\tEndGlobalSection',
  'EndGlobal',
  '',
].join('\r\n');

describe('sln addFolder', () => {
  it('add root folder to sln keeps every other byte', () => {
    const out = addFolder(vsSln, 'sln', 'docs', undefined, guids(G1));
    const at = indexOfLine(vsSln, 'Global\r\n');
    expect(lines(out)).toEqual(
      splice(vsSln, at, 0, `Project("${FOLDER}") = "docs", "docs", "${G1}"\r\n`, 'EndProject\r\n'),
    );
    expect(out.startsWith('﻿\r\n')).toBe(true);
    expect(out.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
    const f = sln(out).folders.find((x) => x.name === 'docs')!;
    expect(f).toEqual({ id: G1, name: 'docs' });
  });

  it('add nested folder appends to an existing NestedProjects section', () => {
    const src = folderId(vsSln, 'src');
    const out = addFolder(vsSln, 'sln', 'api', src, guids(G1));
    let expected = splice(vsSln, indexOfLine(vsSln, 'Global\r\n'), 0,
      `Project("${FOLDER}") = "api", "api", "${G1}"\r\n`, 'EndProject\r\n');
    const nestedEnd = expected.lastIndexOf('\tEndGlobalSection\r\n');
    expected = [...expected.slice(0, nestedEnd), `\t\t${G1} = ${src}\r\n`, ...expected.slice(nestedEnd)];
    expect(lines(out)).toEqual(expected);
    expect(sln(out).folders.find((x) => x.id === G1)!.parentId).toBe(src);
  });

  it('add nested folder creates NestedProjects when missing', () => {
    const withA = addFolder(EMPTY_SLN, 'sln', 'a', undefined, guids(G1));
    // No EndProject yet: the block goes right before Global.
    expect(lines(withA)).toEqual(splice(EMPTY_SLN, indexOfLine(EMPTY_SLN, 'Global\r\n'), 0,
      `Project("${FOLDER}") = "a", "a", "${G1}"\r\n`, 'EndProject\r\n'));
    const out = addFolder(withA, 'sln', 'b', G1, guids(G2));
    const expected = splice(withA, indexOfLine(withA, 'Global\r\n'), 0,
      `Project("${FOLDER}") = "b", "b", "${G2}"\r\n`, 'EndProject\r\n');
    expected.splice(expected.indexOf('EndGlobal\r\n'), 0,
      '\tGlobalSection(NestedProjects) = preSolution\r\n',
      `\t\t${G2} = ${G1}\r\n`,
      '\tEndGlobalSection\r\n');
    expect(lines(out)).toEqual(expected);
    const m = sln(out);
    expect(m.folders).toEqual([{ id: G1, name: 'a' }, { id: G2, name: 'b', parentId: G1 }]);
  });

  it('reuses LF line endings and space indentation', () => {
    const lf = EMPTY_SLN.replace(/\r\n/g, '\n').replace(/\t/g, '    ');
    const out = addFolder(addFolder(lf, 'sln', 'a', undefined, guids(G1)), 'sln', 'b', G1, guids(G2));
    expect(out).not.toContain('\r');
    expect(out).not.toContain('\t');
    expect(out).toContain(`    GlobalSection(NestedProjects) = preSolution\n        ${G2} = ${G1}\n    EndGlobalSection\nEndGlobal\n`);
  });

  it('uses the line ending of the anchor lines in a mixed file (LF first line, CRLF body)', () => {
    const mixed = EMPTY_SLN.replace('\r\n', '\n');
    expect(mixed.startsWith('﻿\nMicrosoft')).toBe(true);
    const a = addFolder(mixed, 'sln', 'a', undefined, guids(G1));
    expect(lines(a)).toEqual(splice(mixed, indexOfLine(mixed, 'Global\r\n'), 0,
      `Project("${FOLDER}") = "a", "a", "${G1}"\r\n`, 'EndProject\r\n'));
    const ab = addFolder(a, 'sln', 'b', G1, guids(G2));
    expect(ab.slice(1).replace(/\r\n/g, '')).toBe(ab.slice(1).replace(/\r\n/g, '').replace(/\n/, '')
      .replace(/^/, '\n')); // the only bare LF is still the first one
    expect(ab).toContain(`EndProject\r\nProject("${FOLDER}") = "b", "b", "${G2}"\r\nEndProject\r\nGlobal\r\n`);
    expect(ab).toContain(`\tGlobalSection(NestedProjects) = preSolution\r\n\t\t${G2} = ${G1}\r\n\tEndGlobalSection\r\nEndGlobal\r\n`);
    const abc = addFolder(ab, 'sln', 'c', G1, guids(G1.replace('1', '3')));
    expect(abc).toContain(`\t\t${G2} = ${G1}\r\n\t\t${G1.replace('1', '3')} = ${G1}\r\n\tEndGlobalSection\r\n`);
  });

  it('accepts an already braced upper-case GUID from newGuid', () => {
    const out = addFolder(vsSln, 'sln', 'docs', undefined, () => G1);
    expect(sln(out).folders.some((f) => f.id === G1)).toBe(true);
  });

  it('rejects invalid names, duplicates and unknown parents', () => {
    expect(() => addFolder(vsSln, 'sln', 'SRC', undefined, guids(G1))).toThrow('A solution folder with this name already exists.');
    expect(() => addFolder(vsSln, 'sln', 'a/b', undefined, guids(G1))).toThrow('Name contains invalid characters.');
    expect(() => addFolder(vsSln, 'sln', 'x', G2, guids(G1))).toThrow('Solution folder not found');
    // Same name under a different parent is fine.
    expect(() => addFolder(vsSln, 'sln', 'web', undefined, guids(G1))).not.toThrow();
  });
});

describe('sln renameFolder', () => {
  it('rename folder changes only that entry', () => {
    const web = folderId(vsSln, 'web');
    const out = renameFolder(vsSln, 'sln', web, 'frontend');
    const at = indexOfLine(vsSln, `Project("${FOLDER}") = "web", "web", "${web}"\r\n`);
    expect(at).toBeGreaterThan(0);
    expect(lines(out)).toEqual(splice(vsSln, at, 1, `Project("${FOLDER}") = "frontend", "frontend", "${web}"\r\n`));
    const m = sln(out);
    expect(m.folders.find((f) => f.id === web)).toEqual({ id: web, name: 'frontend', parentId: folderId(vsSln, 'src') });
    expect(m.projects.find((p) => p.name === 'Web')!.folderId).toBe(web);
  });

  it('rejects a sibling duplicate but allows a case-only rename of itself', () => {
    const tests = folderId(vsSln, 'tests');
    expect(() => renameFolder(vsSln, 'sln', tests, 'SRC')).toThrow('A solution folder with this name already exists.');
    expect(sln(renameFolder(vsSln, 'sln', tests, 'Tests')).folders.find((f) => f.id === tests)!.name).toBe('Tests');
    expect(() => renameFolder(vsSln, 'sln', G1, 'x')).toThrow('Solution folder not found');
    expect(() => renameFolder(vsSln, 'sln', tests, '')).toThrow('Name cannot be empty.');
  });
});

describe('sln removeEmptyFolder', () => {
  it('remove empty folder removes block and nesting lines', () => {
    const src = folderId(vsSln, 'src');
    const added = addFolder(vsSln, 'sln', 'tmp', src, guids(G1));
    expect(removeEmptyFolder(added, 'sln', G1)).toBe(vsSln);
    // A root folder with no nesting line at all.
    const root = addFolder(EMPTY_SLN, 'sln', 'a', undefined, guids(G1));
    expect(removeEmptyFolder(root, 'sln', G1)).toBe(EMPTY_SLN);
    // Lower-case GUIDs in the file still match.
    const lower = added.split(G1).join(G1.toLowerCase());
    expect(removeEmptyFolder(lower, 'sln', G1)).toBe(vsSln);
  });

  it('removes the last nesting line but keeps the then-empty section', () => {
    const a = addFolder(EMPTY_SLN, 'sln', 'a', undefined, guids(G1));
    const ab = addFolder(a, 'sln', 'b', G1, guids(G2));
    const out = removeEmptyFolder(ab, 'sln', G2);
    expect(out).toContain('\tGlobalSection(NestedProjects) = preSolution\r\n\tEndGlobalSection\r\nEndGlobal\r\n');
    expect(sln(out).folders).toEqual([{ id: G1, name: 'a' }]);
  });

  it('remove non-empty folder throws', () => {
    expect(() => removeEmptyFolder(vsSln, 'sln', folderId(vsSln, 'src'))).toThrow('Solution folder is not empty'); // child folder
    expect(() => removeEmptyFolder(vsSln, 'sln', folderId(vsSln, 'web'))).toThrow('Solution folder is not empty'); // project
    const items = vsSln.replace('\r\nGlobal\r\n', '\r\n' + [
      `Project("${FOLDER}") = "items", "items", "${G1}"`,
      '\tProjectSection(SolutionItems) = preProject',
      '\t\tREADME.md = README.md',
      '\tEndProjectSection',
      'EndProject',
      'Global',
      '',
    ].join('\r\n'));
    expect(() => removeEmptyFolder(items, 'sln', G1)).toThrow('Solution folder is not empty'); // solution items
    expect(() => removeEmptyFolder(vsSln, 'sln', G1.replace('1', '9'))).toThrow('Solution folder not found');
  });
});

describe('slnx addFolder', () => {
  it('inserts after the last Folder with the file indentation and keeps every other byte', () => {
    const out = addFolder(basicSlnx, 'slnx', 'docs', undefined, guids(G1));
    const at = lastIndexOfLine(basicSlnx, '  </Folder>\n') + 1;
    expect(lines(out)).toEqual(splice(basicSlnx, at, 0, '  <Folder Name="/docs/" />\n'));
    expect(slnx(out).folders.find((f) => f.id === '/docs/')).toEqual({ id: '/docs/', name: 'docs' });
  });

  it('nested folder under an existing parent', () => {
    const out = addFolder(basicSlnx, 'slnx', 'api', '/src/web/', guids(G1));
    const at = lastIndexOfLine(basicSlnx, '  </Folder>\n') + 1;
    expect(lines(out)).toEqual(splice(basicSlnx, at, 0, '  <Folder Name="/src/web/api/" />\n'));
    expect(slnx(out).folders.find((f) => f.id === '/src/web/api/')!.parentId).toBe('/src/web/');
  });

  it('first child of an empty Solution', () => {
    const empty = '<Solution>\n</Solution>\n'; // dotnet new sln --format slnx
    const out = addFolder(empty, 'slnx', 'x', undefined, guids(G1));
    expect(out).toBe('<Solution>\n  <Folder Name="/x/" />\n</Solution>\n');
  });

  it('throws for an unknown parent, but fills in missing ancestors of an existing parent like dotnet sln does', () => {
    expect(() => addFolder('<Solution>\n</Solution>\n', 'slnx', 'y', '/x/', guids(G1))).toThrow('Solution folder not found');
    expect(() => addFolder(basicSlnx, 'slnx', 'y', '/nope/', guids(G1))).toThrow('Solution folder not found');
    const t = '<Solution>\n  <Folder Name="/x/y/" />\n</Solution>\n';
    const out = addFolder(t, 'slnx', 'z', '/x/y/', guids(G1));
    expect(out).toBe('<Solution>\n  <Folder Name="/x/y/" />\n  <Folder Name="/x/" />\n  <Folder Name="/x/y/z/" />\n</Solution>\n');
    expect(slnx(out).folders.map((f) => f.id)).toEqual(['/x/y/', '/x/', '/x/y/z/']);
  });

  it('uses the line ending of the anchor line in a mixed file', () => {
    const t = '<Solution>\n  <Folder Name="/a/" />\r\n</Solution>\r\n';
    expect(addFolder(t, 'slnx', 'b', undefined, guids(G1)))
      .toBe('<Solution>\n  <Folder Name="/a/" />\r\n  <Folder Name="/b/" />\r\n</Solution>\r\n');
    expect(addFolder('<Solution>\r\n</Solution>\n', 'slnx', 'b', undefined, guids(G1)))
      .toBe('<Solution>\r\n  <Folder Name="/b/" />\r\n</Solution>\n');
  });

  it('expands a self-closing Solution and keeps CRLF', () => {
    expect(addFolder('<Solution />\r\n', 'slnx', 'a', undefined, guids(G1)))
      .toBe('<Solution>\r\n  <Folder Name="/a/" />\r\n</Solution>\r\n');
  });

  it('first child of Solution when there are other children but no Folder', () => {
    const t = '﻿<Solution>\r\n\t<Configurations>\r\n\t\t<Platform Name="x64" />\r\n\t</Configurations>\r\n\t<Project Path="a/A.csproj" />\r\n</Solution>';
    const out = addFolder(t, 'slnx', 'lib', undefined, guids(G1));
    expect(out).toBe('﻿<Solution>\r\n\t<Folder Name="/lib/" />\r\n\t<Configurations>\r\n\t\t<Platform Name="x64" />\r\n\t</Configurations>\r\n\t<Project Path="a/A.csproj" />\r\n</Solution>');
  });

  it('escapes XML in names and ignores commented-out folders', () => {
    const t = '<Solution>\n  <!-- <Folder Name="/old/" /> -->\n  <Folder Name="/src/" />\n</Solution>\n';
    const out = addFolder(t, 'slnx', 'R&D', undefined, guids(G1));
    expect(out).toBe('<Solution>\n  <!-- <Folder Name="/old/" /> -->\n  <Folder Name="/src/" />\n  <Folder Name="/R&amp;D/" />\n</Solution>\n');
    expect(slnx(out).folders.map((f) => f.id)).toEqual(['/src/', '/R&D/']);
    // The commented-out folder is not a sibling.
    expect(() => addFolder(t, 'slnx', 'old', undefined, guids(G1))).not.toThrow();
    expect(() => addFolder(t, 'slnx', 'SRC', undefined, guids(G1))).toThrow('A solution folder with this name already exists.');
  });

  it('counts implicit ancestors as existing siblings', () => {
    const t = '<Solution>\n  <Folder Name="/x/y/" />\n</Solution>\n';
    expect(() => addFolder(t, 'slnx', 'X', undefined, guids(G1))).toThrow('A solution folder with this name already exists.');
  });
});

describe('slnx renameFolder', () => {
  it('rename slnx folder updates descendants', () => {
    const out = renameFolder(basicSlnx, 'slnx', '/src/', 'source');
    expect(lines(out)).toEqual(
      lines(basicSlnx).map((l) =>
        l === '  <Folder Name="/src/">\n' ? '  <Folder Name="/source/">\n'
          : l === '  <Folder Name="/src/web/">\n' ? '  <Folder Name="/source/web/">\n' : l),
    );
    const m = slnx(out);
    expect(m.folders.map((f) => f.id)).toEqual(['/source/', '/source/web/', '/tests/']);
    expect(m.projects.find((p) => p.name === 'Web')!.folderId).toBe('/source/web/');
  });

  it('renames a nested folder, keeps other attributes and comments, rejects duplicates', () => {
    const t = "<Solution>\n  <!-- <Folder Name='/a/b/' /> -->\n  <Folder Id=\"1\" Name='/a/b/' />\n  <Folder Name=\"/a/c/\" />\n  <Folder Name=\"/a/bb/\" />\n</Solution>\n";
    const out = renameFolder(t, 'slnx', '/a/b/', 'B & C');
    expect(out).toBe("<Solution>\n  <!-- <Folder Name='/a/b/' /> -->\n  <Folder Id=\"1\" Name='/a/B &amp; C/' />\n  <Folder Name=\"/a/c/\" />\n  <Folder Name=\"/a/bb/\" />\n</Solution>\n");
    expect(() => renameFolder(t, 'slnx', '/a/b/', 'C')).toThrow('A solution folder with this name already exists.');
    expect(() => renameFolder(t, 'slnx', '/nope/', 'z')).toThrow('Solution folder not found');
  });
});

describe('slnx removeEmptyFolder', () => {
  it('removes the element line and nothing else', () => {
    const added = addFolder(basicSlnx, 'slnx', 'docs', undefined, guids(G1));
    expect(removeEmptyFolder(added, 'slnx', '/docs/')).toBe(basicSlnx);
    const t = '<Solution>\r\n  <Folder Name="/a/">\r\n  </Folder>\r\n  <Folder Name="/b/" />\r\n</Solution>';
    expect(removeEmptyFolder(t, 'slnx', '/a/')).toBe('<Solution>\r\n  <Folder Name="/b/" />\r\n</Solution>');
    expect(removeEmptyFolder('<Solution><Folder Name="/a/" /><Folder Name="/b/" /></Solution>', 'slnx', '/a/'))
      .toBe('<Solution><Folder Name="/b/" /></Solution>');
  });

  it('remove non-empty slnx folder throws', () => {
    expect(() => removeEmptyFolder(basicSlnx, 'slnx', '/src/')).toThrow('Solution folder is not empty'); // child + project
    expect(() => removeEmptyFolder(basicSlnx, 'slnx', '/tests/')).toThrow('Solution folder is not empty'); // project
    const files = '<Solution>\n  <Folder Name="/items/">\n    <File Path="README.md" />\n  </Folder>\n</Solution>\n';
    expect(() => removeEmptyFolder(files, 'slnx', '/items/')).toThrow('Solution folder is not empty');
    const implicitChild = '<Solution>\n  <Folder Name="/a/" />\n  <Folder Name="/a/b/c/" />\n</Solution>\n';
    expect(() => removeEmptyFolder(implicitChild, 'slnx', '/a/')).toThrow('Solution folder is not empty');
    expect(() => removeEmptyFolder(basicSlnx, 'slnx', '/nope/')).toThrow('Solution folder not found');
  });
});

describe('validateFolderName', () => {
  it('rejects empty names', () => {
    expect(validateFolderName('')).toBe('Name cannot be empty.');
    expect(validateFolderName('   ')).toBe('Name cannot be empty.');
  });
  it('rejects invalid characters', () => {
    for (const c of ['/', '\\', ':', '*', '?', '"', '<', '>', '|', '\t', '\n']) {
      expect(validateFolderName(`a${c}b`)).toBe('Name contains invalid characters.');
    }
  });
  it('validateFolderName rejects duplicates case-insensitively', () => {
    expect(validateFolderName('Src', ['tests', 'src'])).toBe('A solution folder with this name already exists.');
    expect(validateFolderName('src2', ['tests', 'src'])).toBeUndefined();
    expect(validateFolderName('My Folder #1')).toBeUndefined();
  });
});

describe('assertFolderEdit postconditions (dotnet sln list accepts all of these)', () => {
  const SRC = '{827E0CD3-B72D-47B6-A68D-7590B98EB39B}';
  const WEB = '{03997797-E7F5-0643-168D-B8EA7178C2FE}';
  const TESTS = '{0AB3BF05-4346-4AA6-1389-037BE0695223}';
  const WEB_PROJ = '{CAA98628-E3AD-4987-A882-DF34EAAA5130}';
  const DEAD = '{DEADDEAD-0000-4000-8000-000000000000}';
  const add = { op: 'add', id: G1, name: 'docs', parentId: SRC } as const;
  const good = addFolder(vsSln, 'sln', 'docs', SRC, guids(G1));
  const nestLine = `\t\t${G1} = ${SRC}\r\n`;
  const check = (after: string, change: Parameters<typeof assertFolderEdit>[3] = add) =>
    () => assertFolderEdit('sln', vsSln, after, change);
  const FAILED = 'Solution folder edit failed its consistency check';

  it('accepts the real edit outputs', () => {
    expect(check(good)).not.toThrow();
    expect(() => assertFolderEdit('sln', good, renameFolder(good, 'sln', G1, 'd2'), { op: 'rename', id: G1, newName: 'd2' })).not.toThrow();
    expect(() => assertFolderEdit('sln', good, removeEmptyFolder(good, 'sln', G1), { op: 'remove', id: G1 })).not.toThrow();
  });

  it.each([
    ['a dangling parent GUID', good.replace(nestLine, nestLine + `\t\t${G2} = ${DEAD}\r\n`)],
    ['a dangling child GUID', good.replace(nestLine, nestLine + `\t\t${DEAD} = ${G1}\r\n`)],
    ['a folder nested under a project', good.replace(nestLine, `\t\t${G1} = ${WEB_PROJ}\r\n`)],
    ['trailing garbage', good + 'garbage\r\n'],
    ['duplicate nesting lines', good.replace(nestLine, nestLine + nestLine)],
    ['an unterminated extra NestedProjects section', good.replace(/EndGlobal\r\n$/, '\tGlobalSection(NestedProjects) = preSolution\r\nEndGlobal\r\n')],
    ['a folder with no EndProject', good.replace(`"${G1}"\r\nEndProject\r\n`, `"${G1}"\r\n`)],
    ['a duplicate GUID', good.replace('Global\r\n', `Project("${FOLDER}") = "docs", "docs", "${G1}"\r\nEndProject\r\nGlobal\r\n`)],
    ['a duplicate sibling name', good.replace('Global\r\n', `Project("${FOLDER}") = "Docs", "Docs", "${G2}"\r\nEndProject\r\nGlobal\r\n`)
      .replace(nestLine, nestLine + `\t\t${G2} = ${SRC}\r\n`)],
    ['a file truncated before EndGlobal', good.replace(/EndGlobal\r\n$/, '')],
    ['a missing Global', good.replace('Global\r\n', '')],
    ['a self-cycle', good.replace(nestLine, `\t\t${G1} = ${G1}\r\n`)],
    ['another folder moved', good.replace(`${WEB} = ${SRC}`, `${WEB} = ${TESTS}`)],
    ['a project moved', good.replace(`${WEB_PROJ} = ${WEB}`, `${WEB_PROJ} = ${SRC}`)],
    ['the new folder at the root instead of under its parent', good.replace(nestLine, '')],
    ['the new folder with another name', good.replace('"docs", "docs"', '"doc", "doc"')],
    ['another folder renamed', good.replace('"tests", "tests"', '"test", "test"')],
    ['another folder removed', good.replace(`Project("${FOLDER}") = "tests", "tests", "${TESTS}"\r\nEndProject\r\n`, '')],
  ])('rejects an add result with %s', (_label, after) => {
    expect(after).not.toBe(good);
    expect(check(after)).toThrow(FAILED);
  });

  it('rejects rename and remove results that touch more than the folder', () => {
    const renamed = renameFolder(good, 'sln', G1, 'd2');
    expect(() => assertFolderEdit('sln', good, renamed.replace('"src", "src"', '"s", "s"'), { op: 'rename', id: G1, newName: 'd2' })).toThrow(FAILED);
    const removed = removeEmptyFolder(good, 'sln', G1);
    expect(() => assertFolderEdit('sln', good, removed.replace(`\t\t${WEB} = ${SRC}\r\n`, ''), { op: 'remove', id: G1 })).toThrow(FAILED);
    expect(() => assertFolderEdit('sln', good, removed + 'x', { op: 'remove', id: G1 })).toThrow(FAILED);
  });

  it('tolerates problems the original file already had, but not new ones', () => {
    const messy = vsSln + 'trailing\r\n';
    const out = addFolder(messy, 'sln', 'docs', undefined, guids(G1));
    expect(sln(out).folders.some((f) => f.id === G1)).toBe(true);
    expect(() => assertFolderEdit('sln', messy, out.replace(/EndGlobal\r\n/, ''), { op: 'add', id: G1, name: 'docs' })).toThrow(FAILED);
  });

  it('checks slnx results too', () => {
    const before = basicSlnx;
    const ok = addFolder(before, 'slnx', 'api', '/src/web/', guids(G1));
    const change = { op: 'add', id: '/src/web/api/', name: 'api', parentId: '/src/web/' } as const;
    expect(() => assertFolderEdit('slnx', before, ok, change)).not.toThrow();
    for (const bad of [
      ok.replace('<Folder Name="/src/web/api/" />', '<Folder Name="/src/web/api/">'), // malformed XML
      ok.replace('<Folder Name="/src/web/api/" />', '<Folder Name="/src/web/api/" /><Folder Name="/src/web/api/" />'), // duplicate
      ok.replace('<Folder Name="/src/web/api/" />', '<Folder Name="/src/web/API/" /><Folder Name="/src/web/api/" />'), // sibling clash
      ok.replace('  <Folder Name="/tests/">\n    <Project Path="tests/My App #1/Tests.csproj" />\n', '  <Folder Name="/tests/">\n'), // project lost
      ok + '<x/>', // trailing content
    ]) {
      expect(bad).not.toBe(ok);
      expect(() => assertFolderEdit('slnx', before, bad, change), bad).toThrow(FAILED);
    }
    const selfClosing = '<?xml version="1.0"?>\n<!-- c --><Solution />\n';
    const added = addFolder(selfClosing, 'slnx', 'a', undefined, guids(G1));
    expect(() => assertFolderEdit('slnx', selfClosing, added, { op: 'add', id: '/a/', name: 'a' })).not.toThrow();
    expect(() => assertFolderEdit('slnx', selfClosing, added + '<x/>', { op: 'add', id: '/a/', name: 'a' })).toThrow(FAILED);
  });
});
