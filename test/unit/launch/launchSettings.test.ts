import { describe, expect, it } from 'vitest';
import { applyProfileAction, isValidLaunchSettings, launchSettingsPath, parseProfiles, ProfileError } from '../../../src/launch/launchSettings';

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
  it('accepts a UTF-8 BOM, as written by dotnet new, and keeps it on edit', () => {
    const bom = '\uFEFF{\r\n  "profiles": {\r\n    "http": { "commandName": "Project" }\r\n  }\r\n}\r\n';
    expect(parseProfiles(bom).map((p) => p.name)).toEqual(['http']);
    const out = applyProfileAction(bom, { kind: 'set', name: 'http', field: 'commandLineArgs', value: '-v' });
    expect(out.startsWith('\uFEFF{\r\n')).toBe(true);
    expect(out.indexOf('\uFEFF', 1)).toBe(-1);
    expect(parseProfiles(out)[0].commandLineArgs).toBe('-v');
  });
  it('isValidLaunchSettings accepts BOM, comments and no file, rejects malformed or non-object text', () => {
    expect(isValidLaunchSettings('\uFEFF{"profiles":{}}')).toBe(true);
    expect(isValidLaunchSettings(sample)).toBe(true);
    expect(isValidLaunchSettings(undefined)).toBe(true);
    expect(isValidLaunchSettings('garbage{')).toBe(false);
    expect(isValidLaunchSettings('[]')).toBe(false);
  });
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
  const code = (fn: () => unknown) => { try { fn(); } catch (e) { return (e as ProfileError).code; } return 'none'; };
  const N = { kind: 'new', name: 'N', commandName: 'Project' } as const;
  it('error codes', () => {
    expect(code(() => applyProfileAction(sample, { kind: 'new', name: 'A', commandName: 'Project' }))).toBe('exists');
    expect(code(() => applyProfileAction(sample, { kind: 'delete', name: 'Q' }))).toBe('missing');
    expect(code(() => applyProfileAction(sample, { kind: 'new', name: '  ', commandName: 'Project' }))).toBe('emptyName');
  });
  it('rejects malformed, comment-only, null and array roots with invalid', () => {
    for (const t of ['garbage{', '// only comment', 'null', '[1]', '{"profiles":{"a":1}', '5']) expect(code(() => applyProfileAction(t, N)), t).toBe('invalid');
    expect(parseProfiles('[1]')).toEqual([]);
    expect(parseProfiles('null')).toEqual([]);
  });
  it('whitespace-only text is treated as empty', () => expect(parseProfiles(applyProfileAction('  \n', N))).toHaveLength(1));
  it('non-object profile entries still count as existing keys', () => {
    const t = '{"profiles":{"X":5,"Y":{"commandName":"Project"}}}';
    expect(code(() => applyProfileAction(t, { kind: 'new', name: 'X', commandName: 'Project' }))).toBe('exists');
    expect(code(() => applyProfileAction(t, { kind: 'rename', from: 'Y', name: 'X' }))).toBe('exists');
    expect(code(() => applyProfileAction(t, { kind: 'duplicate', from: 'Y', name: 'X' }))).toBe('exists');
  });
  it('action on text with no profiles key', () => {
    expect(parseProfiles(applyProfileAction('{"a":1}', N))).toMatchObject([{ name: 'N' }]);
  });
  it('rename escapes quotes, backslash and accents', () => {
    const t = applyProfileAction(sample, { kind: 'rename', from: 'A', name: 'q"\\é' });
    expect(parseProfiles(t)[0].name).toBe('q"\\é');
  });
  it('rename ignores same text in values and comments', () => {
    const t = '{ // "A" here\n"profiles":{"B":{"commandName":"Project","launchUrl":"A"},"A":{"commandName":"Project"}}}';
    const r = applyProfileAction(t, { kind: 'rename', from: 'A', name: 'Z' });
    expect(r).toBe(t.replace('"A":{', '"Z":{'));
  });
  it('environmentVariables stringifies numbers/booleans and skips others', () => {
    const p = parseProfiles('{"profiles":{"A":{"commandName":"Project","environmentVariables":{"a":1,"b":true,"c":null,"d":{},"e":"s"}}}}');
    expect(p[0].environmentVariables).toEqual({ a: '1', b: 'true', e: 's' });
  });
});
