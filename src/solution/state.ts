/** Minimal Memento surface (workspaceState) so this module needs no `vscode` import. */
export interface Memento {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): PromiseLike<void>;
}

const SELECTED = 'cw.selectedSolution';
const startupKey = (solutionPath: string) => `cw.startup:${solutionPath}`;

export const getSelectedSolution = (ws: Memento): string | undefined => ws.get<string>(SELECTED);
export const setSelectedSolution = (ws: Memento, path: string): PromiseLike<void> => ws.update(SELECTED, path);
export const getStartupProject = (ws: Memento, solutionPath: string): string | undefined =>
  ws.get<string>(startupKey(solutionPath));
export const setStartupProject = (ws: Memento, solutionPath: string, projectPath: string | undefined): PromiseLike<void> =>
  ws.update(startupKey(solutionPath), projectPath);

/** Moves the stored startup project when it is `from` (a project rename). */
export async function moveStartupProject(ws: Memento, solutionPath: string, from: string, to: string): Promise<void> {
  if (getStartupProject(ws, solutionPath) === from) await setStartupProject(ws, solutionPath, to);
}

/** Clears the stored startup project when it is one of the removed projects. */
export async function clearStartupIfRemoved(ws: Memento, solutionPath: string, removed: readonly string[]): Promise<void> {
  const cur = getStartupProject(ws, solutionPath);
  if (cur && removed.includes(cur)) await setStartupProject(ws, solutionPath, undefined);
}
