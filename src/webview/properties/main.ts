import '../styles.css';
import './properties.css';
import type { LaunchProfilesView, PropsToHost, PropsToWebview } from '../../properties/protocol';
import { renderProperties } from './views/form';

declare function acquireVsCodeApi(): { postMessage(m: PropsToHost): void };
const vscode = acquireVsCodeApi();
const send = (m: PropsToHost): void => vscode.postMessage(m);

const app = document.getElementById('app')!;
const banner = document.createElement('div');
const form = document.createElement('div');
app.append(banner, form);
let labels: Record<string, string> = {};
let api: ReturnType<typeof renderProperties> | undefined;
let profiles: LaunchProfilesView | undefined;
const L = (k: string): string => labels[k] ?? k;

window.addEventListener('message', (e: MessageEvent<PropsToWebview>) => {
  const m = e.data;
  switch (m.type) {
    case 'loading':
      banner.textContent = '';
      break;
    case 'model':
      labels = m.labels;
      banner.textContent = '';
      api = renderProperties(form, m.model, labels, send);
      if (profiles) api.setProfiles(profiles);
      break;
    case 'profilesModel':
      profiles = m.model;
      api?.setProfiles(m.model);
      break;
    case 'saved':
      banner.textContent = '';
      break;
    case 'error': {
      banner.className = 'banner banner-vulnerable';
      banner.textContent = m.message;
      break;
    }
    case 'changedOnDisk': {
      banner.className = 'banner banner-deprecated';
      banner.textContent = L('The project changed on disk.') + ' ';
      const b = document.createElement('button');
      b.textContent = L('Reload');
      b.addEventListener('click', () => send({ type: 'reload' }));
      banner.append(b);
      break;
    }
  }
});
send({ type: 'ready' });
