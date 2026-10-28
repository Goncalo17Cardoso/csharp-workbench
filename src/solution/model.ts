export interface SolutionFolder { id: string; name: string; parentId?: string } // sln: GUID "{…}" upper-case; slnx: folder path "/src/sub/"
export interface SolutionProject { path: string; name: string; folderId?: string; typeGuid?: string }
export interface SolutionModel { path: string; kind: 'sln' | 'slnx'; folders: SolutionFolder[]; projects: SolutionProject[] }
export interface ProjectInfoData {
  path: string; rootNamespace: string; targetFrameworks: string[]; projectRefs: string[]; // absolute paths
  userSecretsId?: string; fileScopedNamespaces: boolean;
}
export interface ProjectItem { fullPath: string; link?: string }
export interface ProjectItems { items: ProjectItem[]; evaluated: boolean; error?: string } // evaluated=false -> disk walk
