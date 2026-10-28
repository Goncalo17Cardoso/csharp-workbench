import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { nodeSolutionFs, writeSolutionAtomically, type SolutionWriterDeps } from '../../../src/solution/slnWriter';

/** In-memory fs that records every call. */
function fakeDeps(initial: Record<string, string>, opts: { validate?: () => Promise<void>; failWrite?: (p: string, n: number) => boolean } = {}) {
  const files = new Map(Object.entries(initial));
  const calls: string[] = [];
  let writes = 0;
  const deps: SolutionWriterDeps = {
    readFile: async (p) => {
      calls.push(`read ${p}`);
      const v = files.get(p);
      if (v === undefined) throw new Error(`ENOENT ${p}`);
      return v;
    },
    writeFile: async (p, s) => {
      calls.push(`write ${p}`);
      writes++;
      if (opts.failWrite?.(p, writes)) throw new Error('disk full');
      files.set(p, s);
    },
    rename: async (a, b) => {
      calls.push(`rename ${a} -> ${b}`);
      const v = files.get(a);
      if (v === undefined) throw new Error(`ENOENT ${a}`);
      files.set(b, v);
      files.delete(a);
    },
    validate: async () => {
      calls.push('validate');
      await opts.validate?.();
    },
  };
  return { deps, files, calls };
}

const P = '/w/My App #1/App.sln';

describe('writeSolutionAtomically (fake deps)', () => {
  it('writes the tmp file, renames it over the original, then validates', async () => {
    const { deps, files, calls } = fakeDeps({ [P]: 'old' });
    await writeSolutionAtomically(P, 'new', deps);
    expect(calls).toEqual([`read ${P}`, `write ${P}.cw-tmp`, `rename ${P}.cw-tmp -> ${P}`, 'validate']);
    expect([...files]).toEqual([[P, 'new']]);
  });

  it('writer restores original when validation fails', async () => {
    const boom = new Error('dotnet sln list failed');
    const { deps, files } = fakeDeps({ [P]: '﻿old\r\n' }, { validate: async () => { throw boom; } });
    await expect(writeSolutionAtomically(P, 'new', deps)).rejects.toBe(boom);
    expect([...files]).toEqual([[P, '﻿old\r\n']]);
  });

  it('reports both errors when the restore fails too', async () => {
    const { deps } = fakeDeps({ [P]: 'old' }, {
      validate: async () => { throw new Error('invalid solution'); },
      failWrite: (_p, n) => n === 2,
    });
    await expect(writeSolutionAtomically(P, 'new', deps)).rejects.toThrow(/invalid solution[\s\S]*disk full/);
  });

  it('leaves the original untouched when the tmp write fails', async () => {
    const { deps, files, calls } = fakeDeps({ [P]: 'old' }, { failWrite: () => true });
    await expect(writeSolutionAtomically(P, 'new', deps)).rejects.toThrow('disk full');
    expect(files.get(P)).toBe('old');
    expect(calls).not.toContain('validate');
  });
});

describe('writeSolutionAtomically (real files)', () => {
  let root: string;
  let dir: string;
  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'cw-writer-'));
    dir = path.join(root, 'My App #1');
    await fs.mkdir(dir);
  });
  afterAll(async () => {
    if (root) await fs.rm(root, { recursive: true, force: true });
  });

  const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
  const deps = (validate: () => Promise<void>): SolutionWriterDeps => ({ ...nodeSolutionFs, validate });

  it('writer works on a path containing "My App #1" and keeps the BOM bytes', async () => {
    const p = path.join(dir, 'App.sln');
    await fs.writeFile(p, Buffer.concat([BOM, Buffer.from('\r\nold\r\n')]));
    const text = await nodeSolutionFs.readFile(p);
    expect(text.startsWith('﻿')).toBe(true);
    await writeSolutionAtomically(p, text.replace('old', 'new Café'), deps(async () => {}));
    expect(await fs.readFile(p)).toEqual(Buffer.concat([BOM, Buffer.from('\r\nnew Café\r\n', 'utf8')]));
    expect(await fs.readdir(dir)).toEqual(['App.sln']);
  });

  it('restores the exact original bytes when validation fails', async () => {
    const p = path.join(dir, 'Restore.sln');
    const original = Buffer.concat([BOM, Buffer.from('\r\nMicrosoft Visual Studio Solution File — ü\r\n', 'utf8')]);
    await fs.writeFile(p, original);
    await expect(
      writeSolutionAtomically(p, 'broken', deps(async () => { throw new Error('nope'); })),
    ).rejects.toThrow('nope');
    expect(await fs.readFile(p)).toEqual(original);
    expect((await fs.readdir(dir)).filter((f) => f.endsWith('.cw-tmp'))).toEqual([]);
  });

  it('refuses to read a file that is not valid UTF-8', async () => {
    const p = path.join(dir, 'Latin1.sln');
    await fs.writeFile(p, Buffer.from([0x61, 0xe9, 0x0d, 0x0a]));
    await expect(nodeSolutionFs.readFile(p)).rejects.toThrow(/not valid UTF-8/);
  });
});
