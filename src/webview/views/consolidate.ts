import type { ToHost } from '../../panel/protocol';
import type { ConsolidateRow } from '../../state/viewModel';

export function renderConsolidate(
  el: HTMLElement,
  rows: ConsolidateRow[],
  cpm: boolean,
  send: (m: ToHost) => void,
): void {
  el.replaceChildren();
  if (cpm) {
    const note = document.createElement('div');
    note.className = 'muted note';
    note.textContent = 'Removes VersionOverride from these projects';
    el.append(note);
  }
  for (const r of rows) {
    const row = document.createElement('div');
    row.className = 'row consolidate-row';
    const text = document.createElement('div');
    text.className = 'row-text';
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = r.id;
    text.append(name);
    for (const [project, v] of Object.entries(r.versions)) {
      const line = document.createElement('div');
      line.className = 'muted';
      line.textContent = `${project}: ${v}`;
      text.append(line);
    }
    const sel = document.createElement('select');
    const options = [...new Set([...Object.values(r.versions).flatMap((v) => v.split(', ')), r.target])].filter(Boolean);
    for (const v of options) {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = v;
      sel.append(o);
    }
    sel.value = r.target;
    const btn = document.createElement('button');
    btn.className = 'primary consolidate';
    btn.textContent = 'Consolidate';
    btn.addEventListener('click', () =>
      send({ type: 'run', request: { kind: 'consolidate', packageId: r.id, version: sel.value, projects: Object.keys(r.versions) } }));
    row.append(text, sel, btn);
    el.append(row);
  }
}
