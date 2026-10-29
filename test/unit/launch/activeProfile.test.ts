import { describe, expect, it } from 'vitest';
import { getActiveProfileName, resolveActiveProfile, setActiveProfileName } from '../../../src/launch/activeProfile';
import type { LaunchProfile } from '../../../src/launch/launchSettings';

const p = (name: string, supported = true): LaunchProfile => ({ name, commandName: supported ? 'Project' : 'IISExpress', supported, environmentVariables: {} });

describe('activeProfile', () => {
  it('resolveActiveProfile falls back to first supported when stored was deleted', () => {
    const list = [p('iis', false), p('a'), p('b')];
    expect(resolveActiveProfile(list, 'gone')?.name).toBe('a');
    expect(resolveActiveProfile(list, 'b')?.name).toBe('b');
    expect(resolveActiveProfile(list, 'iis')?.name).toBe('a');
    expect(resolveActiveProfile([p('iis', false)], undefined)).toBeUndefined();
  });
  it('stores per project', async () => {
    const m = new Map<string, unknown>();
    const ws = { get: <T>(k: string) => m.get(k) as T | undefined, update: async (k: string, v: unknown) => { m.set(k, v); } };
    await setActiveProfileName(ws, '/a.csproj', 'x');
    expect(getActiveProfileName(ws, '/a.csproj')).toBe('x');
    expect(getActiveProfileName(ws, '/b.csproj')).toBeUndefined();
    expect(m.has('cw.launchProfile:/a.csproj')).toBe(true);
  });
});
