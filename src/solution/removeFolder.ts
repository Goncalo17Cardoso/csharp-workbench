import type { SolutionModel } from './model';
import { planRemoveFolder } from './plans';
import { removeEmptyFolder } from './slnFolders';

export interface RemoveFolderDeps {
  slnRemove(project: string): Promise<void>;
  load(): Promise<SolutionModel>;
  /** Edits the current solution text through the validated writer. */
  edit(change: (text: string, kind: SolutionModel['kind']) => string): Promise<void>;
  onProjectRemoved?(project: string): void;
}

/**
 * Removes a solution folder with everything below it. `dotnet sln remove` itself deletes folders
 * that become empty (including empty ancestors), so each folder is re-checked before its removal.
 */
export async function removeFolderFlow(folderId: string, deps: RemoveFolderDeps): Promise<void> {
  const plan = planRemoveFolder(await deps.load(), folderId);
  for (const p of plan.projectRemovals) { await deps.slnRemove(p); deps.onProjectRemoved?.(p); }
  for (const id of plan.folderIdsBottomUp) {
    if (!(await deps.load()).folders.some((f) => f.id === id)) continue;
    await deps.edit((t, kind) => removeEmptyFolder(t, kind, id));
  }
}
