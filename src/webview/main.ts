import './styles.css';
import type { ProjectInfo } from '../core/types';
import type { ToHost, ToWebview } from '../panel/protocol';
import { renderSearchList } from './views/browse';
import { renderDetails } from './views/details';
import { renderInstalled } from './views/installed';
import { renderUpdates, UpdateSequence } from './views/updates';
import { renderConsolidate } from './views/consolidate';
import { applyBusy, setActionsDisabled, setTabCount, showError, showResult } from './chrome';
import type { ConsolidateRow, InstalledRow, UpdateRow } from '../state/viewModel';

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
    b.dataset.label = names[k];
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
  let tab: keyof ShellRefs['tabs'] = 'browse';
  let installed: InstalledRow[] = [];
  let installedConfirmed = true;
  let updates: UpdateRow[] = [];
  let consolidate: ConsolidateRow[] = [];
  let cpm = false;
  let busy = false;
  const seq = new UpdateSequence(send);
  const openOutput = () => send({ type: 'openOutput' });
  const renderTab = () => {
    if (tab === 'installed') renderInstalled(ui.list, installed, ui.search.value, select, installedConfirmed);
    else if (tab === 'updates') renderUpdates(ui.list, updates, ui.search.value, seq);
    else if (tab === 'consolidate') renderConsolidate(ui.list, consolidate, cpm, send);
    if (busy) setActionsDisabled(root, true);
  };

  const persist = () => vscode.setState({ query: ui.search.value, prerelease: ui.prerelease.checked, source: ui.source.value });
  let appending = false;
  const doSearch = (append: boolean) => {
    appending = append;
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
    if (tab === 'installed' || tab === 'updates') { renderTab(); return; }
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
      tab = k as typeof tab;
      if (tab === 'browse') doSearch(false);
      else renderTab();
    });
  }
  ui.tabs.browse.classList.add('on');
  root.dataset.tab = 'browse';

  window.addEventListener('message', (e: MessageEvent<ToWebview>) => {
    const m = e.data;
    switch (m.type) {
      case 'init':
        seq.cancel();
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
      case 'installed':
        installed = m.rows;
        installedConfirmed = m.confirmed;
        if (tab === 'installed') renderTab();
        break;
      case 'updates':
        updates = m.rows;
        setTabCount(ui.tabs.updates, m.rows.length);
        if (tab === 'updates') renderTab();
        break;
      case 'consolidate':
        consolidate = m.rows;
        cpm = m.cpm;
        setTabCount(ui.tabs.consolidate, m.rows.length);
        if (tab === 'consolidate') renderTab();
        break;
      case 'busy':
        busy = m.label !== null;
        applyBusy(root, ui.status, m.label, m.progress);
        break;
      case 'opResult':
        showResult(root, ui.status, m.ok, m.message, openOutput);
        if (!m.ok) busy = false;
        seq.onResult(m.ok);
        break;
      case 'error': {
        seq.cancel();
        busy = false;
        if (loading) {
          loading = false;
          if (appending) skip = Math.max(0, skip - PAGE);
        }
        showError(root, ui.status, m.message, m.canOpenOutput, openOutput);
        break;
      }
      default:
        break;
    }
  });
  send({ type: 'ready' });
}

if (typeof acquireVsCodeApi === 'function') start();
