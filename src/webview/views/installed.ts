import type { InstalledRow } from '../../state/viewModel';

export function renderInstalled(
  el: HTMLElement,
  rows: InstalledRow[],
  filter: string,
  onSelect: (id: string) => void,
  confirmed = true,
): void {
  el.replaceChildren();
  const f = filter.trim().toLowerCase();
  if (!confirmed) {
    const c = document.createElement('div');
    c.className = 'muted';
    c.textContent = 'confirming…';
    el.append(c);
  }
  for (const r of rows.filter((x) => x.id.toLowerCase().includes(f))) {
    const row = document.createElement('div');
    row.className = 'row';
    row.dataset.id = r.id;
    const name = document.createElement('div');
    name.className = 'name row-text';
    name.textContent = r.id;
    const ver = document.createElement('span');
    ver.className = 'ver';
    const distinct = [...new Set(Object.values(r.versions))];
    ver.textContent = r.central !== undefined ? `${r.central} (central)` : distinct.join(', ');
    row.append(name, ver);
    row.addEventListener('click', () => {
      el.querySelectorAll('.row.sel').forEach((x) => x.classList.remove('sel'));
      row.classList.add('sel');
      onSelect(r.id);
    });
    el.append(row);
  }
}
