import {
  nodeTextFs,
  writeTextAtomically,
  type TextFs,
  type TextWriterDeps,
} from '../core/atomicWrite';

export { ChangedOnDiskError, ReadOnlyFileError } from '../core/atomicWrite';

export type SolutionFs = TextFs;
export type SolutionWriterDeps = TextWriterDeps;
export const nodeSolutionFs: SolutionFs = nodeTextFs;

/** Replaces the solution at `path` with `newText`; see {@link writeTextAtomically}. */
export const writeSolutionAtomically = writeTextAtomically;
