import type { SearchResult } from '../../core/types';

export function formatDownloads(n: number | undefined): string {
  if (n === undefined) return '';
  const units: [number, string][] = [[1e9, 'B'], [1e6, 'M'], [1e3, 'K']];
  for (const [size, suffix] of units) {
    if (n >= size) {
      const v = n / size;
      return (v < 10 ? (Math.floor(v * 10) / 10).toFixed(1) : String(Math.floor(v))) + suffix;
    }
  }
  return String(n);
}

function icon(url: string | undefined): HTMLElement {
  const fallback = document.createElement('div');
  fallback.className = 'ico ico-fallback';
  if (!url) return fallback;
  const img = document.createElement('img');
  img.className = 'ico';
  img.alt = '';
  img.src = url;
  img.addEventListener('error', () => img.replaceWith(fallback));
  return img;
}

export function renderSearchList(
  el: HTMLElement,
  results: SearchResult[],
  failures: { source: string; message: string }[],
  onSelect: (id: string) => void,
  append = false,
): void {
  if (!append) el.replaceChildren();
  for (const f of failures) {
    const w = document.createElement('div');
    w.className = 'warning';
    w.textContent = `${f.source}: ${f.message}`;
    el.append(w);
  }
  for (const r of results) {
    const row = document.createElement('div');
    row.className = 'row';
    row.dataset.id = r.id;
    const text = document.createElement('div');
    text.className = 'row-text';
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = r.id;
    const meta = document.createElement('div');
    meta.className = 'muted';
    const dl = formatDownloads(r.totalDownloads);
    meta.textContent = dl ? `${r.description} · ${dl}` : r.description;
    text.append(name, meta);
    const ver = document.createElement('span');
    ver.className = 'ver';
    ver.textContent = r.latestVersion;
    row.append(icon(r.iconUrl), text, ver);
    row.addEventListener('click', () => {
      el.querySelectorAll('.row.sel').forEach((x) => x.classList.remove('sel'));
      row.classList.add('sel');
      onSelect(r.id);
    });
    el.append(row);
  }
}
