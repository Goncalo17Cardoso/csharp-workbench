import type { PackageSource } from '../core/types';
import { FeedError } from './feeds/types';

export type HttpGet = (url: string) => Promise<{ status: number; body: Uint8Array }>;

export function createHttp(source: PackageSource, fetchImpl: typeof fetch = fetch, timeoutMs = 15000): HttpGet {
  const headers: Record<string, string> = { Accept: 'application/json, */*' };
  if (source.credential) {
    const raw = `${source.credential.username}:${source.credential.password}`;
    headers.Authorization = `Basic ${Buffer.from(raw).toString('base64')}`;
  }
  return async (url) => {
    try {
      const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
      return { status: res.status, body: new Uint8Array(await res.arrayBuffer()) };
    } catch (e) {
      throw new FeedError(`${source.name}: request failed (${(e as Error).message})`, source.name);
    }
  };
}
