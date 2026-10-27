export type TargetKind = 'sln' | 'slnx' | 'csproj';
export interface Target { kind: TargetKind; path: string; name: string }
export interface ProjectInfo { path: string; name: string }
export interface PackageRef {
  id: string; requested?: string; resolved?: string; latest?: string;
  framework?: string; versionOverride?: string;
}
export interface ProjectPackages { project: ProjectInfo; packages: PackageRef[] }
export interface CpmInfo { propsPath: string; versions: Map<string, string> } // key = lower-case id
export interface SolutionState { target: Target; projects: ProjectPackages[]; cpm?: CpmInfo }
export type SourceKind = 'v3' | 'v2' | 'local';
export interface PackageSource {
  name: string; url: string; kind: SourceKind;
  credential?: { username: string; password: string }; warning?: string;
}
export interface SearchResult {
  id: string; description: string; latestVersion: string;
  totalDownloads?: number; iconUrl?: string; sources: string[];
}
export interface PackageDetails {
  id: string; version: string; description: string; authors?: string;
  license?: string; licenseUrl?: string; projectUrl?: string; readme?: string;
  dependencies: { framework: string; packages: { id: string; range: string }[] }[];
  deprecation?: { reasons: string[]; message?: string; alternate?: string };
  vulnerabilities?: { severity: string; advisoryUrl: string }[];
}
