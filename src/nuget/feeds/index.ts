import type { PackageSource } from '../../core/types';
import type { HttpGet } from '../http';
import { createLocalClient, type LocalFs } from './local';
import type { FeedClient } from './types';
import { createV2Client } from './v2';
import { createV3Client } from './v3';

export function createFeedClient(source: PackageSource, deps: { http: HttpGet; fs: LocalFs }): FeedClient {
  switch (source.kind) {
    case 'v3': return createV3Client(source, deps.http);
    case 'v2': return createV2Client(source, deps.http);
    case 'local': return createLocalClient(source, deps.fs);
  }
}
