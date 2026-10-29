// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import type { LaunchProfile } from '../../../src/launch/launchSettings';
import type { LaunchProfilesView, PropsToHost } from '../../../src/properties/protocol';
import { renderProfiles } from '../../../src/webview/properties/views/profiles';

const prof = (o: Partial<LaunchProfile> & { name: string }): LaunchProfile =>
  ({ commandName: 'Project', supported: true, environmentVariables: {}, ...o });
function setup(profiles: LaunchProfile[], active?: string) {
  const root = document.createElement('div');
  document.body.append(root);
  const send = vi.fn<(m: PropsToHost) => void>();
  const view = renderProfiles(root, {}, send);
  const model: LaunchProfilesView = { profiles, path: '/p/Properties/launchSettings.json', exists: true, ...(active ? { active } : {}) };
  view.update(model);
  return { root, send };
}
const fire = (e: Element, t: string) => e.dispatchEvent(new Event(t, { bubbles: true }));

describe('profiles view', () => {
  it('selecting a profile shows its fields', () => {
    const { root } = setup([prof({ name: 'a', applicationUrl: 'http://a' }), prof({ name: 'b', commandName: 'Executable', executablePath: '/bin/x' })], 'a');
    expect((root.querySelector('#pf-applicationUrl') as HTMLInputElement).value).toBe('http://a');
    const sel = root.querySelector('#profile-select') as HTMLSelectElement;
    sel.value = 'b';
    fire(sel, 'change');
    expect((root.querySelector('#pf-executablePath') as HTMLInputElement).value).toBe('/bin/x');
    expect(root.querySelector('#pf-applicationUrl')).toBeNull();
  });

  it('editing a field emits a set action, empty clears it', () => {
    const { root, send } = setup([prof({ name: 'a', launchUrl: 'x' })]);
    const i = root.querySelector('#pf-launchUrl') as HTMLInputElement;
    i.value = '';
    fire(i, 'change');
    expect(send).toHaveBeenLastCalledWith({ type: 'profiles', action: { kind: 'set', name: 'a', field: 'launchUrl', value: undefined } });
  });

  it('editing env table emits env action', () => {
    const { root, send } = setup([prof({ name: 'a', environmentVariables: { A: '1' } })]);
    (root.querySelector('.env-add') as HTMLButtonElement).click();
    const rows = root.querySelectorAll('.env-row');
    const [k, v] = rows[1].querySelectorAll('input');
    k.value = 'B'; v.value = '2';
    fire(v, 'change');
    expect(send).toHaveBeenLastCalledWith({ type: 'profiles', action: { kind: 'env', name: 'a', env: { A: '1', B: '2' } } });
    (rows[0].querySelector('.env-remove') as HTMLButtonElement).click();
    expect(send).toHaveBeenLastCalledWith({ type: 'profiles', action: { kind: 'env', name: 'a', env: { B: '2' } } });
  });

  it('unsupported profile is read-only', () => {
    const { root } = setup([prof({ name: 'iis', commandName: 'IISExpress', supported: false })]);
    expect(root.textContent).toContain('Not supported on this system');
    expect(root.querySelectorAll('.profile-editor input:not(:disabled)').length).toBe(0);
    expect((root.querySelector('#profile-active') as HTMLButtonElement).disabled).toBe(true);
  });

  it('New, Rename, Delete and Set as active emit their messages', () => {
    const { root, send } = setup([prof({ name: 'a' }), prof({ name: 'b' })], 'a');
    const name = root.querySelector('#profile-name') as HTMLInputElement;
    name.value = 'c';
    (root.querySelector('#profile-new') as HTMLButtonElement).click();
    expect(send).toHaveBeenLastCalledWith({ type: 'profiles', action: { kind: 'new', name: 'c', commandName: 'Project' } });
    (root.querySelector('#profile-rename') as HTMLButtonElement).click();
    expect(send).toHaveBeenLastCalledWith({ type: 'profiles', action: { kind: 'rename', from: 'a', name: 'c' } });
    (root.querySelector('#profile-delete') as HTMLButtonElement).click();
    expect(send).toHaveBeenLastCalledWith({ type: 'profiles', action: { kind: 'delete', name: 'a' } });
    const sel = root.querySelector('#profile-select') as HTMLSelectElement;
    sel.value = 'b'; fire(sel, 'change');
    (root.querySelector('#profile-active') as HTMLButtonElement).click();
    expect(send).toHaveBeenLastCalledWith({ type: 'setActiveProfile', name: 'b' });
  });
});
