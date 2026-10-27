import type { ToHost } from '../../panel/protocol';
import type { UpdateRow } from '../../state/viewModel';

/** Sends one update run at a time; the next goes out only after the previous opResult is ok. */
export class UpdateSequence {
  private queue: UpdateRow[] = [];
  constructor(private readonly send: (m: ToHost) => void) {}

  cancel(): void {
    this.queue = [];
  }

  start(rows: UpdateRow[]): void {
    this.cancel();
    this.queue = [...rows];
    this.next();
  }

  onResult(ok: boolean): void {
    if (!ok) { this.queue = []; return; }
    this.next();
  }

  private next(): void {
    const r = this.queue.shift();
    if (!r) return;
    this.send({ type: 'run', request: { kind: 'update', packageId: r.id, version: r.latest, projects: r.projects } });
  }
}

export function renderUpdates(el: HTMLElement, rows: UpdateRow[], filter: string, seq: UpdateSequence): void {
  el.replaceChildren();
  const f = filter.trim().toLowerCase();
  const shown = rows.filter((r) => r.id.toLowerCase().includes(f));
  const bar = document.createElement('div');
  bar.className = 'actions';
  const all = document.createElement('input');
  all.type = 'checkbox';
  const allLabel = document.createElement('label');
  allLabel.className = 'chk';
  allLabel.append(all, 'Select all');
  const btn = document.createElement('button');
  btn.className = 'primary update-selected';
  bar.append(allLabel, btn);
  el.append(bar);

  const boxes: { box: HTMLInputElement; row: UpdateRow }[] = [];
  const refresh = () => {
    const n = boxes.filter((b) => b.box.checked).length;
    btn.textContent = `Update selected (${n})`;
    btn.disabled = n === 0;
  };
  for (const r of shown) {
    const row = document.createElement('div');
    row.className = 'row';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.className = 'sel-row';
    box.addEventListener('click', refresh);
    const name = document.createElement('span');
    name.className = 'name row-text';
    name.textContent = r.id;
    const ver = document.createElement('span');
    ver.className = 'ver';
    ver.textContent = `${r.current.join(', ')} → ${r.latest}`;
    row.append(box, name, ver);
    boxes.push({ box, row: r });
    el.append(row);
  }
  all.addEventListener('click', () => {
    boxes.forEach((b) => { b.box.checked = all.checked; });
    refresh();
  });
  btn.addEventListener('click', () => seq.start(boxes.filter((b) => b.box.checked).map((b) => b.row)));
  refresh();
}
