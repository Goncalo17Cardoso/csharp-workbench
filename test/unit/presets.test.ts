import { describe, expect, it } from 'vitest';
import { presetPaths, presetString } from '../../src/solution/presets';

describe('presets', () => {
  it('accepts strings only', () => {
    expect(presetString('Customer')).toBe('Customer');
    expect(presetString([{ id: 'n' }])).toBeUndefined();
    expect(presetString(undefined)).toBeUndefined();
  });
  it('accepts string arrays only, so a menu selection of nodes is ignored', () => {
    expect(presetPaths(['/a.csproj'])).toEqual(['/a.csproj']);
    expect(presetPaths([{ id: 'node', kind: 'project' }])).toBeUndefined();
    expect(presetPaths('x')).toBeUndefined();
  });
});
