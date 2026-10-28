import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { TemplateCatalog, newItemArgs, parseNewList, parseTemplateOptions } from '../../../src/solution/templateCatalog';

const fx = (n: string) => readFileSync(`test/fixtures/cli/${n}`, 'utf8');

describe('parseNewList', () => {
  it('parses SDK 10 item table with comma short names', () => {
    const l = parseNewList(fx('new-list-item.txt'));
    const s = l.find((t) => t.name === 'Struct')!;
    expect(s.shortNames).toEqual(['struct', 'structure']);
    expect(s.languages).toEqual(['C#', 'VB']);
    expect(s.tags).toBe('Common');
    const w = l.find((t) => t.name === 'Web Config')!;
    expect(w.shortNames).toEqual(['webconfig']);
    expect(w.languages).toEqual([]);
    expect(l.some((t) => t.name.includes('These templates'))).toBe(false);
  });
  it('parses SDK 8 item table', () => {
    const l = parseNewList(fx('new-list-item-sdk8.txt'));
    const g = l.find((t) => t.name === 'dotnet gitignore file')!;
    expect(g.shortNames).toEqual(['gitignore', '.gitignore']);
    expect(g.tags).toBe('Config');
    const a = l.find((t) => t.name === 'API Controller')!;
    expect(a.languages).toEqual(['C#']);
    expect(a.tags).toBe('Web/ASP.NET');
  });
  it('parses project table', () => {
    const w = parseNewList(fx('new-list-project.txt')).find((t) => t.shortNames[0] === 'webapi')!;
    expect(w.name).toBe('ASP.NET Core Web API');
    expect(w.languages).toEqual(['C#', 'F#']);
  });
});

describe('parseTemplateOptions', () => {
  it('class help has project but no namespace', () => {
    expect(parseTemplateOptions(fx('new-help-class.txt'))).toEqual({ namespace: false, project: true });
  });
  it('razorcomponent help has project but no namespace', () => {
    expect(parseTemplateOptions(fx('new-help-razorcomponent.txt'))).toEqual({ namespace: false, project: true });
  });
  it('detects namespace option', () => {
    expect(parseTemplateOptions('  -na, --namespace <ns>  x\n  --project <p>')).toEqual({ namespace: true, project: true });
  });
});

describe('newItemArgs', () => {
  it('builds args', () => {
    expect(newItemArgs('A', '/o', 'N', '/p.csproj', { namespace: true, project: true }))
      .toEqual(['-n', 'A', '-o', '/o', '--namespace', 'N', '--project', '/p.csproj']);
    expect(newItemArgs('A', '/o', 'N', '/p', { namespace: false, project: false })).toEqual(['-n', 'A', '-o', '/o']);
  });
});

describe('TemplateCatalog', () => {
  const mk = () => ({ newList: vi.fn(async () => fx('new-list-item.txt')), newHelp: vi.fn(async () => fx('new-help-class.txt')) });
  it('caches list until refresh', async () => {
    const cli = mk();
    const c = new TemplateCatalog(cli as never);
    await c.list(); await c.list();
    expect(cli.newList).toHaveBeenCalledTimes(1);
    c.refresh();
    await c.list();
    expect(cli.newList).toHaveBeenCalledTimes(2);
  });
  it('caches per type', async () => {
    const cli = mk();
    const c = new TemplateCatalog(cli as never);
    await c.list(); await c.list('project');
    expect(cli.newList).toHaveBeenCalledTimes(2);
  });
  it('caches options per short name', async () => {
    const cli = mk();
    const c = new TemplateCatalog(cli as never);
    await c.options('class'); await c.options('class');
    expect(cli.newHelp).toHaveBeenCalledTimes(1);
    c.refresh();
    await c.options('class');
    expect(cli.newHelp).toHaveBeenCalledTimes(2);
  });
  it('does not cache failures', async () => {
    const cli = mk();
    cli.newList.mockRejectedValueOnce(new Error('boom'));
    const c = new TemplateCatalog(cli as never);
    await expect(c.list()).rejects.toThrow('boom');
    expect((await c.list()).length).toBeGreaterThan(0);
  });
});
