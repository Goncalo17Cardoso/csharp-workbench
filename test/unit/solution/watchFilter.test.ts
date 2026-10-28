import { describe, expect, it } from 'vitest';
import { shouldInvalidate } from '../../../src/solution/watchFilter';

describe('shouldInvalidate', () => {
  it('ignores content changes of ordinary files', () => {
    for (const f of ['/w/P/A.cs', '/w/P/appsettings.json', '/w/P/X.razor']) expect(shouldInvalidate(f, 'change', false)).toBe(false);
  });
  it('reacts to project/props/targets/sln changes', () => {
    for (const f of ['/w/P/P.csproj', '/w/Directory.Build.props', '/w/x.targets', '/w/A.sln', '/w/A.slnx']) expect(shouldInvalidate(f, 'change', false)).toBe(true);
  });
  it('reacts to create and delete of any file', () => {
    expect(shouldInvalidate('/w/P/A.cs', 'create', false)).toBe(true);
    expect(shouldInvalidate('/w/P/Sub', 'delete', false)).toBe(true);
  });
  it('ignores .git and node_modules always, bin/obj unless show all', () => {
    expect(shouldInvalidate('/w/.git/x', 'create', true)).toBe(false);
    expect(shouldInvalidate('/w/node_modules', 'delete', true)).toBe(false);
    expect(shouldInvalidate('/w/P/bin', 'create', false)).toBe(false);
    expect(shouldInvalidate('/w/P/obj/a.cs', 'create', false)).toBe(false);
    expect(shouldInvalidate('/w/P/bin/a.dll', 'create', true)).toBe(true);
  });
});
