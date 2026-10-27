import { describe, it, expect } from 'vitest';
import { selectTargets } from '../../../src/workspace/targets';

describe('selectTargets', () => {
  it('returns solutions before standalone projects', () => {
    const t = selectTargets(['/r/a.csproj', '/r/A.sln']);
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ kind: 'sln', path: '/r/A.sln', name: 'A' });
  });
  it('supports slnx', () => {
    expect(selectTargets(['/r/A.slnx'])[0].kind).toBe('slnx');
  });
  it('falls back to csproj targets when no solution', () => {
    const t = selectTargets(['/r/b/b.csproj', '/r/a.csproj']);
    expect(t.map((x) => x.kind)).toEqual(['csproj', 'csproj']);
    expect(t.map((x) => x.path)).toEqual(['/r/a.csproj', '/r/b/b.csproj']);
  });
  it('orders nested solutions after root ones', () => {
    const t = selectTargets(['/r/sub/deep/Z.sln', '/r/sub/B.sln', '/r/Z.sln', '/r/A.slnx']);
    expect(t.map((x) => x.path)).toEqual(['/r/A.slnx', '/r/Z.sln', '/r/sub/B.sln', '/r/sub/deep/Z.sln']);
  });
});
