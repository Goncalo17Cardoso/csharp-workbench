import * as fs from 'node:fs/promises';

export interface SolutionFs {
  readFile(p: string): Promise<string>;
  writeFile(p: string, s: string): Promise<void>;
  rename(a: string, b: string): Promise<void>;
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
};

async function replaceFile(path: string, text: string, deps: SolutionFs): Promise<void> {
  const tmp = `${path}.cw-tmp`;
  await deps.writeFile(tmp, text);
  await deps.rename(tmp, path);
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * Replaces `path` with `newText` through `<path>.cw-tmp` + rename, then runs `validate()`.
 * When validation fails the original text is put back the same way and the validation error
 * is rethrown; if that restore fails too, the error names both failures.
 */
export async function writeSolutionAtomically(path: string, newText: string, deps: SolutionWriterDeps): Promise<void> {
  const original = await deps.readFile(path);
  await replaceFile(path, newText, deps);
  try {
    await deps.validate();
  } catch (validateError) {
    try {
      await replaceFile(path, original, deps);
    } catch (restoreError) {
      throw new Error(
        `Solution validation failed (${message(validateError)}) and restoring the original ${path} failed (${message(restoreError)})`,
      );
    }
    throw validateError;
  }
}
