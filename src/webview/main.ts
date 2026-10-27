import './styles.css';
import type { ProjectInfo } from '../core/types';
import type { ToHost, ToWebview } from '../panel/protocol';
import { renderSearchList } from './views/browse';
import { renderDetails } from './views/details';

export interface ShellRefs {
  tabs: Record<'browse' | 'installed' | 'updates' | 'consolidate', HTMLButtonElement>;
  target: HTMLSelectElement;
  search: HTMLInputElement;
  prerelease: HTMLInputElement;
  source: HTMLSelectElement;
  status: HTMLElement;
  list: HTMLElement;
  detail: HTMLElement;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export function renderShell(root: HTMLElement): ShellRefs {
  root.replaceChildren();
  const tabBar = el('div', 'bar');
  const names = { browse: 'Browse', installed: 'Installed', updates: 'Updates', consolidate: 'Consolidate' } as const;
  const tabs = {} as ShellRefs['tabs'];
  for (const k of Object.keys(names) as (keyof typeof names)[]) {
    const b = el('button', 'tab', names[k]);
    b.dataset.tab = k;
    tabs[k] = b;
    tabBar.append(b);
  }
  const target = el('select', 'target');
  target.title = 'Solution';
  tabBar.append(target);

  const searchBar = el('div', 'bar');
  const search = el('input', 'search');
  search.type = 'search';
  search.placeholder = 'Search packages';
  const preLabel = el('label', 'muted');
  const prerelease = el('input', '');
  prerelease.type = 'checkbox';
  preLabel.append(prerelease, ' Include prerelease');
  const srcLabel = el('label', 'muted', 'Source: ');
  const source = el('select', 'source');
  srcLabel.append(source);
  searchBar.append(search, preLabel, srcLabel);

  const status = el('div', 'status');
  const body = el('div', 'body');
  const list = el('div', 'list');
  const detail = el('div', 'detail');
  body.append(list, detail);
  root.append(tabBar, searchBar, status, body);
  return { tabs, target, search, prerelease, source, status, list, detail };
}

interface VsCodeApi { postMessage(m: ToHost): void; setState(s: unknown): void; getState(): unknown }
declare function acquireVsCodeApi(): VsCodeApi;

const PAGE = 20;

function start(): void {
  const vscode = acquireVsCodeApi();
  const send = (m: ToHost) => vscode.postMessage(m);
  const root = document.getElementById('app')!;
  const ui = renderShell(root);
  const saved = (vscode.getState() ?? {}) as { query?: string; prerelease?: boolean; source?: string };
  ui.search.value = saved.query ?? '';
  ui.prerelease.checked = saved.prerelease ?? false;

  let projects: ProjectInfo[] = [];
  let preselect: string | undefined;
  let skip = 0;
  let loading = false;
  let exhausted = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let selectedId: string | undefined;

  const persist = () => vscode.setState({ query: ui.search.value, prerelease: ui.prerelease.checked, source: ui.source.value });
  const doSearch = (append: boolean) => {
    if (!append) { skip = 0; exhausted = false; }
    loading = true;
    persist();
    send({ type: 'search', query: ui.search.value, prerelease: ui.prerelease.checked, source: ui.source.value, skip });
  };
  const select = (id: string) => {
    selectedId = id;
    send({ type: 'selectPackage', id, prerelease: ui.prerelease.checked, source: ui.source.value });
  };

  ui.search.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => doSearch(false), 300);
  });
  ui.prerelease.addEventListener('change', () => doSearch(false));
  ui.source.addEventListener('change', () => doSearch(false));
  ui.target.addEventListener('change', () => send({ type: 'switchTarget', path: ui.target.value }));
  ui.list.addEventListener('scroll', () => {
    if (!loading && !exhausted && ui.list.scrollTop + ui.list.clientHeight >= ui.list.scrollHeight - 40) {
      skip += PAGE;
      doSearch(true);
    }
  });
  for (const [k, b] of Object.entries(ui.tabs)) {
    b.addEventListener('click', () => {
      Object.values(ui.tabs).forEach((x) => x.classList.toggle('on', x === b));
      root.dataset.tab = k;
    });
  }
  ui.tabs.browse.classList.add('on');
  root.dataset.tab = 'browse';

  window.addEventListener('message', (e: MessageEvent<ToWebview>) => {
    const m = e.data;
    switch (m.type) {
      case 'init':
        projects = m.projects;
        preselect = m.preselectProject;
        ui.target.replaceChildren(...m.targets.map((t) => new Option(t.name, t.path, false, t.path === m.current.path)));
        ui.source.replaceChildren(new Option('All', 'All'), ...m.sources.map((s) => new Option(s.name, s.name)));
        if (saved.source) ui.source.value = saved.source;
        doSearch(false);
        break;
      case 'searchResults':
        loading = false;
        if (m.results.length === 0) exhausted = true;
        renderSearchList(ui.list, m.results, m.failures, select, m.append);
        break;
      case 'details':
        if (selectedId === undefined || m.details.id.toLowerCase() === selectedId.toLowerCase()) {
          renderDetails(ui.detail, m.details, m.versions, m.perProject, projects, send, preselect);
        }
        break;
      case 'busy':
        ui.status.textContent = m.label ?? '';
        break;
      case 'opResult':
        ui.status.textContent = m.message;
        break;
      case 'error': {
        ui.status.textContent = m.message;
        if (m.canOpenOutput) {
          const b = document.createElement('button');
          b.textContent = 'Open Output';
          b.addEventListener('click', () => send({ type: 'openOutput' }));
          ui.status.append(' ', b);
        }
        break;
      }
      default:
        break;
    }
  });
  send({ type: 'ready' });
}

if (typeof acquireVsCodeApi === 'function') start();
