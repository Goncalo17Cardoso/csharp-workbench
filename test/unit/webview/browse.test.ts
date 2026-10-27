// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { formatDownloads, renderSearchList, SearchPager } from '../../../src/webview/views/browse';

const results = [
  { id: 'Serilog', description: 'Logging', latestVersion: '4.2.0', totalDownloads: 1_900_000_000, sources: ['nuget.org'] },
  { id: 'Serilog.Sinks.Console', description: 'Console', latestVersion: '6.0.0', totalDownloads: 980_000_000, iconUrl: 'https://x/i.png', sources: ['nuget.org'] },
];

describe('browse', () => {
  it('renders one row per result with formatted downloads', () => {
    const el = document.createElement('div');
    renderSearchList(el, results, [], () => {});
    const rows = el.querySelectorAll('.row');
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain('1.9B');
    expect(rows[1].textContent).toContain('980M');
    expect(rows[0].querySelector('.ico-fallback')).not.toBeNull();
    expect(rows[1].querySelector('img')).not.toBeNull();
  });
  it('shows a warning per failed source', () => {
    const el = document.createElement('div');
    renderSearchList(el, [], [{ source: 'A', message: 'm1' }, { source: 'B', message: 'm2' }], () => {});
    expect(el.querySelectorAll('.warning')).toHaveLength(2);
    expect(el.textContent).toContain('A');
  });
  it('clicking a row calls onSelect with id', () => {
    const el = document.createElement('div');
    const onSelect = vi.fn();
    renderSearchList(el, results, [], onSelect);
    (el.querySelectorAll('.row')[1] as HTMLElement).click();
    expect(onSelect).toHaveBeenCalledWith('Serilog.Sinks.Console');
  });
  it('formatDownloads', () => {
    expect(formatDownloads(1_900_000_000)).toBe('1.9B');
    expect(formatDownloads(980_000_000)).toBe('980M');
    expect(formatDownloads(12_300)).toBe('12K');
    expect(formatDownloads(9_500)).toBe('9.5K');
    expect(formatDownloads(950)).toBe('950');
    expect(formatDownloads(undefined)).toBe('');
  });
});

describe('SearchPager', () => {
  it('pages by 20 and stops when a page comes back empty', () => {
    const p = new SearchPager(20);
    const a = p.begin(false);
    expect(a).toEqual({ seq: 1, skip: 0, append: false });
    expect(p.canPage()).toBe(false);
    expect(p.accept(a.seq, 20)).toBe(true);
    expect(p.canPage()).toBe(true);
    const b = p.begin(true);
    expect(b).toEqual({ seq: 2, skip: 20, append: true });
    expect(p.accept(b.seq, 0)).toBe(true);
    expect(p.canPage()).toBe(false);
    expect(p.begin(false)).toMatchObject({ skip: 0 });
  });
  it('drops responses to older requests', () => {
    const p = new SearchPager(20);
    const old = p.begin(false);
    const latest = p.begin(false);
    expect(p.accept(old.seq, 20)).toBe(false);
    expect(p.canPage()).toBe(false);
    expect(p.accept(latest.seq, 20)).toBe(true);
    // A late page from the previous query can't append to the new results.
    const page = p.begin(true);
    p.begin(false);
    expect(p.accept(page.seq, 20)).toBe(false);
  });
  it('a failed page request rolls skip back so the page is retried', () => {
    const p = new SearchPager(20);
    p.accept(p.begin(false).seq, 20);
    p.begin(true);
    p.fail();
    expect(p.canPage()).toBe(true);
    expect(p.begin(true).skip).toBe(20);
    p.fail();
    p.fail();
    expect(p.begin(true).skip).toBe(20);
  });
});
