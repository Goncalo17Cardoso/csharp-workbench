// Messages between the Project Properties panel host and its webview.
import type { PropertyEdit } from './csprojEdit';
import type { LaunchProfile, ProfileAction } from '../launch/launchSettings';
import type { PropertiesModel } from './model';

export interface LaunchProfilesView { profiles: LaunchProfile[]; active?: string; path: string; exists: boolean; invalid?: string }

export type PropsToHost =
  | { type: 'ready' }
  | { type: 'save'; edits: PropertyEdit[] }
  | { type: 'reload' }
  | { type: 'dirty'; dirty: boolean; edits: PropertyEdit[] }
  | { type: 'openCsproj'; property: string }
  | { type: 'manageSecrets' }
  | { type: 'profiles'; action: ProfileAction }
  | { type: 'setActiveProfile'; name: string };

export type PropsToWebview =
  | { type: 'loading' }
  | { type: 'model'; model: PropertiesModel; labels: Record<string, string> }
  | { type: 'saved' }
  | { type: 'error'; message: string }
  | { type: 'changedOnDisk' }
  | { type: 'profilesModel'; model: LaunchProfilesView };
