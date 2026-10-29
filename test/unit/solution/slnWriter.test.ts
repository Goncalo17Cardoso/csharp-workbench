import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { nodeSolutionFs, writeSolutionAtomically, type SolutionWriterDeps } from '../../../src/solution/slnWriter';

interface FakeOpts {
  validate?: () => Promise<void>;
  /** Fails the n-th writeFile (1-based) or the writes to a given path. */
  failWrite?: (p: string, n: number) => boolean;
  failRename?: (a: string, n: number) => boolean;
  /** Transforms what writeFile stores, to simulate a disk that does not read back as written. */
  corrupt?: (p: string, s: string) => string;
  writable?: boolean;
  links?: Record<string, string>;
}

/** In-memory fs that records every call. */
function fakeDeps(initial: Record<string, string>, opts: FakeOpts = {}) {
  const files = new Map(Object.entries(initial));
  const modes = new Map<string, number>();
  const calls: string[] = [];
  let writes = 0;
  let renames = 0;
  const deps: SolutionWriterDeps = {
    readFile: async (p) => {
      calls.push(`read ${p}`);
      const v = files.get(p);
      if (v === undefined) throw new Error(`ENOENT ${p}`);
      return v;
    },
    writeFile: async (p, s) => {
      calls.push(`write ${p}`);
      if (opts.failWrite?.(p, ++writes)) throw new Error('disk full');
      files.set(p, opts.corrupt ? opts.corrupt(p, s) : s);
    },
    rename: async (a, b) => {
      calls.push(`rename ${a} -> ${b}`);
      if (opts.failRename?.(a, ++renames)) throw new Error('EXDEV');
      const v = files.get(a);
      if (v === undefined) throw new Error(`ENOENT ${a}`);
      files.set(b, v);
      files.delete(a);
      if (modes.has(a)) modes.set(b, modes.get(a)!);
    },
    unlink: async (p) => {
      calls.push(`unlink ${p}`);
      if (!files.delete(p)) throw new Error(`ENOENT ${p}`);
    },
    realpath: async (p) => opts.links?.[p] ?? p,
    mode: async () => 0o640,
    chmod: async (p, m) => {
      calls.push(`chmod ${p} ${m.toString(8)}`);
      modes.set(p, m);
    },
    canWrite: async () => opts.writable ?? true,
    validate: async () => {
      calls.push('validate');
      await opts.validate?.();
    },
  };
  return { deps, files, calls, modes };
}

const P = '/w/My App #1/App.sln';
const TMP = `${P}.cw-tmp`;
const BAK = `${P}.cw-bak`;

describe('writeSolutionAtomically (fake deps)', () => {
  it('backs up, writes the tmp file with the original mode, renames, reads back, validates, drops the backup', async () => {
    const { deps, files, calls, modes } = fakeDeps({ [P]: 'old' });
    await writeSolutionAtomically(P, 'new', deps, 'old');
    expect(calls).toEqual([
      `read ${P}`, `write ${BAK}`, `write ${TMP}`, `chmod ${TMP} 640`, `rename ${TMP} -> ${P}`,
      `read ${P}`, 'validate', `unlink ${BAK}`,
    ]);
    expect([...files]).toEqual([[P, 'new']]);
    expect(modes.get(P)).toBe(0o640);
  });

  it('writer restores original when validation fails', async () => {
    const boom = new Error('dotnet sln list failed');
    const { deps, files } = fakeDeps({ [P]: '﻿old\r\n' }, { validate: async () => { throw boom; } });
    await expect(writeSolutionAtomically(P, 'new', deps, '﻿old\r\n')).rejects.toBe(boom);
    expect([...files]).toEqual([[P, '﻿old\r\n']]);
  });

  it('restores the original when the file does not read back as written', async () => {
    const { deps, files, calls } = fakeDeps({ [P]: 'old' }, { corrupt: (p, s) => (p === TMP && s === 'new' ? 'nev' : s) });
    await expect(writeSolutionAtomically(P, 'new', deps, 'old')).rejects.toThrow('did not read back as written');
    expect([...files]).toEqual([[P, 'old']]);
    expect(calls).not.toContain('validate');
  });

  it('reports both errors and keeps the backup when the restore fails too', async () => {
    const { deps, files } = fakeDeps({ [P]: 'old' }, {
      validate: async () => { throw new Error('invalid solution'); },
      failWrite: (p, n) => p === TMP && n === 3,
    });
    await expect(writeSolutionAtomically(P, 'new', deps, 'old'))
      .rejects.toThrow(/invalid solution[\s\S]*disk full[\s\S]*App\.sln\.cw-bak/);
    expect(files.get(BAK)).toBe('old');
    expect(files.has(TMP)).toBe(false);
  });

  it('leaves the original untouched and no temp files when the tmp write fails', async () => {
    const { deps, files, calls } = fakeDeps({ [P]: 'old' }, { failWrite: (p) => p === TMP });
    await expect(writeSolutionAtomically(P, 'new', deps, 'old')).rejects.toThrow('disk full');
    expect([...files]).toEqual([[P, 'old']]);
    expect(calls).not.toContain('validate');
  });

  it('unlinks the tmp file when the rename fails', async () => {
    const { deps, files, calls } = fakeDeps({ [P]: 'old' }, { failRename: () => true });
    await expect(writeSolutionAtomically(P, 'new', deps, 'old')).rejects.toThrow('EXDEV');
    expect(calls).toContain(`unlink ${TMP}`);
    expect([...files]).toEqual([[P, 'old']]);
  });

  it('refuses a read-only file without writing', async () => {
    const { deps, calls } = fakeDeps({ [P]: 'old' }, { writable: false });
    await expect(writeSolutionAtomically(P, 'new', deps, 'old')).rejects.toThrow(`File is read-only: ${P}`);
    expect(calls.filter((c) => !c.startsWith('read'))).toEqual([]);
  });

  it('refuses when the file changed on disk since the caller read it', async () => {
    const { deps, files, calls } = fakeDeps({ [P]: 'changed' });
    await expect(writeSolutionAtomically(P, 'new', deps, 'old')).rejects.toThrow('File changed on disk; reload and try again.');
    expect(calls).toEqual([`read ${P}`]);
    expect([...files]).toEqual([[P, 'changed']]);
  });

  it('writes through the symlink target', async () => {
    const real = '/w/real/App.sln';
    const { deps, files } = fakeDeps({ [real]: 'old' }, { links: { [P]: real } });
    await writeSolutionAtomically(P, 'new', deps, 'old');
    expect([...files]).toEqual([[real, 'new']]);
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
    if (root) {
      await fs.chmod(dir, 0o755).catch(() => {});
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
  const deps = (validate: () => Promise<void> = async () => {}): SolutionWriterDeps => ({ ...nodeSolutionFs, validate });
  const leftovers = async () => (await fs.readdir(dir)).filter((f) => /\.cw-(tmp|bak)$/.test(f));

  it('writer works on a path containing "My App #1" and keeps the BOM bytes and the mode', async () => {
    const p = path.join(dir, 'App.sln');
    await fs.writeFile(p, Buffer.concat([BOM, Buffer.from('\r\nold\r\n')]));
    await fs.chmod(p, 0o640);
    const text = await nodeSolutionFs.readFile(p);
    expect(text.startsWith('﻿')).toBe(true);
    await writeSolutionAtomically(p, text.replace('old', 'new Café'), deps(), text);
    expect(await fs.readFile(p)).toEqual(Buffer.concat([BOM, Buffer.from('\r\nnew Café\r\n', 'utf8')]));
    expect((await fs.stat(p)).mode & 0o7777).toBe(0o640);
    expect(await leftovers()).toEqual([]);
  });

  it('restores the exact original bytes when validation fails, leaving no temp files', async () => {
    const p = path.join(dir, 'Restore.sln');
    const original = Buffer.concat([BOM, Buffer.from('\r\nMicrosoft Visual Studio Solution File — ü\r\n', 'utf8')]);
    await fs.writeFile(p, original);
    const text = await nodeSolutionFs.readFile(p);
    let backupDuringValidate: Buffer | undefined;
    await expect(
      writeSolutionAtomically(p, 'broken', deps(async () => {
        backupDuringValidate = await fs.readFile(`${p}.cw-bak`);
        throw new Error('nope');
      }), text),
    ).rejects.toThrow('nope');
    expect(backupDuringValidate).toEqual(original);
    expect(await fs.readFile(p)).toEqual(original);
    expect(await leftovers()).toEqual([]);
  });

  it('keeps a symlinked solution a symlink', async () => {
    const real = path.join(dir, 'Real.sln');
    const link = path.join(dir, 'Link.sln');
    await fs.writeFile(real, 'old');
    await fs.symlink(real, link);
    await writeSolutionAtomically(link, 'new', deps(), 'old');
    expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
    expect(await fs.readFile(real, 'utf8')).toBe('new');
    expect(await leftovers()).toEqual([]);
  });

  it('refuses a read-only file and leaves it untouched', async () => {
    const p = path.join(dir, 'ReadOnly.sln');
    await fs.writeFile(p, 'old');
    await fs.chmod(p, 0o444);
    await expect(writeSolutionAtomically(p, 'new', deps(), 'old')).rejects.toThrow(`File is read-only: ${p}`);
    expect(await fs.readFile(p, 'utf8')).toBe('old');
    expect(await leftovers()).toEqual([]);
  });

  it('refuses when the file changed on disk, writing nothing', async () => {
    const p = path.join(dir, 'Changed.sln');
    await fs.writeFile(p, 'changed by someone else');
    await expect(writeSolutionAtomically(p, 'new', deps(), 'old')).rejects.toThrow('File changed on disk; reload and try again.');
    expect(await fs.readFile(p, 'utf8')).toBe('changed by someone else');
    expect(await leftovers()).toEqual([]);
  });

  it('leaves no temp files and the original intact when the directory is not writable', async () => {
    const sub = path.join(dir, 'locked dir #2');
    await fs.mkdir(sub);
    const p = path.join(sub, 'App.sln');
    await fs.writeFile(p, 'old');
    await fs.chmod(sub, 0o555);
    try {
      await expect(writeSolutionAtomically(p, 'new', deps(), 'old')).rejects.toThrow(/EACCES|permission/i);
      expect(await fs.readFile(p, 'utf8')).toBe('old');
      expect(await fs.readdir(sub)).toEqual(['App.sln']);
    } finally {
      await fs.chmod(sub, 0o755);
    }
  });

  it('refuses to read a file that is not valid UTF-8', async () => {
    const p = path.join(dir, 'Latin1.sln');
    await fs.writeFile(p, Buffer.from([0x61, 0xe9, 0x0d, 0x0a]));
    await expect(nodeSolutionFs.readFile(p)).rejects.toThrow(/not valid UTF-8/);
  });
});
