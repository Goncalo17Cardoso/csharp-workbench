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

/**
 * Browse paging state. Every request gets a sequence number that the host echoes back;
 * only the response to the latest request is accepted, so an older response can neither
 * replace nor append to newer results.
 */
export class SearchPager {
  private seq = 0;
  private skip = 0;
  private loading = false;
  private appending = false;
  private exhausted = false;

  constructor(private readonly page: number) {}

  begin(append: boolean): { seq: number; skip: number; append: boolean } {
    if (append) this.skip += this.page;
    else { this.skip = 0; this.exhausted = false; }
    this.loading = true;
    this.appending = append;
    return { seq: ++this.seq, skip: this.skip, append };
  }

  /** True when scrolling to the end may request the next page. */
  canPage(): boolean {
    return !this.loading && !this.exhausted;
  }

  /** Whether a response should be shown; false for responses to older requests. */
  accept(seq: number, count: number): boolean {
    if (seq !== this.seq) return false;
    this.loading = false;
    if (count === 0) this.exhausted = true;
    return true;
  }

  /** The latest request failed; a failed page is retried on the next scroll. */
  fail(): void {
    if (!this.loading) return;
    this.loading = false;
    if (this.appending) this.skip = Math.max(0, this.skip - this.page);
  }
}
