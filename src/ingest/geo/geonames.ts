import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import type { Database } from '../../db/database.js';
import { fetchToCache, streamZipMember } from '../../fetch/index.js';
import type { AcquisitionOptions, GeoFile } from './sources.js';
import { cachedHash, dataDirectory } from './sources.js';
import { STATE_FIPS } from './states.js';
import { geonamesAttribution, saveFallbackSnapshot } from './fallback-snapshot.js';

export const GEONAMES_SOURCE = 'geonames-us-postal';
export const GEONAMES_URL = 'https://download.geonames.org/export/zip/US.zip';
const limits = { maxMembers: 5, maxArchiveBytes: 10 * 1024 ** 2, maxUncompressedBytes: 20 * 1024 ** 2, maxExpansionRatio: 200 };
export async function acquireGeoNames(options: AcquisitionOptions = {}): Promise<GeoFile> {
  const dataDir = options.dataDir ?? dataDirectory();
  const result = await fetchToCache(GEONAMES_URL, {
    ...options.fetchOptions, source: GEONAMES_SOURCE, allowHosts: ['download.geonames.org'],
    expectedContent: 'zip', dataDir, maxBytes: limits.maxArchiveBytes, zipLimits: limits,
    expectedSha256: options.refresh ? undefined : await cachedHash(dataDir, GEONAMES_SOURCE, GEONAMES_URL),
  });
  if (result.outcome === 'not_modified') throw new Error('GeoNames source has no cached body');
  return { path: result.path, metadata: result.metadata, zipped: true };
}
async function* lines(input: AsyncIterable<Uint8Array | string>) {
  const decoder = new StringDecoder('utf8'); let pending = '', row = 0;
  for await (const chunk of input) {
    pending += typeof chunk === 'string' ? chunk : decoder.write(Buffer.from(chunk));
    let end: number;
    while ((end = pending.indexOf('\n')) >= 0) {
      if (end > 16_384) throw new Error('GeoNames row exceeds size limit');
      yield { line: pending.slice(0,end).replace(/\r$/, ''), row: ++row };
      pending = pending.slice(end+1);
    }
    if (pending.length > 16_384) throw new Error('GeoNames row exceeds size limit');
  }
  pending += decoder.end();
  if (pending) yield { line: pending.replace(/\r$/, ''), row: ++row };
}
export interface PostalCounty { zip: string; county_fips: string; county_name: string; state: string; source_row: number }
/** Read published admin codes; never resolve county/city names or nearby postal codes. */
export async function* geoNamesRows(input: AsyncIterable<Uint8Array | string>): AsyncGenerator<PostalCounty | null> {
  for await (const { line, row } of lines(input)) {
    if (!line) continue;
    const fields = line.split('\t');
    if (fields.length !== 12 || fields[0] !== 'US' || !/^\d{5}$/.test(fields[1]!)) throw new Error(`Invalid GeoNames schema at row ${row}`);
    const state = fields[4]!, county = fields[6]!, name = fields[5]!;
    // Missing/unsupported published administrative identity is absent evidence, not a guessed county.
    if (!STATE_FIPS[state] || !county || !name) { yield null; continue; }
    if (!/^\d{3}$/.test(county)) throw new Error(`Invalid GeoNames county code at row ${row}`);
    yield { zip: fields[1]!, county_fips: STATE_FIPS[state]! + county, county_name: name, state, source_row: row };
  }
}
export const geoNamesStream = (file: GeoFile) => file.zipped
  ? streamZipMember(file.path, 'US.txt', limits) : createReadStream(file.path);
export async function ingestGeoNames(db: Database, options: AcquisitionOptions & { file?: GeoFile } = {}) {
  const file = options.file ?? await acquireGeoNames(options), m = file.metadata;
  if (m.source !== GEONAMES_SOURCE || m.url !== GEONAMES_URL) throw new Error('Unexpected GeoNames source');
  const hash = createHash('sha256'); let bytes = 0;
  for await (const chunk of createReadStream(file.path)) { hash.update(chunk); bytes += chunk.length; }
  if (hash.digest('hex') !== m.sha256 || bytes !== m.bytes) throw new Error('GeoNames snapshot hash mismatch');
  return db.transaction(async tx => {
    await tx.query('SELECT pg_advisory_xact_lock(1869636976)');
    const snapshot = await saveFallbackSnapshot(tx,file,'GeoNames',GEONAMES_URL,geonamesAttribution.license_url);
    let rows = 0, skipped = 0, batch: PostalCounty[] = [];
    const flush = async () => {
      if (!batch.length) return;
      const params: unknown[] = [];
      const values = batch.map(row => `(${['geonames',row.zip,row.county_fips,row.county_name,row.state,snapshot,row.source_row].map(v => { params.push(v); return `$${params.length}`; }).join(',')})`);
      await tx.query(`INSERT INTO zip_county_fallback(source,zip,county_fips,county_name,state,snapshot_id,source_row)
        VALUES ${values.join(',')} ON CONFLICT DO NOTHING`,params);
      batch = [];
    };
    for await (const row of geoNamesRows(geoNamesStream(file))) {
      if (!row) { skipped++; continue; }
      batch.push(row); rows++;
      if (batch.length === 250) await flush();
    }
    await flush();
    if (!rows) throw new Error('GeoNames contains no county evidence');
    await tx.query(`INSERT INTO geonames_import(singleton,snapshot_id) VALUES(true,$1)
      ON CONFLICT(singleton) DO UPDATE SET snapshot_id=EXCLUDED.snapshot_id,imported_at=now()`,[snapshot]);
    return { source: 'geonames', snapshot_id: snapshot, rows, skipped, attribution: geonamesAttribution };
  });
}
