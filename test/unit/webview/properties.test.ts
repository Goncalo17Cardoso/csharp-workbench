// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { renderProperties } from '../../../src/webview/properties/views/form';
import { FIELDS } from '../../../src/properties/schema';
import type { FieldState, PropertiesModel } from '../../../src/properties/model';
import type { PropsToHost } from '../../../src/properties/protocol';

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

  it('secrets section sends manageSecrets', () => {
    const { root, send } = setup(model());
    [...root.querySelectorAll<HTMLButtonElement>('section button')].find((b) => b.textContent === 'Manage user secrets')!.click();
    expect(send).toHaveBeenCalledWith({ type: 'manageSecrets' });
  });
});
