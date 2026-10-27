import type { ToHost } from '../../panel/protocol';
import type { ConsolidateRow } from '../../state/viewModel';
import { setOwnDisabled } from '../chrome';

/** Project name shown for a project path: file name without `.csproj`. */
const projectName = (path: string) => (path.split('/').pop() ?? path).replace(/\.csproj$/i, '');

export function renderConsolidate(
  el: HTMLElement,
  rows: ConsolidateRow[],
  cpm: boolean,
  send: (m: ToHost) => void,
  filter = '',
): void {
  el.replaceChildren();
  const f = filter.trim().toLowerCase();
  if (cpm) {
    const note = document.createElement('div');
    note.className = 'muted note';
    note.textContent = 'Removes VersionOverride from these projects';
    el.append(note);
  }
  for (const r of rows.filter((x) => x.id.toLowerCase().includes(f))) {
    const row = document.createElement('div');
    row.className = 'row consolidate-row';
    const text = document.createElement('div');
    text.className = 'row-text';
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = r.id;
    text.append(name);
    const boxes: { box: HTMLInputElement; path: string }[] = [];
    for (const [project, v] of Object.entries(r.versions)) {
      const line = document.createElement('label');
      line.className = 'chk muted';
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.className = 'consolidate-project';
      box.checked = true;
      line.title = project;
      line.append(box, `${projectName(project)}: ${v}`);
      text.append(line);
      boxes.push({ box, path: project });
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
    const ticked = () => boxes.filter((b) => b.box.checked).map((b) => b.path);
    const sync = () => setOwnDisabled(btn, ticked().length === 0);
    boxes.forEach((b) => b.box.addEventListener('click', sync));
    btn.addEventListener('click', () =>
      send({ type: 'run', request: { kind: 'consolidate', packageId: r.id, version: sel.value, projects: ticked() } }));
    row.append(text, sel, btn);
    sync();
    el.append(row);
  }
}
