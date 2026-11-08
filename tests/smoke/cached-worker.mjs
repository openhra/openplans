// Full smoke uses production importers and real Postgres, with cache-only acquisition.
// Run via `worker`'s image with this file on stdin (no test code in production image).
import { createDatabase } from './dist/db/database.js';
import { migrate } from './dist/db/migrate.js';
import { createHash } from 'node:crypto';
import { discoverRelease, filesPage as rxPage } from './dist/ingest/rxnorm/acquire.js';
import { importRxnorm } from './dist/ingest/rxnorm/import.js';
import { discoverQhp } from './dist/ingest/qhp/discover.js';
import { acquireProviders } from './dist/ingest/qhp/provider-acquire.js';
import { importProviders } from './dist/ingest/qhp/provider.js';
import { discoverReleases, filesPage as npiPage, zipLimits as nppesZipLimits } from './dist/ingest/nppes/acquire.js';
import { importNppes } from './dist/ingest/nppes/import.js';
import { ingestGeocode } from './dist/ingest/geocode/index.js';
import { batchCsv } from './dist/ingest/geocode/address.js';
import { acquireBatch } from './dist/ingest/geocode/census.js';
import { parseBatch } from './dist/ingest/geocode/parse.js';
import { addresses, addressCursor, saveSnapshot, snapshotId, saveResult } from './dist/ingest/geocode/repository.js';
import { fetchToCache, FetchError } from './dist/fetch/index.js';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const cache = process.env.OPENPLANS_DATA_DIR;
// Reuse verified publisher snapshots, never silently download a different version.
async function cachedFetch(url, options) {
  const root = join(cache, 'raw', options.source);
  const candidates = [];
  for (const name of (await readdir(root).catch(() => [])).filter(n => n.endsWith('.meta.json'))) {
    const meta = JSON.parse(await readFile(join(root, name), 'utf8'));
    if (meta.url === url) candidates.push(meta);
  }
  const meta = candidates.sort((a,b) => b.fetched_at.localeCompare(a.fetched_at))[0];
  if (!meta) throw new FetchError('cache_error', `Required cached source absent: ${options.source}`);
  return fetchToCache(url, { ...options, dataDir: cache, expectedSha256: meta.sha256,
    lookup: async () => { throw new Error('Full smoke forbids an uncached download'); } });
}
async function cachedPage(url, source) {
  const file = await cachedFetch(url,{source,allowHosts:[new URL(url).hostname],expectedContent:'binary',maxBytes:2*1024**2});
  return readFile(file.path,'utf8');
}
async function cachedArchive(release, source, maxBytes, zipLimits) {
  const file = await cachedFetch(release.url,{source,allowHosts:[new URL(release.url).hostname],expectedContent:'zip',maxBytes,zipLimits});
  return {...release,path:file.path,metadata:file.metadata};
}
// Replay the original complete 10,000-row request batches before deduplicated ingest.
// This keeps the cached Census observations valid across ingestion batching changes.
async function replayGeocode(db) {
  const replay = {selected:0,batches:0,requests:0,exact:0,nonExact:0,centroidFallbacks:0,noPoint:0};
  let after = '';
  for (;;) {
    const page = await addresses(db,{county:'48201',source:'npi_address'},after,10_000);
    if (!page.length) break;
    after = addressCursor(page.at(-1));
    const acquired = await acquireBatch(batchCsv(page),{dataDir:cache,
      lookup:async()=>{throw new Error('Uncached Census request refused');}});
    if (acquired.requests) throw new Error('Census replay must use cached bytes');
    const bytes = await readFile(acquired.file.path);
    if (createHash('sha256').update(bytes).digest('hex') !== acquired.file.metadata.sha256) throw new Error('Census response hash mismatch');
    const parsed = await parseBatch(bytes.toString('utf8'));
    if (parsed.issues.length || parsed.rows.size !== page.length) throw new Error('Incomplete cached Census batch');
    const snapshot = snapshotId(acquired.file);
    await db.transaction(async tx=>{
      await saveSnapshot(tx,acquired.file);
      for (const [index,address] of page.entries()) {
        const row = parsed.rows.get(String(index+1));
        if (!row) throw new Error('Missing Census response row');
        const method = await saveResult(tx,address,row,snapshot);
        replay.selected++;
        if (row.status==='Match') { if (row.quality==='Exact') replay.exact++; else replay.nonExact++; }
        if (method==='zcta_centroid') replay.centroidFallbacks++;
        if (method==='no_point' || method==='issue') replay.noPoint++;
      }
      await tx.query("UPDATE snapshot SET validation_state='ACTIVE',activated_at=COALESCE(activated_at,now()) WHERE snapshot_id=$1",[snapshot]);
    });
    replay.batches++;
  }
  return replay;
}
const db = createDatabase();
try {
  await migrate(db);
  let report;
  switch (process.argv[2]) {
    case 'rxnorm': {
      const release = discoverRelease(await cachedPage(rxPage,'nlm-rxnorm-files'));
      report = await importRxnorm(db, await cachedArchive(release,'nlm-rxnorm-prescribe',1024**3,{maxUncompressedBytes:4*1024**3}));
      break;
    }
    case 'discover': {
      report = await discoverQhp(db, {year:2026,state:'TX',dataDir:cache,fetcher:cachedFetch});
      // Missing caches remain explicit unknown statuses; Cigna must be complete.
      if (report.issuers.find(i=>i.issuer==='76589')?.status !== 'ok') throw new Error('Cigna discovery incomplete');
      break;
    }
    case 'nppes': {
      // The published weekly URL is unavailable; full + deactivation are the cached baseline.
      const releases = discoverReleases(await cachedPage(npiPage,'cms-nppes-page'));
      report = [];
      for (const kind of ['full','deactivation']) {
        const release = releases.find(r=>r.kind===kind);
        if (!release) throw new Error(`Missing ${kind} release`);
        report.push(await importNppes(db, {...await cachedArchive(release,'cms-nppes',2*1024**3,nppesZipLimits),state:'TX',progress:message=>console.error(message)}));
      }
      break;
    }
    case 'providers':
      await acquireProviders(db,{issuer:'76589',year:2026,state:'TX'},{fetcher:cachedFetch});
      report = await importProviders(db,{issuer:'76589',year:2026,state:'TX'});
      if (report.status !== 'ACTIVE') throw new Error(`Provider import ${report.reason}`);
      break;
    case 'geocode': {
      const replay = await replayGeocode(db);
      report = await ingestGeocode(db,{county:'48201',source:'npi_address',dataDir:cache,
        lookup: async()=>{throw new Error('Uncached Census request refused');}});
      if (report.requests !== 0 || report.issues !== 0 || report.selected === 0 || report.reused !== report.selected || replay.noPoint !== 0)
        throw new Error('Cached geocode incomplete');
      report.cache_replay = replay;
      break;
    }
    default: throw new Error('Unknown cached smoke step');
  }
  console.log(JSON.stringify(report));
} finally { await db.close(); }
