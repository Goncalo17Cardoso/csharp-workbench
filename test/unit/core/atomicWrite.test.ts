import { describe, expect, it } from 'vitest';
import { ChangedOnDiskError, ReadOnlyFileError, writeTextAtomically, type TextWriterDeps } from '../../../src/core/atomicWrite';

function deps(files: Map<string, string>, writable = true): TextWriterDeps {
  return {
    readFile: async (p) => files.get(p) ?? '',
    writeFile: async (p, s) => void files.set(p, s),
    rename: async (a, b) => {
      files.set(b, files.get(a) ?? '');
      files.delete(a);
    },
    unlink: async (p) => void files.delete(p),
    realpath: async (p) => p,
    mode: async () => 0o644,
    chmod: async () => {},
    canWrite: async () => writable,
    validate: async () => {},
  };
}

describe('writeTextAtomically', () => {
  it('throws ChangedOnDiskError and writes nothing when the file text differs from expectedOriginal', async () => {
    const files = new Map([['/a.json', 'disk']]);
    await expect(writeTextAtomically('/a.json', 'new', deps(files), 'stale')).rejects.toBeInstanceOf(ChangedOnDiskError);
    expect([...files.entries()]).toEqual([['/a.json', 'disk']]);
  });

  it('throws ReadOnlyFileError for a non-writable file', async () => {
    const files = new Map([['/a.json', 'old']]);
    await expect(writeTextAtomically('/a.json', 'new', deps(files, false), 'old')).rejects.toBeInstanceOf(ReadOnlyFileError);
    expect(files.get('/a.json')).toBe('old');
  });
});
