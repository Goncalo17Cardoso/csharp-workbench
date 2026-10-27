import type { InstalledRow } from '../../state/viewModel';

const distinct = (xs: string[]) => [...new Set(xs.filter(Boolean))];

/** Version column: plain versions, or under CPM the central version plus any VersionOverride versions. */
function versionText(r: InstalledRow): string {
  if (r.central === undefined) return distinct(Object.values(r.versions)).join(', ');
  const overridden = new Set(r.overrides);
  const parts: string[] = [];
  if (Object.keys(r.versions).some((p) => !overridden.has(p))) parts.push(`${r.central} (central)`);
  for (const v of distinct(r.overrides.map((p) => r.versions[p] ?? ''))) parts.push(`${v} (override)`);
  return parts.join(', ');
}

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
    ver.textContent = versionText(r);
    row.append(name, ver);
    row.addEventListener('click', () => {
      el.querySelectorAll('.row.sel').forEach((x) => x.classList.remove('sel'));
      row.classList.add('sel');
      onSelect(r.id);
    });
    el.append(row);
  }
}
