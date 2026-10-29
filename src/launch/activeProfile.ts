import type { Memento } from '../solution/state';
import { parseProfiles, type LaunchProfile } from './launchSettings';

const key = (projectPath: string) => `cw.launchProfile:${projectPath}`;

export const getActiveProfileName = (ws: Memento, projectPath: string): string | undefined =>
  ws.get<string>(key(projectPath));

export const setActiveProfileName = (ws: Memento, projectPath: string, name: string | undefined): PromiseLike<void> =>
  ws.update(key(projectPath), name);

/** The stored profile when it still exists and is supported, else the first supported one. */
export function resolveActiveProfile(profiles: LaunchProfile[], stored: string | undefined): LaunchProfile | undefined {
  const supported = profiles.filter((p) => p.supported);
  return supported.find((p) => p.name === stored) ?? supported[0];
}

/** Name of the profile Run/Debug will use for this launchSettings.json text, or undefined when none is supported. */
export function resolvedProfileName(text: string | undefined, stored: string | undefined): string | undefined {
  return resolveActiveProfile(parseProfiles(text), stored)?.name;
}
