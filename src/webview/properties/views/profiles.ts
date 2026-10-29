// Launch profile editor for the Debug section. Edits go straight to launchSettings.json (separate from the csproj Save).
import type { LaunchProfile, ProfileAction } from '../../../launch/launchSettings';
import type { LaunchProfilesView, PropsToHost } from '../../../properties/protocol';

type StringField = 'commandLineArgs' | 'workingDirectory' | 'applicationUrl' | 'launchUrl' | 'executablePath';

const FIELDS: Record<string, { field: StringField; label: string }[]> = {
  Project: [
    { field: 'commandLineArgs', label: 'Command line arguments' },
    { field: 'workingDirectory', label: 'Working directory' },
    { field: 'applicationUrl', label: 'Application URL' },
    { field: 'launchUrl', label: 'Launch URL' },
  ],
  Executable: [
    { field: 'executablePath', label: 'Executable path' },
    { field: 'commandLineArgs', label: 'Command line arguments' },
    { field: 'workingDirectory', label: 'Working directory' },
  ],
};

export function renderProfiles(
  root: HTMLElement,
  labels: Record<string, string>,
  send: (m: PropsToHost) => void,
  readOnly = false,
): { update(model: LaunchProfilesView): void } {
  const L = (k: string): string => labels[k] ?? k;
  let selected: string | undefined;

  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };
  const act = (action: ProfileAction): void => send({ type: 'profiles', action });

  function update(model: LaunchProfilesView): void {
    root.textContent = '';
    root.classList.add('profiles');
    const { profiles } = model;
    if (!profiles.some((p) => p.name === selected)) selected = model.active ?? profiles[0]?.name;
    const cur = profiles.find((p) => p.name === selected);

    root.append(el('h3', undefined, L('Launch profiles')));
    if (!model.exists) root.append(el('p', 'muted', L('launchSettings.json is created when you add the first profile.')));

    const bar = el('div', 'profiles-bar');
    const sel = el('select');
    sel.id = 'profile-select';
    for (const p of profiles) {
      const o = el('option', undefined, p.name === model.active ? `${p.name} (${L('Active profile')})` : p.name);
      o.value = p.name;
      sel.append(o);
    }
    if (cur) sel.value = cur.name;
    sel.disabled = profiles.length === 0;
    sel.addEventListener('change', () => { selected = sel.value; update(model); });
    bar.append(sel);

    const nameIn = el('input');
    nameIn.type = 'text';
    nameIn.id = 'profile-name';
    nameIn.placeholder = L('Profile name');
    nameIn.disabled = readOnly;
    const kind = el('select');
    kind.id = 'profile-kind';
    for (const k of ['Project', 'Executable'] as const) { const o = el('option', undefined, L(k)); o.value = k; kind.append(o); }
    kind.disabled = readOnly;
    const btn = (id: string, text: string, off: boolean, fn: () => void): HTMLButtonElement => {
      const b = el('button', undefined, L(text));
      b.id = id;
      b.disabled = readOnly || off;
      b.addEventListener('click', fn);
      return b;
    };
    const name = (): string => nameIn.value.trim();
    bar.append(
      nameIn, kind,
      btn('profile-new', 'New profile', false, () => act({ kind: 'new', name: name(), commandName: kind.value as 'Project' | 'Executable' })),
      btn('profile-dup', 'Duplicate', !cur, () => act({ kind: 'duplicate', from: cur!.name, name: name() })),
      btn('profile-rename', 'Rename', !cur, () => act({ kind: 'rename', from: cur!.name, name: name() })),
      btn('profile-delete', 'Delete', !cur, () => act({ kind: 'delete', name: cur!.name })),
      btn('profile-active', 'Set as active', !cur || !cur.supported || cur.name === model.active, () => send({ type: 'setActiveProfile', name: cur!.name })),
    );
    root.append(bar);
    if (cur) root.append(editor(cur));
  }

  function editor(p: LaunchProfile): HTMLElement {
    const box = el('div', 'profile-editor');
    const off = readOnly || !p.supported;
    if (!p.supported) box.append(el('p', 'muted', L('Not supported on this system')));
    box.append(row(L('Command'), el('span', undefined, p.commandName)));
    for (const { field, label } of FIELDS[p.commandName] ?? []) {
      const input = el('input');
      input.type = 'text';
      input.id = `pf-${field}`;
      input.value = p[field] ?? '';
      input.disabled = off;
      input.addEventListener('change', () => act({ kind: 'set', name: p.name, field, value: input.value === '' ? undefined : input.value }));
      box.append(row(L(label), input));
    }
    if (p.commandName === 'Project') {
      const cb = el('input');
      cb.type = 'checkbox';
      cb.id = 'pf-launchBrowser';
      cb.checked = p.launchBrowser === true;
      cb.disabled = off;
      cb.addEventListener('change', () => act({ kind: 'set', name: p.name, field: 'launchBrowser', value: cb.checked }));
      box.append(row(L('Launch browser'), cb));
    }
    box.append(envTable(p, off));
    return box;
  }

  function envTable(p: LaunchProfile, off: boolean): HTMLElement {
    const wrap = el('div', 'profile-env');
    wrap.append(el('h4', undefined, L('Environment variables')));
    const table = el('div', 'env-rows');
    const collect = (): Record<string, string> => {
      const env: Record<string, string> = {};
      for (const r of table.querySelectorAll<HTMLElement>('.env-row')) {
        const [k, v] = [...r.querySelectorAll('input')].map((i) => i.value);
        if (k.trim() !== '') env[k.trim()] = v;
      }
      return env;
    };
    const emit = (): void => act({ kind: 'env', name: p.name, env: collect() });
    const addRow = (k: string, v: string): void => {
      const r = el('div', 'env-row');
      const ki = el('input'); ki.type = 'text'; ki.value = k; ki.placeholder = L('Name'); ki.disabled = off;
      const vi = el('input'); vi.type = 'text'; vi.value = v; vi.placeholder = L('Value'); vi.disabled = off;
      const rm = el('button', 'env-remove', L('Remove')); rm.disabled = off;
      ki.addEventListener('change', emit);
      vi.addEventListener('change', emit);
      rm.addEventListener('click', () => { r.remove(); emit(); });
      r.append(ki, vi, rm);
      table.append(r);
    };
    for (const [k, v] of Object.entries(p.environmentVariables)) addRow(k, v);
    const add = el('button', 'env-add', L('Add variable'));
    add.disabled = off;
    add.addEventListener('click', () => addRow('', ''));
    wrap.append(table, add);
    return wrap;
  }

  const row = (label: string, control: HTMLElement): HTMLElement => {
    const r = el('div', 'props-field');
    r.append(el('label', 'props-label', label), control);
    return r;
  };

  return { update };
}
