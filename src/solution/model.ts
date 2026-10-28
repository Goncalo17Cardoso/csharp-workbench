export interface SolutionFolder { id: string; name: string; parentId?: string } // sln: GUID "{…}" upper-case; slnx: folder path "/src/sub/"
export interface SolutionProject { path: string; name: string; folderId?: string; typeGuid?: string }
export interface SolutionModel { path: string; kind: 'sln' | 'slnx'; folders: SolutionFolder[]; projects: SolutionProject[] }
