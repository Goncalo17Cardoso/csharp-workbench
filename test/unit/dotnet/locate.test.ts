import { describe, it, expect } from 'vitest';
import { findDotnet } from '../../../src/dotnet/locate';

const mk = (existing: string[]) => async (p: string) => existing.includes(p);

describe('findDotnet', () => {
  it('prefers configured path when it exists', async () => {
    expect(await findDotnet({ configuredPath: '/x/dotnet', pathEnv: '/a', home: '/h', exists: mk(['/x/dotnet', '/a/dotnet']) })).toBe('/x/dotnet');
  });
  it('falls back to PATH entries in order', async () => {
    expect(await findDotnet({ pathEnv: '/a:/b', home: '/h', exists: mk(['/b/dotnet']) })).toBe('/b/dotnet');
  });
  it('checks well-known locations after PATH', async () => {
    expect(await findDotnet({ pathEnv: '/a', home: '/h', exists: mk(['/usr/local/share/dotnet/dotnet']) })).toBe('/usr/local/share/dotnet/dotnet');
    expect(await findDotnet({ pathEnv: '/a', home: '/h', exists: mk(['/h/.dotnet/dotnet', '/usr/local/share/dotnet/dotnet']) })).toBe('/usr/local/share/dotnet/dotnet');
    expect(await findDotnet({ pathEnv: '/a', home: '/h', exists: mk(['/h/.dotnet/dotnet']) })).toBe('/h/.dotnet/dotnet');
  });
  it('ignores configured path that does not exist', async () => {
    expect(await findDotnet({ configuredPath: '/nope', pathEnv: '/a', home: '/h', exists: mk(['/a/dotnet']) })).toBe('/a/dotnet');
  });
  it('returns undefined when nothing found', async () => {
    expect(await findDotnet({ pathEnv: '/a', home: '/h', exists: mk([]) })).toBeUndefined();
  });
});
