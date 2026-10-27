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
    post({ type: 'searchResults', results: [{ id: 'Serilog', description: '', latestVersion: '4.2.0', sources: [] }], failures: [], append: false });
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
});
