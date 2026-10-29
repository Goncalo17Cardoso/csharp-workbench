import { describe, expect, it } from 'vitest';
import { applyProfileAction, launchSettingsPath, parseProfiles, ProfileError } from '../../../src/launch/launchSettings';

const sample = `{
  // top comment
  "profiles": {
    "A": { "commandName": "Project", "applicationUrl": "http://localhost:5000", "environmentVariables": { "X": "1" }, },
    "B": { "commandName": "Executable", "executablePath": "/bin/x", "commandLineArgs": "-v" },
    "IIS": { "commandName": "IISExpress", "launchBrowser": true },
  }, // trailing
}
`;

describe('launchSettings', () => {
  it('path', () => expect(launchSettingsPath('/a/b/p.csproj')).toBe('/a/b/Properties/launchSettings.json'));
  it('parses Project, Executable and IISExpress with supported flags', () => {
    const p = parseProfiles(sample);
    expect(p.map((x) => [x.name, x.commandName, x.supported])).toEqual([['A', 'Project', true], ['B', 'Executable', true], ['IIS', 'IISExpress', false]]);
    expect(p[0].environmentVariables).toEqual({ X: '1' });
    expect(p[1].executablePath).toBe('/bin/x');
    expect(p[2].launchBrowser).toBe(true);
  });
  it('tolerates comments and trailing commas', () => expect(parseProfiles(sample)).toHaveLength(3));
  it('undefined, {} and {"profiles":5} give []', () => {
    expect(parseProfiles(undefined)).toEqual([]);
    expect(parseProfiles('{}')).toEqual([]);
    expect(parseProfiles('{"profiles":5}')).toEqual([]);
    expect(parseProfiles('garbage{')).toEqual([]);
  });
  it('new on undefined creates file text with profile', () => {
    const t = applyProfileAction(undefined, { kind: 'new', name: 'Dev', commandName: 'Project' });
    expect(parseProfiles(t)).toMatchObject([{ name: 'Dev', commandName: 'Project' }]);
  });
  it('set keeps comments elsewhere byte-identical', () => {
    const t = applyProfileAction(sample, { kind: 'set', name: 'B', field: 'commandLineArgs', value: '-x' });
    expect(t).toBe(sample.replace('"-v"', '"-x"'));
    const u = applyProfileAction(sample, { kind: 'set', name: 'B', field: 'commandLineArgs', value: undefined });
    expect(parseProfiles(u)[1].commandLineArgs).toBeUndefined();
    expect(u).toContain('// top comment');
    expect(u).toContain('// trailing');
  });
  it('env replaces environmentVariables', () => {
    const t = applyProfileAction(sample, { kind: 'env', name: 'A', env: { Y: '2' } });
    expect(parseProfiles(t)[0].environmentVariables).toEqual({ Y: '2' });
  });
  it('rename keeps order and rejects existing name', () => {
    const t = applyProfileAction(sample, { kind: 'rename', from: 'A', name: 'Z' });
    expect(parseProfiles(t).map((p) => p.name)).toEqual(['Z', 'B', 'IIS']);
    expect(t).toBe(sample.replace('"A":', '"Z":'));
    expect(() => applyProfileAction(sample, { kind: 'rename', from: 'A', name: 'B' })).toThrow(ProfileError);
    expect(() => applyProfileAction(sample, { kind: 'rename', from: 'Q', name: 'R' })).toThrow(/missing|Q/);
    expect(() => applyProfileAction(sample, { kind: 'new', name: ' ', commandName: 'Project' })).toThrow(ProfileError);
  });
  it('delete removes only that profile', () => {
    const t = applyProfileAction(sample, { kind: 'delete', name: 'B' });
    expect(parseProfiles(t).map((p) => p.name)).toEqual(['A', 'IIS']);
    expect(t).toContain('// top comment');
  });
  it('duplicate copies the profile', () => {
    const t = applyProfileAction(sample, { kind: 'duplicate', from: 'B', name: 'B2' });
    expect(parseProfiles(t)[3]).toMatchObject({ name: 'B2', executablePath: '/bin/x' });
  });
  it('profile names with spaces and non-ASCII round-trip', () => {
    let t = applyProfileAction(undefined, { kind: 'new', name: 'Olá Mundo ✓', commandName: 'Executable' });
    t = applyProfileAction(t, { kind: 'set', name: 'Olá Mundo ✓', field: 'launchBrowser', value: true });
    t = applyProfileAction(t, { kind: 'rename', from: 'Olá Mundo ✓', name: 'ção x' });
    expect(parseProfiles(t)).toMatchObject([{ name: 'ção x', launchBrowser: true }]);
  });
  it('detects tabs and CRLF', () => {
    const t = applyProfileAction('{\r\n\t"profiles": {}\r\n}\r\n', { kind: 'new', name: 'N', commandName: 'Project' });
    expect(t).toContain('\r\n\t\t"N"');
    expect(t.replace(/\r\n/g, '')).not.toContain('\n');
  });
});
