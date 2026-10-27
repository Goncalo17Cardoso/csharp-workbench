import type { PackageDetails, ProjectInfo, SearchResult, Target } from '../core/types';
import type { OperationRequest } from '../ops/operations';
import type { ConsolidateRow, InstalledRow, UpdateRow } from '../state/viewModel';

// Webview -> host
export type ToHost =
  | { type: 'ready' }
  | { type: 'search'; query: string; prerelease: boolean; source: string; skip: number; seq: number }
  | { type: 'selectPackage'; id: string; prerelease: boolean; source: string; version?: string }
  | { type: 'selectVersion'; id: string; version: string }
  | { type: 'run'; request: OperationRequest }
  | { type: 'switchTarget'; path: string }
  | { type: 'refresh' }
  | { type: 'openOutput' };

// Host -> webview
export type ToWebview =
  | { type: 'init'; targets: Target[]; current: Target; projects: ProjectInfo[]; sources: { name: string; warning?: string }[]; preselectProject?: string }
  | { type: 'searchResults'; seq: number; results: SearchResult[]; failures: { source: string; message: string }[]; append: boolean }
  | { type: 'installed'; rows: InstalledRow[]; confirmed: boolean }
  | { type: 'updates'; rows: UpdateRow[] }
  | { type: 'consolidate'; rows: ConsolidateRow[]; cpm: boolean }
  | { type: 'details'; details: PackageDetails; versions: string[]; perProject: Record<string, string | null>; overrides: string[] }
  | { type: 'busy'; label: string | null; progress?: { done: number; total: number } }
  | { type: 'opResult'; ok: boolean; message: string; cancelled?: boolean }
  | { type: 'error'; message: string; canOpenOutput: boolean };
