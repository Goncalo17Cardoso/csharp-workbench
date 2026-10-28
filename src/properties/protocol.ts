// Messages between the Project Properties panel host and its webview.
import type { PropertyEdit } from './csprojEdit';
import type { PropertiesModel } from './model';

export type PropsToHost =
  | { type: 'ready' }
  | { type: 'save'; edits: PropertyEdit[] }
  | { type: 'reload' }
  | { type: 'dirty'; dirty: boolean }
  | { type: 'openCsproj'; property: string }
  | { type: 'manageSecrets' };

export type PropsToWebview =
  | { type: 'loading' }
  | { type: 'model'; model: PropertiesModel; labels: Record<string, string> }
  | { type: 'saved' }
  | { type: 'error'; message: string }
  | { type: 'changedOnDisk' }
  | { type: 'requestSave' }; // Cmd+S: the webview answers with a `save` message
