// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToHost, ToWebview } from '../../../src/panel/protocol';

// Same happy-dom/DOMPurify workaround as details.test.ts.
Object.defineProperty(Node.prototype, 'nodeName', {
  configurable: true,
  get(this: object) {
    for (let p = Object.getPrototypeOf(this); p && p !== Node.prototype; p = Object.getPrototypeOf(p)) {
      const d = Object.getOwnPropertyDescriptor(p, 'nodeName');
      if (d?.get) return d.get.call(this);
    }
    return '';
  },
});

// happy-dom has no `Option` constructor; main.ts uses it for the target/source dropdowns.
(globalThis as Record<string, unknown>).Option ??= function (text = '', value = '', _d = false, selected = false) {
  const o = document.createElement('option');
  o.textContent = text;
  o.value = value;
  o.selected = selected;
  return o;
};

let sent: ToHost[] = [];

async function boot(): Promise<void> {
  sent = [];
  document.body.innerHTML = '<div id="app"></div>';
  (globalThis as Record<string, unknown>).acquireVsCodeApi = () => ({
    postMessage: (m: ToHost) => sent.push(m),
    setState: () => {},
    getState: () => ({}),
  });
  vi.resetModules();
  await import('../../../src/webview/main');
}

const lastSearch = () => sent.filter((m): m is Extract<ToHost, { type: 'search' }> => m.type === 'search').at(-1)!;
const searches = () => sent.filter((m) => m.type === 'search').length;
const tab = (name: string) => document.querySelector<HTMLElement>(`button.tab[data-tab="${name}"]`)!.click();
const result = (id: string) => ({ id, description: '', latestVersion: '1.0.0', sources: [] });
const listIds = () => [...document.querySelectorAll<HTMLElement>('.list .row')].map((r) => r.dataset.id);
const post = (m: ToWebview) => window.dispatchEvent(new MessageEvent('message', { data: m }));
const projects = [{ path: '/a/Api.csproj', name: 'Api' }];
const init: ToWebview = { type: 'init', targets: [], current: { kind: 'sln', path: '/a/a.sln', name: 'a' }, projects, sources: [] };
const details = (version: string): ToWebview => ({
  type: 'details', details: { id: 'Serilog', version, description: '', dependencies: [] },
  versions: ['4.2.0', '4.1.0'], perProject: { '/a/Api.csproj': null }, overrides: [],
});

describe('webview main', () => {
  beforeEach(boot);

  it('re-selects the shown package after a confirmed reload, keeping the chosen version', () => {
    post(init);
    post({ type: 'searchResults', seq: lastSearch().seq, results: [{ id: 'Serilog', description: '', latestVersion: '4.2.0', sources: [] }], failures: [], append: false });
    document.querySelector<HTMLElement>('.list .row')!.click();
    post(details('4.2.0'));
    const sel = document.querySelector<HTMLSelectElement>('.detail .actions select')!;
    sel.value = '4.1.0';
    sel.dispatchEvent(new Event('change'));
    sent = [];
    post({ type: 'installed', rows: [], confirmed: false });
    expect(sent).toEqual([]);
    post({ type: 'installed', rows: [], confirmed: true });
    expect(sent).toEqual([{ type: 'selectPackage', id: 'Serilog', prerelease: false, source: 'All', version: '4.1.0' }]);
  });

  it('scrolling a non-Browse tab never pages search results into it', () => {
    post(init);
    post({ type: 'searchResults', seq: lastSearch().seq, results: [result('Serilog')], failures: [], append: false });
    tab('installed');
    post({ type: 'installed', rows: [{ id: 'Mine', versions: { '/a/Api.csproj': '1.0.0' }, overrides: [] }], confirmed: true });
    const n = searches();
    document.querySelector('.list')!.dispatchEvent(new Event('scroll'));
    expect(searches()).toBe(n);
    expect(listIds()).toEqual(['Mine']);
  });

  it('typing, prerelease and source changes on other tabs filter locally only', () => {
    post(init);
    tab('installed');
    post({ type: 'installed', rows: [{ id: 'Alpha', versions: { a: '1' }, overrides: [] }, { id: 'Beta', versions: { a: '1' }, overrides: [] }], confirmed: true });
    const n = searches();
    const search = document.querySelector<HTMLInputElement>('input.search')!;
    search.value = 'alp';
    search.dispatchEvent(new Event('input'));
    document.querySelector<HTMLInputElement>('input[type=checkbox]')!.click();
    document.querySelector('select.source')!.dispatchEvent(new Event('change'));
    expect(searches()).toBe(n);
    expect(listIds()).toEqual(['Alpha']);
  });

  it('search results are ignored outside Browse and when stale', () => {
    post(init);
    const first = lastSearch();
    tab('installed');
    post({ type: 'installed', rows: [{ id: 'Mine', versions: { a: '1' }, overrides: [] }], confirmed: true });
    post({ type: 'searchResults', seq: first.seq, results: [result('Late')], failures: [], append: false });
    expect(listIds()).toEqual(['Mine']);
    tab('browse');
    const fresh = lastSearch();
    expect(fresh.seq).not.toBe(first.seq);
    post({ type: 'searchResults', seq: first.seq, results: [result('Old')], failures: [], append: false });
    expect(listIds()).not.toContain('Old');
    post({ type: 'searchResults', seq: fresh.seq, results: [result('New')], failures: [], append: false });
    expect(listIds()).toEqual(['New']);
  });
});
