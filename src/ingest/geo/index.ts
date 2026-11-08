import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import type { Database, SqlSession } from '../../db/database.js';
import { acquireGeo, centroidStream } from './sources.js';
import type { AcquisitionOptions, GeoFiles, GeoKind } from './sources.js';
import { centroids, GeoError, ratingRows, relationships } from './parse.js';
import { STATE_FIPS, countyKey, CMS_COUNTY_SPELLINGS } from './states.js';
import { insertRows, saveSnapshot, snapshotId } from './repository.js';
export { createGeoRepository, zipToCounties } from './repository.js';
export { acquireGeo } from './sources.js';
export { GeoError } from './parse.js';
export type { GeoFiles, GeoFile } from './sources.js';

export interface GeoImportOptions extends AcquisitionOptions {
  state?: string;
  /** CMS's current undated table is associated with this requested year; it is not a historical version. */
  planYear?: number;
  files?: GeoFiles;
}
export interface GeoImportReport {
  state: string; planYear: number;
  zctaCountyRows: number; zctaCentroidRows: number; ratingAreaRows: number;
  snapshots: Record<GeoKind, string>;
  ratingAreaUnit?: 'county' | 'zip3';
  countyNameCorrections?: { published: string; censusKey: string; sourceRow: number }[];
  ratingAreaBasis: 'current_cms_table';
}
async function verifyFiles(files: GeoFiles): Promise<void> {
  for (const file of Object.values(files)) {
    const hash = createHash('sha256'); let bytes = 0;
    for await (const chunk of createReadStream(file.path)) { hash.update(chunk); bytes += chunk.length; }
    if (hash.digest('hex') !== file.metadata.sha256 || bytes !== file.metadata.bytes) throw new Error('Geography source does not match snapshot metadata');
  }
}
async function writeBatches(tx: SqlSession, table: 'zcta_county' | 'zcta_centroid' | 'rating_area', rows: AsyncIterable<unknown[]>): Promise<number> {
  let batch: unknown[][] = [], count = 0;
  for await (const row of rows) {
    batch.push(row); count++;
    if (batch.length === 250) { await insertRows(tx, table, batch); batch = []; }
  }
  await insertRows(tx, table, batch);
  return count;
}
export async function ingestGeo(db: Database, options: GeoImportOptions = {}): Promise<GeoImportReport> {
  const state = options.state ?? 'TX', planYear = options.planYear ?? 2026;
  const fips = STATE_FIPS[state];
  if (!fips) throw new TypeError('Unknown geography state');
  if (!Number.isInteger(planYear) || planYear < 2014 || planYear > 9999) throw new TypeError('Invalid geography plan year');
  const files = options.files ?? await acquireGeo({ ...options, state });
  await verifyFiles(files);
  const selected = new Set<string>(), counties = new Map<string, string>();
  for await (const row of relationships(createReadStream(files.relationship.path))) {
    if (row.countyFips.startsWith(fips)) {
      const countyName = countyKey(row.countyName);
      if (counties.has(countyName) && counties.get(countyName) !== row.countyFips) throw new GeoError('schema', row.rowNumber, 'ambiguous county name');
      counties.set(countyName, row.countyFips);
      if (row.zcta) selected.add(row.zcta);
    }
  }
  if ((state === 'TX' && counties.size !== 254) || !counties.size || !selected.size) throw new GeoError('incomplete', 1, 'expected complete state counties and nonempty ZCTAs');
  const snapshots = { relationship: snapshotId(files.relationship), centroids: snapshotId(files.centroids), ratingAreas: snapshotId(files.ratingAreas) };
  return db.transaction(async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock(1869636975)');
    for (const kind of Object.keys(files) as GeoKind[]) await saveSnapshot(tx, kind, files[kind], state);
    await tx.query('DELETE FROM rating_area WHERE snapshot_id = $1 AND state = $2 AND plan_year = $3', [snapshots.ratingAreas, state, planYear]);
    await tx.query('DELETE FROM rating_area_zip WHERE snapshot_id = $1 AND state = $2 AND plan_year = $3', [snapshots.ratingAreas, state, planYear]);
    const zctaCountyRows = await writeBatches(tx, 'zcta_county', (async function* () {
      for await (const row of relationships(createReadStream(files.relationship.path))) {
        if (row.zcta && selected.has(row.zcta)) yield [row.zcta, row.countyFips, row.countyName, ...row.areas!, snapshots.relationship, row.rowNumber];
      }
    })());
    const seenCentroids = new Set<string>();
    const zctaCentroidRows = await writeBatches(tx, 'zcta_centroid', (async function* () {
      for await (const row of centroids(centroidStream(files.centroids))) {
        if (selected.has(row.zcta)) {
          seenCentroids.add(row.zcta);
          yield [row.zcta, row.latitude, row.longitude, snapshots.centroids, row.rowNumber];
        }
      }
    })());
    if (seenCentroids.size !== selected.size) throw new GeoError('incomplete', 1, 'selected ZCTA missing from Gazetteer');
    const seenCounties = new Set<string>(), seenPrefixes = new Set<string>();
    const countyNameCorrections: NonNullable<GeoImportReport['countyNameCorrections']> = [];
    const ratingAreaRows = await writeBatches(tx, 'rating_area', (async function* () {
      for await (const row of ratingRows(createReadStream(files.ratingAreas.path))) {
        if (row.zipPrefix) {
          if (row.countyName || seenPrefixes.has(row.zipPrefix)) throw new GeoError('schema', row.rowNumber, 'mixed or duplicate CMS ZIP3 geography');
          seenPrefixes.add(row.zipPrefix);
          await tx.query(`INSERT INTO rating_area_zip(state,zip_prefix,rating_area_id,plan_year,snapshot_id,source_row) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
            [state,row.zipPrefix,row.ratingAreaId,planYear,snapshots.ratingAreas,row.rowNumber]);
          continue;
        }
        const key = countyKey(row.countyName), corrected = CMS_COUNTY_SPELLINGS[state]?.[key];
        const county = counties.get(corrected ?? key);
        if (corrected) countyNameCorrections.push({ published: row.countyName, censusKey: corrected, sourceRow: row.rowNumber });
        if (!county || seenCounties.has(county)) throw new GeoError('schema', row.rowNumber, 'unknown or duplicate CMS county');
        seenCounties.add(county);
        yield [state, county, row.ratingAreaId, planYear, snapshots.ratingAreas, row.rowNumber];
      }
    })());
    if (seenPrefixes.size && seenCounties.size) throw new GeoError('schema', 1, 'mixed CMS geographic units');
    if (seenPrefixes.size && [...selected].some(zip => !seenPrefixes.has(zip.slice(0, 3)))) throw new GeoError('incomplete', 1, 'CMS ZIP3 table omits a selected ZCTA prefix');
    if (!seenPrefixes.size && seenCounties.size !== counties.size) throw new GeoError('incomplete', 1, `CMS table covers ${seenCounties.size} of ${counties.size} ${state} counties`);
    for (const snapshot of Object.values(snapshots)) await tx.query("UPDATE snapshot SET validation_state = 'ACTIVE', activated_at = now() WHERE snapshot_id = $1", [snapshot]);
    await tx.query(`INSERT INTO geo_import (state, plan_year, relationship_snapshot_id, centroid_snapshot_id, rating_snapshot_id)
      VALUES ($1,$2,$3,$4,$5) ON CONFLICT (state, plan_year) DO UPDATE SET
      relationship_snapshot_id=EXCLUDED.relationship_snapshot_id, centroid_snapshot_id=EXCLUDED.centroid_snapshot_id,
      rating_snapshot_id=EXCLUDED.rating_snapshot_id, imported_at=now()`,
    [state, planYear, snapshots.relationship, snapshots.centroids, snapshots.ratingAreas]);
    return { state, planYear, zctaCountyRows, zctaCentroidRows, ratingAreaRows: ratingAreaRows + seenPrefixes.size, snapshots, countyNameCorrections, ratingAreaUnit: seenPrefixes.size ? 'zip3' : 'county', ratingAreaBasis: 'current_cms_table' };
  });
}
