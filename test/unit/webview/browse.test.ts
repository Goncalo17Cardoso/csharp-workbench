// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { formatDownloads, renderSearchList } from '../../../src/webview/views/browse';

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
