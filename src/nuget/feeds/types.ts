import type { PackageDetails, SearchResult } from '../../core/types';

export interface FeedClient {
  search(q: string, o: { prerelease: boolean; skip: number; take: number }): Promise<SearchResult[]>;
  versions(id: string, prerelease: boolean): Promise<string[]>;
  details(id: string, version: string): Promise<PackageDetails>;
}

export class FeedError extends Error {
  constructor(message: string, public source: string, public status?: number) {
    super(message);
    this.name = 'FeedError';
  }
}
