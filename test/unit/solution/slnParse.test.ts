import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { loadSolution, parseSln, parseSlnx } from '../../../src/solution/slnParse';

const dir = path.resolve(__dirname, '../../fixtures/solution');
const slnPath = path.join(dir, 'vs.sln');
const slnxPath = path.join(dir, 'basic.slnx');
const sln = () => parseSln(readFileSync(slnPath, 'utf8'), slnPath);
const slnx = () => parseSlnx(readFileSync(slnxPath, 'utf8'), slnxPath);

describe('parseSln', () => {
  it('parses nested solution folders from NestedProjects', () => {
    const m = sln();
    const src = m.folders.find((f) => f.name === 'src')!;
    const web = m.folders.find((f) => f.name === 'web')!;
    expect(web.parentId).toBe(src.id);
    expect(src.parentId).toBeUndefined();
    expect(src.id).toBe(src.id.toUpperCase());
    expect(m.folders.map((f) => f.name).sort()).toEqual(['src', 'tests', 'web']);
  });
  it('assigns projects to folders', () => {
    const m = sln();
    const web = m.folders.find((f) => f.name === 'web')!;
    expect(m.projects).toHaveLength(3);
    expect(m.projects.find((p) => p.name === 'Web')!.folderId).toBe(web.id);
    expect(m.projects.find((p) => p.name === 'Core')!.folderId).toBe(m.folders.find((f) => f.name === 'src')!.id);
  });
  it('resolves project paths with spaces and #', () => {
    const t = sln().projects.find((p) => p.name === 'Tests')!;
    expect(t.path).toBe(path.join(dir, 'tests', 'My App #1', 'Tests.csproj'));
    expect(t.typeGuid).toBe('{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}');
  });
  it('ignores BOM and CRLF', () => {
    const raw = readFileSync(slnPath, 'utf8');
    expect(raw.charCodeAt(0)).toBe(0xfeff);
    expect(raw).toContain('\r\n');
    expect(sln().folders).toHaveLength(3);
  });
  it('throws on text without a solution header', () => {
    expect(() => parseSln('hello', '/x/a.sln')).toThrow('Not a solution file: /x/a.sln');
  });
});

describe('parseSlnx', () => {
  it('parses slnx folders and projects', () => {
    const m = slnx();
    expect(m.kind).toBe('slnx');
    const web = m.folders.find((f) => f.id === '/src/web/')!;
    expect(web.name).toBe('web');
    expect(web.parentId).toBe('/src/');
    expect(m.folders.find((f) => f.id === '/src/')!.parentId).toBeUndefined();
    const t = m.projects.find((p) => p.name === 'Tests')!;
    expect(t.folderId).toBe('/tests/');
    expect(t.path).toBe(path.join(dir, 'tests', 'My App #1', 'Tests.csproj'));
  });
  it('handles root projects and a single folder', () => {
    const m = parseSlnx('<Solution><Project Path="a/A.csproj"/><Folder Name="/f/"><Project Path="f/B.csproj"/></Folder></Solution>', '/r/s.slnx');
    expect(m.projects.map((p) => [p.name, p.folderId])).toEqual([['B', '/f/'], ['A', undefined]]);
  });
  it('throws without a root Solution', () => {
    expect(() => parseSlnx('<Other/>', '/x/a.slnx')).toThrow('Not a solution file: /x/a.slnx');
  });
});

it('sln and slnx fixtures yield the same folder names and project paths', () => {
  const a = sln();
  const b = slnx();
  expect(a.folders.map((f) => f.name).sort()).toEqual(b.folders.map((f) => f.name).sort());
  expect(a.projects.map((p) => p.path).sort()).toEqual(b.projects.map((p) => p.path).sort());
});

describe('loadSolution', () => {
  it('dispatches on extension', async () => {
    const read = async (p: string) => readFileSync(p, 'utf8');
    expect((await loadSolution(slnPath, read)).kind).toBe('sln');
    expect((await loadSolution(slnxPath, read)).kind).toBe('slnx');
  });
});
