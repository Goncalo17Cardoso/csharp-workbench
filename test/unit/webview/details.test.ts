// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
// DOMPurify calls the accessor taken from Node.prototype, where happy-dom's `nodeName` getter
// returns '' (subclasses override it). Make the base accessor dispatch to the subclass getter.
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
const { actionFor, renderDetails } = await import('../../../src/webview/views/details');

const projects = [{ path: '/a/Api.csproj', name: 'Api' }, { path: '/a/Core.csproj', name: 'Core' }];
const details = { id: 'Serilog', version: '4.2.0', description: 'd', dependencies: [{ framework: 'net8.0', packages: [{ id: 'X', range: '1.0.0' }] }] };

describe('actionFor', () => {
  const per = { a: '1.0.0', b: '2.0.0', c: null };
  it('returns Install / Update / Uninstall per rule', () => {
    expect(actionFor(['a'], per, '1.0.0')).toBe('Uninstall');
    expect(actionFor(['a', 'b'], per, '1.0.0')).toBe('Update');
    expect(actionFor(['a', 'c'], per, '1.0.0')).toBe('Install');
    expect(actionFor(['c'], per, '1.0.0')).toBe('Install');
    expect(actionFor([], per, '1.0.0')).toBe('Install');
  });
});

describe('details', () => {
  const render = (extra = {}, pre?: string) => {
    const el = document.createElement('div');
    const send = vi.fn();
    renderDetails(el, { ...details, ...extra }, ['4.2.0', '4.1.0'], { '/a/Api.csproj': null, '/a/Core.csproj': '3.1.1' }, projects, send, { preselect: pre });
    return { el, send };
  };
  it('checkboxes show installed version or not installed', () => {
    const { el } = render();
    const t = el.querySelector('.projects')!.textContent!;
    expect(t).toContain('not installed');
    expect(t).toContain('3.1.1');
  });
  it('preselected project is checked', () => {
    const { el } = render({}, '/a/Api.csproj');
    const boxes = el.querySelectorAll<HTMLInputElement>('.projects input[type=checkbox]');
    expect(boxes[0].checked).toBe(true);
    expect(boxes[1].checked).toBe(false);
  });
  it('readme script tags are stripped', () => {
    const { el } = render({ readme: '# Hi\n\n<script>alert(1)</script>' });
    expect(el.querySelector('.readme h1')).not.toBeNull();
    expect(el.querySelector('script')).toBeNull();
  });
  it('omits readme section when empty and sends run on click', () => {
    const { el, send } = render({}, '/a/Api.csproj');
    expect(el.querySelector('.readme')).toBeNull();
    (el.querySelector('button.primary') as HTMLElement).click();
    expect(send).toHaveBeenCalledWith({ type: 'run', request: { kind: 'install', packageId: 'Serilog', version: '4.2.0', projects: ['/a/Api.csproj'] } });
  });
  it('shows deprecated banner', () => {
    const { el } = render({ deprecation: { reasons: ['Legacy'] } });
    expect(el.querySelector('.banner')).not.toBeNull();
  });
  it('renders non-http links as plain text', () => {
    const { el } = render({ projectUrl: 'javascript:alert(1)', vulnerabilities: [{ severity: 'High', advisoryUrl: 'https://ok.example/a' }] });
    expect(el.querySelectorAll('a')).toHaveLength(1);
    expect(el.querySelector('a')!.getAttribute('href')).toBe('https://ok.example/a');
    expect(el.textContent).toContain('Project');
  });
  it('keeps chosen version and ticked projects when the same package is re-rendered', () => {
    const el = document.createElement('div');
    const send = vi.fn();
    const per = { '/a/Api.csproj': null, '/a/Core.csproj': '3.1.1' };
    renderDetails(el, details, ['4.2.0', '4.1.0'], per, projects, send, { preselect: '/a/Api.csproj' });
    const boxes = () => el.querySelectorAll<HTMLInputElement>('.projects input[type=checkbox]');
    boxes()[1].click();
    const sel = el.querySelector<HTMLSelectElement>('.actions select')!;
    sel.value = '4.1.0';
    sel.dispatchEvent(new Event('change'));
    expect(send).toHaveBeenCalledWith({ type: 'selectVersion', id: 'Serilog', version: '4.1.0' });
    // Host reply for the chosen version: full list again, details for 4.1.0.
    renderDetails(el, { ...details, version: '4.1.0' }, ['4.2.0', '4.1.0'], per, projects, send, { preselect: '/a/Api.csproj' });
    expect([...boxes()].map((b) => b.checked)).toEqual([true, true]);
    const opts = [...el.querySelectorAll<HTMLOptionElement>('.actions option')].map((o) => o.textContent);
    expect(opts).toEqual(['4.2.0 (latest)', '4.1.0']);
    expect(el.querySelector<HTMLSelectElement>('.actions select')!.value).toBe('4.1.0');
    // Refresh after an operation: details for latest, but the user's choice is kept.
    renderDetails(el, details, ['4.2.0', '4.1.0'], per, projects, send, { preselect: '/a/Api.csproj' });
    expect(el.querySelector<HTMLSelectElement>('.actions select')!.value).toBe('4.1.0');
    expect([...boxes()].map((b) => b.checked)).toEqual([true, true]);
  });
  it('a different package starts from the preselected project', () => {
    const el = document.createElement('div');
    const per = { '/a/Api.csproj': null, '/a/Core.csproj': null };
    renderDetails(el, details, ['4.2.0'], per, projects, vi.fn(), { preselect: '/a/Api.csproj' });
    el.querySelectorAll<HTMLInputElement>('.projects input[type=checkbox]')[1].click();
    renderDetails(el, { ...details, id: 'Other' }, ['1.0.0'], per, projects, vi.fn(), { preselect: '/a/Api.csproj' });
    expect([...el.querySelectorAll<HTMLInputElement>('.projects input[type=checkbox]')].map((b) => b.checked)).toEqual([true, false]);
  });
  it('marks projects whose version comes from a VersionOverride', () => {
    const el = document.createElement('div');
    renderDetails(el, details, ['4.2.0'], { '/a/Api.csproj': '4.2.0', '/a/Core.csproj': '3.1.1' }, projects, vi.fn(), { overrides: ['/a/Core.csproj'] });
    const labels = [...el.querySelectorAll('.projects label')].map((l) => l.textContent);
    expect(labels[0]).not.toContain('(override)');
    expect(labels[1]).toContain('3.1.1 (override)');
  });
});
