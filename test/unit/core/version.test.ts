import { describe, expect, it } from 'vitest';
import { compareVersions, isPrerelease, maxVersion } from '../../../src/core/version';

describe('compareVersions', () => {
  it('orders four-part versions', () => expect(compareVersions('1.0.0.1', '1.0.0')).toBeGreaterThan(0));
  it('compares numeric prerelease identifiers numerically', () =>
    expect(compareVersions('2.0.0-beta.10', '2.0.0-beta.9')).toBeGreaterThan(0));
  it('ranks prerelease below release', () => expect(compareVersions('2.0.0-beta', '2.0.0')).toBeLessThan(0));
  it('ignores build metadata', () => expect(compareVersions('1.0.0+abc', '1.0.0')).toBe(0));
  it('compares numerically not lexically', () => expect(compareVersions('10.0.0', '9.0.0')).toBeGreaterThan(0));
  it('ignores prerelease case', () => expect(compareVersions('1.0.0-Beta', '1.0.0-beta')).toBe(0));
});

describe('isPrerelease / maxVersion', () => {
  it('detects prerelease', () => {
    expect(isPrerelease('1.0.0-rc.1')).toBe(true);
    expect(isPrerelease('1.0.0+meta-x')).toBe(false);
  });
  it('picks max', () => {
    expect(maxVersion(['1.0.0', '2.0.0-beta', '1.5.0'])).toBe('2.0.0-beta');
    expect(maxVersion([])).toBeUndefined();
  });
});
