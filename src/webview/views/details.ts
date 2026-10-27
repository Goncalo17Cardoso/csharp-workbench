import DOMPurify from 'dompurify';
import { marked } from 'marked';
import type { PackageDetails, ProjectInfo } from '../../core/types';
import type { ToHost } from '../../panel/protocol';
import { setOwnDisabled } from '../chrome';

export type Action = 'Install' | 'Update' | 'Uninstall';

export function actionFor(selected: string[], perProject: Record<string, string | null>, version: string): Action {
  if (selected.length === 0) return 'Install';
  const installed = selected.map((p) => perProject[p] ?? null);
  if (installed.every((v) => v !== null && v === version)) return 'Uninstall';
  if (installed.some((v) => v !== null && v !== version)) return 'Update';
  return 'Install';
}

function div(cls: string, text?: string): HTMLElement {
  const d = document.createElement('div');
  d.className = cls;
  if (text !== undefined) d.textContent = text;
  return d;
}

function isHttp(href: string): boolean {
  try {
    const p = new URL(href).protocol;
    return p === 'http:' || p === 'https:';
  } catch {
    return false;
  }
}

function link(href: string, text: string): HTMLElement {
  if (!isHttp(href)) {
    const s = document.createElement('span');
    s.textContent = text;
    return s;
  }
  const a = document.createElement('a');
  a.href = href;
  a.textContent = text;
  return a;
}

export interface DetailsOptions {
  /** Project ticked when a package is shown for the first time. */
  preselect?: string;
  /** Projects whose version comes from a VersionOverride. */
  overrides?: string[];
}

/** Ticked projects and chosen version of the details panel currently shown in `el`, if it shows `id`. */
function previousState(el: HTMLElement, id: string): { selected: Set<string>; version: string } | undefined {
  if (el.dataset.pkg?.toLowerCase() !== id.toLowerCase()) return undefined;
  const selected = new Set(
    [...el.querySelectorAll<HTMLInputElement>('.projects input[type=checkbox]')].filter((b) => b.checked).map((b) => b.dataset.path ?? ''),
  );
  return { selected, version: el.querySelector<HTMLSelectElement>('.actions select')?.value ?? '' };
}

export function renderDetails(
  el: HTMLElement,
  d: PackageDetails,
  versions: string[],
  perProject: Record<string, string | null>,
  projects: ProjectInfo[],
  send: (m: ToHost) => void,
  opts: DetailsOptions = {},
): void {
  const prev = previousState(el, d.id);
  el.replaceChildren();
  el.dataset.pkg = d.id;
  el.append(div('title', d.id), div('muted', d.description));

  if (d.deprecation) {
    const parts = ['Deprecated: ' + d.deprecation.reasons.join(', ')];
    if (d.deprecation.message) parts.push(d.deprecation.message);
    if (d.deprecation.alternate) parts.push(`Use ${d.deprecation.alternate} instead`);
    el.append(div('banner banner-deprecated', parts.join('. ')));
  }
  if (d.vulnerabilities?.length) {
    const b = div('banner banner-vulnerable', 'Known vulnerabilities: ');
    d.vulnerabilities.forEach((v, i) => {
      if (i) b.append(', ');
      b.append(link(v.advisoryUrl, v.severity));
    });
    el.append(b);
  }

  const overrides = new Set(opts.overrides ?? []);
  const list = div('projects');
  const boxes: { box: HTMLInputElement; path: string }[] = [];
  for (const p of projects) {
    const label = document.createElement('label');
    label.className = 'chk';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.dataset.path = p.path;
    box.checked = prev ? prev.selected.has(p.path) : p.path === opts.preselect;
    const inst = perProject[p.path] ?? null;
    const note = document.createElement('span');
    note.className = 'muted';
    note.textContent = inst ? `— ${inst}${overrides.has(p.path) ? ' (override)' : ''}` : '— not installed';
    label.append(box, p.name, ' ', note);
    list.append(label);
    boxes.push({ box, path: p.path });
  }
  el.append(list);

  const installedSet = new Set(Object.values(perProject).filter((v): v is string => !!v));
  const bar = div('actions');
  const select = document.createElement('select');
  versions.forEach((v, i) => {
    const o = document.createElement('option');
    o.value = v;
    o.textContent = v + (i === 0 ? ' (latest)' : '') + (installedSet.has(v) ? ' (installed)' : '');
    select.append(o);
  });
  if (prev && versions.includes(prev.version)) select.value = prev.version;
  else if (versions.includes(d.version)) select.value = d.version;
  const btn = document.createElement('button');
  btn.className = 'primary';
  const selected = () => boxes.filter((b) => b.box.checked).map((b) => b.path);
  const currentVersion = () => select.value || d.version;
  const sync = () => {
    const sel = selected();
    btn.textContent = actionFor(sel, perProject, currentVersion());
    setOwnDisabled(btn, sel.length === 0);
  };
  boxes.forEach((b) => b.box.addEventListener('change', sync));
  select.addEventListener('change', () => {
    send({ type: 'selectVersion', id: d.id, version: select.value });
    sync();
  });
  btn.addEventListener('click', () => {
    const sel = selected();
    const action = actionFor(sel, perProject, currentVersion());
    const kind = action === 'Install' ? 'install' : action === 'Update' ? 'update' : 'uninstall';
    send({
      type: 'run',
      request: { kind, packageId: d.id, ...(kind === 'uninstall' ? {} : { version: currentVersion() }), projects: sel },
    });
  });
  sync();
  const vlabel = document.createElement('span');
  vlabel.textContent = 'Version ';
  bar.append(vlabel, select, btn);
  el.append(bar);

  const info = div('muted info');
  if (d.authors) info.append(`Authors: ${d.authors} `);
  if (d.license) info.append(d.licenseUrl ? link(d.licenseUrl, d.license) : `License: ${d.license}`, ' ');
  if (d.projectUrl) info.append(link(d.projectUrl, 'Project'));
  el.append(info);

  if (d.dependencies.length) {
    const sec = div('deps');
    sec.append(div('section-title', 'Dependencies'));
    for (const g of d.dependencies) {
      sec.append(div('dep-fw', g.framework));
      if (!g.packages.length) sec.append(div('muted dep', 'No dependencies'));
      for (const p of g.packages) sec.append(div('dep', `${p.id} (${p.range})`));
    }
    el.append(sec);
  }

  if (d.readme && d.readme.trim()) {
    const readme = div('readme');
    readme.innerHTML = DOMPurify.sanitize(marked.parse(d.readme, { async: false }) as string);
    el.append(div('section-title', 'README'), readme);
  }
}
