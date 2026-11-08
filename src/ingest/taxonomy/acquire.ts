import { homedir } from 'node:os';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fetchToCache } from '../../fetch/index.js';
import type { FetchOptions, SnapshotMetadata } from '../../fetch/index.js';

export const filesPage = 'https://www.nucc.org/index.php/code-sets-mainmenu-41/provider-taxonomy-mainmenu-40/csv-mainmenu-57';
export const sourceId = 'nucc-provider-taxonomy';
export const dataDirectory = () => process.env.OPENPLANS_DATA_DIR ?? join(homedir(), '.local', 'share', 'openplans');
export interface Release { version: string; url: string }
export interface AcquiredRelease extends Release { path: string; metadata: SnapshotMetadata }
type FetchDependencies = Pick<FetchOptions, 'lookup' | 'transport' | 'sleep'>;

export function discoverRelease(html: string): Release {
  const candidates: Release[] = [];
  for (const m of html.matchAll(/<a\b[^>]*href=["']([^"']*nucc_taxonomy_(\d+)\.csv)["'][^>]*>\s*Version\s+(\d+\.\d+)/gi)) {
    const url = new URL(m[1]!.replace(/&amp;/g, '&'), filesPage);
    if (url.protocol !== 'https:' || url.hostname !== 'www.nucc.org' || url.username || url.password || url.search || url.hash) continue;
    const digits = m[2]!;
    candidates.push({ version: `${digits.slice(0, -1)}.${digits.slice(-1)}`, url: url.href });
  }
  const release = candidates[0];
  if (!release) throw new Error('Current NUCC taxonomy CSV link/version unavailable');
  return release;
}

async function expectedHash(directory: string, source: string, url: string): Promise<string | undefined> {
  const root = join(directory, 'raw', source);
  for (const name of await readdir(root).catch(() => [])) {
    if (!name.endsWith('.meta.json')) continue;
    const meta = JSON.parse(await readFile(join(root, name), 'utf8')) as SnapshotMetadata;
    if (meta.url === url) return meta.sha256;
  }
  return undefined;
}

export async function acquireRelease(dataDir = dataDirectory(), dependencies: FetchDependencies = {}): Promise<AcquiredRelease> {
  const page = await fetchToCache(filesPage, { ...dependencies, source: `${sourceId}-page`, dataDir,
    allowHosts: ['www.nucc.org'], expectedContent: 'binary', maxBytes: 2 * 1024 ** 2 });
  if (page.outcome === 'not_modified') throw new Error('NUCC page body required');
  const release = discoverRelease(await readFile(page.path, 'utf8'));
  const result = await fetchToCache(release.url, { ...dependencies, source: sourceId, dataDir,
    allowHosts: ['www.nucc.org'], expectedContent: 'csv', maxBytes: 10 * 1024 ** 2,
    expectedSha256: await expectedHash(dataDir, sourceId, release.url) });
  if (result.outcome === 'not_modified') throw new Error('NUCC CSV body required');
  return { ...release, path: result.path, metadata: result.metadata };
}
