// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { renderProperties } from '../../../src/webview/properties/views/form';
import { FIELDS } from '../../../src/properties/schema';
import type { FieldState, PropertiesModel } from '../../../src/properties/model';
import type { PropsToHost } from '../../../src/properties/protocol';
import { loadProperties, saveProperties, type PropertiesDeps } from '../../../src/properties/model';

function model(over: Record<string, Partial<FieldState>> = {}, extra: Partial<PropertiesModel> = {}): PropertiesModel {
  return {
    projectPath: '/p/a.csproj', text: '', readOnly: false,
    fields: FIELDS.map((f) => ({ property: f.property, evaluated: '', origin: 'inherited' as const, duplicates: false, ...over[f.property] })),
    ...extra,
  };
}
function setup(m: PropertiesModel, labels: Record<string, string> = {}) {
  const root = document.createElement('div');
  document.body.append(root);
  const send = vi.fn<(m: PropsToHost) => void>();
  const api = renderProperties(root, m, labels, send);
  return { root, send, api };
}
const input = (root: HTMLElement, id: string) => root.querySelector<HTMLInputElement | HTMLSelectElement>(`#f-${id}`)!;
const fire = (e: Element, type: string) => e.dispatchEvent(new Event(type, { bubbles: true }));
const last = (send: ReturnType<typeof vi.fn>) => send.mock.calls[send.mock.calls.length - 1][0] as PropsToHost;

describe('properties form', () => {
  it('renders sections in order, translated through labels', () => {
    const { root } = setup(model(), { Build: 'Compilar' });
    const names = [...root.querySelectorAll('nav button')].map((b) => b.textContent);
    expect(names).toEqual(['Application', 'Compilar', 'Package', 'Assembly', 'Debug', 'Secrets']);
  });

  it('changing Nullable emits set edit and dirty true', () => {
    const { root, send, api } = setup(model({ Nullable: { evaluated: 'disable' } }));
    const sel = input(root, 'Nullable') as HTMLSelectElement;
    sel.value = 'enable';
    fire(sel, 'change');
    expect(api.collectEdits()).toEqual([{ kind: 'set', name: 'Nullable', value: 'enable' }]);
    expect(last(send)).toEqual({ type: 'dirty', dirty: true, edits: [{ kind: 'set', name: 'Nullable', value: 'enable' }] });
  });

  it('changing back to clean posts dirty false with no edits', () => {
    const { root, send } = setup(model({ Nullable: { evaluated: 'disable' } }));
    const sel = input(root, 'Nullable') as HTMLSelectElement;
    sel.value = 'enable'; fire(sel, 'change');
    sel.value = 'disable'; fire(sel, 'change');
    expect(last(send)).toEqual({ type: 'dirty', dirty: false, edits: [] });
  });

  it('Reset on an overriding project value emits remove', () => {
    const { root, api } = setup(model({ Nullable: { origin: 'project', raw: 'enable', evaluated: 'enable' } }));
    const btn = root.querySelector<HTMLButtonElement>('.props-reset')!;
    expect(btn.textContent).toBe('Reset');
    btn.click();
    expect(api.collectEdits()).toEqual([{ kind: 'remove', name: 'Nullable' }]);
  });

  it('empty text on a project field becomes remove; bool maps to true/false', () => {
    const { root, api } = setup(model({
      Authors: { origin: 'project', raw: 'me', evaluated: 'me' },
      IsPackable: { origin: 'project', raw: 'true', evaluated: 'true' },
    }));
    const a = input(root, 'Authors'); a.value = ''; fire(a, 'input');
    const c = input(root, 'IsPackable') as HTMLInputElement; c.checked = false; fire(c, 'change');
    expect(api.collectEdits()).toEqual([
      { kind: 'set', name: 'IsPackable', value: 'false' },
      { kind: 'remove', name: 'Authors' },
    ].sort((x, y) => FIELDS.findIndex((f) => f.property === x.name) - FIELDS.findIndex((f) => f.property === y.name)));
  });

  it('conditional field is disabled with Open in .csproj', () => {
    const { root, send } = setup(model({ Nullable: { origin: 'conditional', evaluated: 'enable' } }));
    expect(input(root, 'Nullable').disabled).toBe(true);
    const link = [...root.querySelectorAll('a')].find((a) => a.textContent === 'Open in .csproj')!;
    link.click();
    expect(send).toHaveBeenCalledWith({ type: 'openCsproj', property: 'Nullable' });
    expect(root.textContent).toContain('set per configuration');
  });

  it('invalid TFM disables Save and shows message', () => {
    const { root } = setup(model({ TargetFramework: { origin: 'project', raw: 'net8.0', evaluated: 'net8.0' } }));
    const save = root.querySelector<HTMLButtonElement>('button.primary')!;
    const tf = root.querySelector<HTMLInputElement>('.props-control input[placeholder="net8.0"]')!;
    tf.value = 'bogus'; fire(tf, 'input');
    expect(save.disabled).toBe(true);
    expect(root.textContent).toContain('Not a valid target framework');
  });

  it('invalid version shows message and disables Save', () => {
    const { root } = setup(model({ Version: { origin: 'project', raw: '1.0.0', evaluated: '1.0.0' } }));
    const v = input(root, 'Version'); v.value = 'x'; fire(v, 'input');
    expect(root.querySelector<HTMLButtonElement>('button.primary')!.disabled).toBe(true);
    expect(root.textContent).toContain('Use a version like');
  });

  it('two TFMs emit one targetFrameworks edit', () => {
    const { root, api } = setup(model({ TargetFramework: { origin: 'project', raw: 'net8.0', evaluated: 'net8.0' } }));
    const tf = root.querySelector<HTMLInputElement>('.props-control input[placeholder="net8.0"]')!;
    tf.value = 'net9.0';
    tf.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(api.collectEdits()).toEqual([{ kind: 'targetFrameworks', tfms: ['net8.0', 'net9.0'] }]);
  });

  it('save button posts save with edits', () => {
    const { root, send } = setup(model({ Nullable: { evaluated: 'disable' } }));
    const sel = input(root, 'Nullable'); sel.value = 'enable'; fire(sel, 'change');
    root.querySelector<HTMLButtonElement>('button.primary')!.click();
    expect(last(send)).toEqual({ type: 'save', edits: [{ kind: 'set', name: 'Nullable', value: 'enable' }] });
  });

  it('read-only model disables all inputs and shows banner', () => {
    const { root } = setup(model({}, { readOnly: true, error: 'boom' }));
    expect(root.textContent).toContain('read-only');
    expect(root.textContent).toContain('boom');
    for (const c of root.querySelectorAll<HTMLInputElement>('.props-control input, .props-control select')) expect(c.disabled).toBe(true);
    expect(root.querySelector<HTMLButtonElement>('button.primary')!.disabled).toBe(true);
  });

  it('an unrelated change never emits edits for untouched multi-line values', () => {
    const { root, api, send } = setup(model({
      PackageReleaseNotes: { origin: 'project', raw: 'line one\nline two', evaluated: 'line one\nline two' },
      NoWarn: { origin: 'project', raw: 'CS1591;\r\n      CS0618', evaluated: 'CS1591;\r\n      CS0618' },
      Version: { origin: 'project', raw: '1.0.0', evaluated: '1.0.0' },
    }));
    const v = input(root, 'Version'); v.value = '1.0.1'; fire(v, 'input');
    expect(api.collectEdits()).toEqual([{ kind: 'set', name: 'Version', value: '1.0.1' }]);
    expect(last(send)).toEqual({ type: 'dirty', dirty: true, edits: [{ kind: 'set', name: 'Version', value: '1.0.1' }] });
  });

  it('a multi-line project value is read-only with a badge and Open in .csproj', () => {
    const { root, send } = setup(model({ PackageReleaseNotes: { origin: 'project', raw: 'a\nb', evaluated: 'a\nb' } }), { 'multi-line': 'várias linhas' });
    expect(input(root, 'PackageReleaseNotes').disabled).toBe(true);
    const row = input(root, 'PackageReleaseNotes').closest('.props-field')!;
    expect(row.textContent).toContain('várias linhas');
    expect(row.querySelector('.props-reset')).toBeNull();
    [...row.querySelectorAll<HTMLElement>('a, button')].find((b) => b.textContent === 'Open in .csproj')!.click();
    expect(send).toHaveBeenCalledWith({ type: 'openCsproj', property: 'PackageReleaseNotes' });
  });

  it('shows the evaluated value under a project field when it differs from the text', () => {
    const { root } = setup(model({
      Version: { origin: 'project', raw: '$(BaseVersion)', evaluated: '2.1.0' },
      Authors: { origin: 'project', raw: 'me', evaluated: 'me' },
    }), { 'Evaluated: {0}': 'Avaliado: {0}' });
    const row = (id: string) => input(root, id).closest('.props-field')!;
    expect(row('Version').querySelector('.props-evaluated')!.textContent).toBe('Avaliado: 2.1.0');
    expect(row('Authors').querySelector('.props-evaluated')).toBeNull();
    expect(input(root, 'Version').value).toBe('$(BaseVersion)');
  });

  it('read-only after failed evaluation marks project values as not evaluated', () => {
    const { root } = setup(model({ Version: { origin: 'project', raw: '$(BaseVersion)', evaluated: '' } }, { readOnly: true, error: 'boom' }));
    const row = input(root, 'Version').closest('.props-field')!;
    expect(input(root, 'Version').value).toBe('$(BaseVersion)');
    expect(row.textContent).toContain('from .csproj, not evaluated');
    expect(row.querySelector('.props-evaluated')).toBeNull();
    expect(input(root, 'Authors').closest('.props-field')!.textContent).not.toContain('not evaluated');
  });

  describe('round-trip through the model', () => {
    const CS = '<Project Sdk="Microsoft.NET.Sdk">\n  <PropertyGroup>\n    <Company>A &amp; B</Company>\n    <Version>1.0.0</Version>\n  </PropertyGroup>\n</Project>\n';
    const decode = (s: string) => s.replace(/&amp;/g, '&');
    function deps(disk: { text: string }): PropertiesDeps {
      let tmp = '';
      return {
        readText: async () => disk.text,
        getProperties: async (_p, names) => Object.fromEntries(names.map((n) => [n, decode(new RegExp(`<${n}>([^<]*)<`).exec(tmp || disk.text)?.[1] ?? '')])),
        writer: {
          readFile: async () => disk.text,
          writeFile: async (p, s) => { if (p.endsWith('.cw-tmp')) tmp = s; },
          rename: async () => { disk.text = tmp; tmp = ''; },
          unlink: async () => {}, realpath: async (p) => p, mode: async () => 0o644, chmod: async () => {}, canWrite: async () => true,
        },
      };
    }
    it('keeps A &amp; B byte-identical when another field changes', async () => {
      const disk = { text: CS };
      const d = deps(disk);
      const m = await loadProperties('/p/a.csproj', d);
      const { root, api } = setup(m);
      expect(input(root, 'Company').value).toBe('A & B');
      const v = input(root, 'Version'); v.value = '1.0.1'; fire(v, 'input');
      await saveProperties(m, api.collectEdits(), d);
      expect(disk.text).toBe(CS.replace('1.0.0', '1.0.1'));
    });
    it('writing A & B C escapes the ampersand exactly once', async () => {
      const disk = { text: CS };
      const d = deps(disk);
      const m = await loadProperties('/p/a.csproj', d);
      const { root, api } = setup(m);
      const c = input(root, 'Company'); c.value += ' C'; fire(c, 'input');
      expect(api.collectEdits()).toEqual([{ kind: 'set', name: 'Company', value: 'A & B C' }]);
      await saveProperties(m, api.collectEdits(), d);
      expect(disk.text).toContain('<Company>A &amp; B C</Company>');
    });
  });

  it('secrets section sends manageSecrets', () => {
    const { root, send } = setup(model());
    [...root.querySelectorAll<HTMLButtonElement>('section button')].find((b) => b.textContent === 'Manage user secrets')!.click();
    expect(send).toHaveBeenCalledWith({ type: 'manageSecrets' });
  });
});
