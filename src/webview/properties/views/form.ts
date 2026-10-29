// Project Properties form: left nav of sections, right form of fields with badges and validation.
import type { PropertyEdit } from '../../../properties/csprojEdit';
import type { FieldState, PropertiesModel } from '../../../properties/model';
import type { LaunchProfilesView, PropsToHost } from '../../../properties/protocol';
import { renderProfiles } from './profiles';
import { FIELDS, validateTfm, type FieldDef, type SectionId } from '../../../properties/schema';

const SECTIONS: { id: SectionId; name: string }[] = [
  { id: 'application', name: 'Application' },
  { id: 'build', name: 'Build' },
  { id: 'package', name: 'Package' },
  { id: 'assembly', name: 'Assembly' },
  { id: 'debug', name: 'Debug' },
  { id: 'secrets', name: 'Secrets' },
];

interface Entry {
  def: FieldDef;
  state: FieldState;
  initial: string | boolean | string[];
  reset: boolean;
  current(): string | boolean | string[];
  message(): string | undefined;
  update(): void; // re-renders message and badges
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const splitTfms = (s: string): string[] => s.split(';').map((x) => x.trim()).filter((x) => x !== '');

export function renderProperties(
  root: HTMLElement,
  model: PropertiesModel,
  labels: Record<string, string>,
  send: (m: PropsToHost) => void,
): { collectEdits(): PropertyEdit[]; setProfiles(m: LaunchProfilesView): void } {
  const L = (k: string): string => labels[k] ?? k;
  root.textContent = '';
  root.classList.add('props');
  const entries: Entry[] = [];
  const ro = model.readOnly;

  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };

  const collectEdits = (): PropertyEdit[] => {
    const edits: PropertyEdit[] = [];
    for (const en of entries) {
      const { def, state } = en;
      if (state.origin === 'conditional') continue;
      const cur = en.current();
      if (def.kind === 'tfms') {
        const tfms = cur as string[];
        if (tfms.length > 0 && !same(tfms, en.initial)) edits.push({ kind: 'targetFrameworks', tfms });
      } else if (en.reset) {
        if (state.origin === 'project') edits.push({ kind: 'remove', name: def.property });
      } else if (!same(cur, en.initial)) {
        if (def.kind === 'bool') edits.push({ kind: 'set', name: def.property, value: cur ? 'true' : 'false' });
        else if (cur === '') {
          if (state.origin === 'project') edits.push({ kind: 'remove', name: def.property });
        } else edits.push({ kind: 'set', name: def.property, value: cur as string });
      }
    }
    return edits;
  };

  const header = el('div', 'props-bar');
  const save = el('button', 'primary', L('Save'));
  header.append(save);
  if (ro) {
    const b = el('div', 'banner banner-vulnerable');
    b.textContent = [L('The project could not be evaluated, so it is read-only.'), model.error].filter(Boolean).join(' ');
    root.append(b);
  }
  const nav = el('nav', 'props-nav');
  const form = el('div', 'props-form');
  const wrap = el('div', 'props-body');
  wrap.append(nav, form);
  root.append(header, wrap);

  const sync = (): void => {
    for (const en of entries) en.update();
    const invalid = entries.some((en) => en.message() !== undefined);
    const edits = collectEdits();
    save.disabled = ro || invalid || edits.length === 0;
    send({ type: 'dirty', dirty: edits.length > 0, edits });
  };
  save.addEventListener('click', () => send({ type: 'save', edits: collectEdits() }));

  const sections = new Map<SectionId, HTMLElement>();
  const select = (id: SectionId): void => {
    for (const [sid, s] of sections) s.hidden = sid !== id;
    nav.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.section === id));
  };
  for (const s of SECTIONS) {
    const b = el('button', 'tab', L(s.name));
    b.dataset.section = s.id;
    b.addEventListener('click', () => select(s.id));
    nav.append(b);
    const pane = el('section', 'props-section');
    pane.dataset.section = s.id;
    sections.set(s.id, pane);
    form.append(pane);
  }

  const states = new Map(model.fields.map((f) => [f.property, f]));
  for (const def of FIELDS) {
    const state = states.get(def.property);
    if (!state) continue;
    const row = el('div', 'props-field');
    const label = el('label', 'props-label', L(def.label));
    const badges = el('span', 'props-badges');
    const msg = el('div', 'props-msg');
    const controlWrap = el('div', 'props-control');
    row.append(label, controlWrap, badges, msg);
    sections.get(def.section)!.append(row);
    const locked = ro || state.origin === 'conditional';
    const base = state.origin === 'project' ? (state.raw ?? state.evaluated) : state.evaluated;

    let currentFn: () => string | boolean | string[];
    let initial: string | boolean | string[];
    let extraMessage: () => string | undefined = () => undefined;
    let setDisplay: (evaluated: string) => void = () => {};

    if (def.kind === 'bool') {
      const input = el('input');
      input.type = 'checkbox';
      input.checked = base.trim().toLowerCase() === 'true';
      input.disabled = locked;
      input.addEventListener('change', () => { entry.reset = false; sync(); });
      controlWrap.append(input);
      label.htmlFor = (input.id = `f-${def.property}`);
      initial = input.checked;
      currentFn = () => input.checked;
      setDisplay = (v) => { input.checked = v.trim().toLowerCase() === 'true'; };
    } else if (def.kind === 'choice') {
      const sel = el('select');
      const opts = ['', ...(def.choices ?? [])];
      if (!opts.includes(base)) opts.push(base);
      for (const o of opts) { const op = el('option', undefined, o); op.value = o; sel.append(op); }
      sel.value = base;
      sel.disabled = locked;
      sel.addEventListener('change', () => { entry.reset = false; sync(); });
      controlWrap.append(sel);
      label.htmlFor = (sel.id = `f-${def.property}`);
      initial = base;
      currentFn = () => sel.value;
      setDisplay = (v) => { if (![...sel.options].some((o) => o.value === v)) { const op = el('option', undefined, v); op.value = v; sel.append(op); } sel.value = v; };
    } else if (def.kind === 'tfms') {
      let tfms = splitTfms(base);
      initial = [...tfms];
      const chips = el('span', 'props-chips');
      const input = el('input');
      input.type = 'text';
      input.placeholder = 'net8.0';
      input.disabled = locked;
      const add = el('button', undefined, L('Add'));
      add.disabled = locked;
      const drawChips = (): void => {
        chips.textContent = '';
        for (const t of tfms) {
          const chip = el('span', 'props-chip', t);
          const x = el('button', 'props-chip-x', '×');
          x.disabled = locked;
          x.addEventListener('click', () => { tfms = tfms.filter((y) => y !== t); entry.reset = false; drawChips(); sync(); });
          chip.append(x);
          chips.append(chip);
        }
      };
      const commit = (): void => {
        const v = input.value.trim();
        if (v === '' || validateTfm(v) !== undefined) return;
        if (!tfms.includes(v)) tfms = [...tfms, v];
        input.value = '';
        entry.reset = false;
        drawChips();
        sync();
      };
      input.addEventListener('input', sync);
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } });
      add.addEventListener('click', commit);
      drawChips();
      controlWrap.append(chips, input, add);
      currentFn = () => tfms;
      extraMessage = () => { const v = input.value.trim(); return v === '' ? undefined : validateTfm(v); };
      setDisplay = (v) => { tfms = splitTfms(v); input.value = ''; drawChips(); };
    } else {
      const input = el('input');
      input.type = 'text';
      input.value = base;
      input.disabled = locked;
      input.addEventListener('input', () => { entry.reset = false; sync(); });
      controlWrap.append(input);
      label.htmlFor = (input.id = `f-${def.property}`);
      initial = base;
      currentFn = () => input.value;
      setDisplay = (v) => { input.value = v; };
    }

    const entry: Entry = {
      def, state, initial, reset: false,
      current: currentFn,
      message: () => {
        if (state.origin === 'conditional') return undefined;
        const m = extraMessage();
        if (m) return m;
        if (def.kind === 'tfms' || !def.validate) return undefined;
        const v = currentFn();
        return typeof v === 'string' && v !== '' ? def.validate(v) : undefined;
      },
      update: () => {
        const m = entry.message();
        msg.textContent = m ? L(m) : '';
        row.classList.toggle('invalid', !!m);
      },
    };
    entries.push(entry);

    // Badges
    if (state.origin === 'inherited') badges.append(el('span', 'badge', L('inherited')));
    if (state.duplicates) badges.append(el('span', 'badge badge-warn', L('duplicate')));
    if (state.origin === 'conditional') {
      badges.append(el('span', 'badge', L('set per configuration')));
      const link = el('a', 'props-link', L('Open in .csproj'));
      link.href = '#';
      link.addEventListener('click', (e) => { e.preventDefault(); send({ type: 'openCsproj', property: def.property }); });
      badges.append(link);
    }
    if (state.origin === 'project' && !ro) {
      const btn = el('button', 'props-reset', L('Reset'));
      btn.addEventListener('click', () => {
        entry.reset = true;
        setDisplay(state.evaluated);
        sync();
      });
      badges.append(btn);
    }
  }

  const debugPane = sections.get('debug')!;
  const profilesHost = el('div');
  debugPane.append(profilesHost);
  const profiles = renderProfiles(profilesHost, labels, send);
  const secretsBtn = el('button', undefined, L('Manage user secrets'));
  secretsBtn.disabled = ro;
  secretsBtn.addEventListener('click', () => send({ type: 'manageSecrets' }));
  sections.get('secrets')!.append(secretsBtn);

  select('application');
  save.disabled = true;
  return { collectEdits, setProfiles: (m) => profiles.update(m) };
}
