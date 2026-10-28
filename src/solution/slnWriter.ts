import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';

export interface SolutionFs {
  readFile(p: string): Promise<string>;
  writeFile(p: string, s: string): Promise<void>;
  rename(a: string, b: string): Promise<void>;
  unlink(p: string): Promise<void>;
  /** The target of `p` with every symlink resolved. */
  realpath(p: string): Promise<string>;
  /** Permission bits of `p`. */
  mode(p: string): Promise<number>;
  chmod(p: string, mode: number): Promise<void>;
  canWrite(p: string): Promise<boolean>;
}

export interface SolutionWriterDeps extends SolutionFs {
  /** Checks the written solution, e.g. `() => cli.slnList(path)`; rejects when it is invalid. */
  validate(): Promise<void>;
}

const utf8Strict = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/**
 * Real file access for solution files. Text is UTF-8 and the BOM is kept as U+FEFF in the
 * string (`ignoreBOM: true`), so read → write round-trips every byte of a valid UTF-8 file,
 * and non-ASCII folder names are written correctly. A file that is not valid UTF-8 is refused
 * rather than silently re-encoded.
 */
export const nodeSolutionFs: SolutionFs = {
  async readFile(p) {
    const bytes = await fs.readFile(p);
    try {
      return utf8Strict.decode(bytes);
    } catch {
      throw new Error(`Solution file is not valid UTF-8: ${p}`);
    }
  },
  writeFile: (p, s) => fs.writeFile(p, s, 'utf8'),
  rename: (a, b) => fs.rename(a, b),
  unlink: (p) => fs.unlink(p),
  realpath: (p) => fs.realpath(p),
  mode: async (p) => (await fs.stat(p)).mode & 0o7777,
  chmod: (p, mode) => fs.chmod(p, mode),
  canWrite: (p) => fs.access(p, constants.W_OK).then(() => true, () => false),
};

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Best effort: a leftover temp file must never hide the real error. */
const tryUnlink = (deps: SolutionFs, p: string): Promise<void> => deps.unlink(p).catch(() => {});

/** Writes `text` to `<target>.cw-tmp` with `mode`, then renames it over `target`. Never leaves the tmp file. */
async function replaceFile(target: string, text: string, mode: number, deps: SolutionFs): Promise<void> {
  const tmp = `${target}.cw-tmp`;
  try {
    await deps.writeFile(tmp, text);
    await deps.chmod(tmp, mode);
    await deps.rename(tmp, target);
  } catch (e) {
    await tryUnlink(deps, tmp);
    throw e;
  }
}

/**
 * Replaces the solution at `path` with `newText`.
 *
 * - Refuses a read-only file, and a file whose text is no longer `expectedOriginal` (the text
 *   the caller edited), without writing anything.
 * - Writes through the symlink target, keeps the file mode, and keeps `<target>.cw-bak` with
 *   the original until the new text has been read back unchanged and `validate()` passed.
 * - On any failure after the original was replaced it is put back and the error rethrown; if
 *   that restore fails too, the error names both failures and the `.cw-bak` copy is kept.
 */
export async function writeSolutionAtomically(
  path: string,
  newText: string,
  deps: SolutionWriterDeps,
  expectedOriginal: string,
): Promise<void> {
  const target = await deps.realpath(path);
  if (!(await deps.canWrite(target))) throw new Error(`Solution file is read-only: ${path}`);
  const original = await deps.readFile(target);
  if (original !== expectedOriginal) throw new Error('Solution file changed on disk; reload and try again.');
  const mode = await deps.mode(target);
  const bak = `${target}.cw-bak`;
  try {
    await deps.writeFile(bak, original);
  } catch (e) {
    await tryUnlink(deps, bak);
    throw e;
  }
  try {
    await replaceFile(target, newText, mode, deps);
  } catch (e) {
    await tryUnlink(deps, bak); // the original was never replaced
    throw e;
  }
  try {
    if ((await deps.readFile(target)) !== newText) throw new Error(`Solution file did not read back as written: ${path}`);
    await deps.validate();
  } catch (failure) {
    try {
      await replaceFile(target, original, mode, deps);
    } catch (restoreError) {
      throw new Error(
        `Solution edit failed (${message(failure)}) and restoring the original ${path} failed (${message(restoreError)}); ` +
          `the original is kept in ${bak}`,
      );
    }
    await tryUnlink(deps, bak);
    throw failure;
  }
  await tryUnlink(deps, bak);
}
