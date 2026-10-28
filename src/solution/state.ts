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
