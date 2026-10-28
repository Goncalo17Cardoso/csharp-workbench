// Messages between the Project Properties panel host and its webview.
import type { PropertyEdit } from './csprojEdit';
import type { PropertiesModel } from './model';

export type PropsToHost =
  | { type: 'ready' }
  | { type: 'save'; edits: PropertyEdit[] }
  | { type: 'reload' }
  | { type: 'dirty'; dirty: boolean; edits: PropertyEdit[] }
  | { type: 'openCsproj'; property: string }
  | { type: 'manageSecrets' };

export type PropsToWebview =
  | { type: 'loading' }
  | { type: 'model'; model: PropertiesModel; labels: Record<string, string> }
  | { type: 'saved' }
  | { type: 'error'; message: string }
  | { type: 'changedOnDisk' };
