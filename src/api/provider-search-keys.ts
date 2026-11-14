import type { Database, SqlSession } from "../db/database.js";
import {
  PROVIDER_SEARCH_BUILD_LOCK,
  refuseDuringMigration,
} from "../db/maintenance-locks.js";

/**
 * Search keys for NPPES identity radius searches (migration 1007).
 *
 * A slot table holds one row per distinct located practice point of each identity, with the
 * identity's scope, type, search name and taxonomy codes, in grid-cell order. Practice addresses
 * without a current point are rows with a null cell, one per address. A radius search reads the
 * cells around its origin from one compact run of the table instead of probing identities and
 * points spread across every loaded state.
 *
 * The keys are derived data. A slot is used only while the revisions of its source tables, read in
 * the same snapshot as the rows, equal the current ones; otherwise searches take the original path.
 * `worker backfill provider-search` rebuilds them after an import or a geocode run.
 */

/** Tables whose rows the keys are derived from. Any write to one of them retires the keys. */
export const SEARCH_KEY_SOURCES = [
  "address_point",
  "npi_address",
  "npi_provider",
  "npi_taxonomy",
] as const;

export type SearchKeySlot = "a" | "b";

/** Revisions of the source tables, in one string; read in the caller's snapshot. */
export const sourceRevisionsSql = `(SELECT string_agg(table_name||':'||revision::text,',' ORDER BY table_name)
  FROM api_data_generation WHERE table_name IN (${SEARCH_KEY_SOURCES.map((t) => `'${t}'`).join(",")}))`;

export const searchKeyTable = (slot: SearchKeySlot) =>
  `provider_search_key_${slot}`;

/**
 * True in the same snapshot as the search when the slot still matches its sources.
 *
 * TRUNCATE is not MVCC-safe. A snapshot taken before a build switched slots still names the old
 * slot, and once the build empties it, that snapshot reads it as empty. A built slot that looks
 * empty was emptied after the snapshot, so it is not current.
 */
export const searchKeysCurrentSql = (slot: SearchKeySlot) =>
  `coalesce((SELECT b.slot='${slot}' AND b.source_revisions=${sourceRevisionsSql}
    AND (b.located_rows+b.unlocated_rows=0 OR EXISTS (SELECT 1 FROM ${searchKeyTable(slot)})) FROM provider_search_build b),false)`;

/** The slot that matches the current source tables, if any. */
export async function currentSearchKeys(
  db: SqlSession,
): Promise<SearchKeySlot | undefined> {
  const { rows } = await db.query<{ slot: SearchKeySlot | null }>(
    `SELECT CASE WHEN to_regclass('provider_search_build') IS NOT NULL THEN
      (SELECT b.slot FROM provider_search_build b WHERE b.source_revisions=${sourceRevisionsSql}) END AS slot`,
  );
  return rows[0]?.slot ?? undefined;
}

/** Cells are 0.1 degree; a row of cells spans every longitude cell index 0..3600. */
const CELLS_PER_DEGREE = 10;
const CELL_ROW = 360 * CELLS_PER_DEGREE + 1;
/** The cell of a stored point. The TypeScript bounds below use the same float steps. */
export const cellSql = (latitude: string, longitude: string) =>
  `floor((${latitude}+90)*${CELLS_PER_DEGREE})::integer*${CELL_ROW}+floor((${longitude}+180)*${CELLS_PER_DEGREE})::integer`;
const latitudeBand = (latitude: number) =>
  Math.floor((latitude + 90) * CELLS_PER_DEGREE);
const longitudeIndex = (longitude: number) =>
  Math.floor((longitude + 180) * CELLS_PER_DEGREE);

/** PostGIS's sphere for ST_DWithin(geography, geography, distance, false): (2a+b)/3 of WGS84. */
const SPHERE_METERS = 6371008.771415059;
const METERS_PER_MILE = 1609.344;
/** Widens the cap by much more than float rounding and PostGIS's distance tolerance. */
const MARGIN = 1.001;
const MARGIN_DEGREES = 1e-6;

/**
 * Integer cell ranges that cover every point within `radiusMiles` of the origin on PostGIS's
 * sphere. A covering is lossless: ST_DWithin still decides each row. The latitude span is the
 * cap's angular radius; the longitude half-width is asin(sin(d)/cos(latitude)), widened to every
 * longitude when the cap reaches a pole, and split in two where it crosses the antimeridian.
 */
export function cellRanges(
  latitude: number,
  longitude: number,
  radiusMiles: number,
): [number, number][] {
  const angle = ((radiusMiles * METERS_PER_MILE) / SPHERE_METERS) * MARGIN;
  const degrees = (angle * 180) / Math.PI + MARGIN_DEGREES;
  const south = Math.max(-90, latitude - degrees),
    north = Math.min(90, latitude + degrees);
  const polar = north >= 90 || south <= -90 || angle >= Math.PI / 2;
  const spans: [number, number][] = [];
  if (polar) {
    spans.push([-180, 180]);
  } else {
    const cosine = Math.cos((latitude * Math.PI) / 180);
    const ratio = Math.sin(angle) / cosine;
    const half =
      ratio >= 1 ? 180 : (Math.asin(ratio) * 180) / Math.PI + MARGIN_DEGREES;
    const west = longitude - half,
      east = longitude + half;
    if (half >= 180 || east - west >= 360) spans.push([-180, 180]);
    else if (west < -180) spans.push([west + 360, 180], [-180, east]);
    else if (east > 180) spans.push([west, 180], [-180, east - 360]);
    else spans.push([west, east]);
  }
  const lonRanges = spans.map(
    ([west, east]) =>
      [
        Math.max(0, longitudeIndex(west)),
        Math.min(CELL_ROW - 1, longitudeIndex(east)),
      ] as const,
  );
  const ranges: [number, number][] = [];
  for (let band = latitudeBand(south); band <= latitudeBand(north); band++)
    for (const [first, last] of lonRanges) {
      const range: [number, number] = [
        band * CELL_ROW + first,
        band * CELL_ROW + last,
      ];
      const previous = ranges.at(-1);
      // Whole rows of adjacent bands join into one range.
      if (previous && previous[1] + 1 === range[0]) previous[1] = range[1];
      else ranges.push(range);
    }
  return ranges;
}

/** SQL condition on `alias.cell` for the ranges; every bound is a computed integer. */
export function cellCondition(alias: string, ranges: [number, number][]) {
  for (const bound of ranges.flat())
    if (!Number.isSafeInteger(bound)) throw new Error("Invalid search cell");
  return `(${ranges.map(([first, last]) => `${alias}.cell BETWEEN ${first} AND ${last}`).join(" OR ")})`;
}

const BUILD_LOCK = PROVIDER_SEARCH_BUILD_LOCK;

export interface SearchKeyBuild {
  slot: SearchKeySlot;
  located_rows: number;
  unlocated_rows: number;
  source_revisions: string;
  /** The slot it replaced was emptied; false when a running search kept it busy. */
  previous_cleared: boolean;
  elapsed_ms: number;
}

/**
 * Fills the idle slot from the current source tables and makes it current.
 *
 * The rows and the revisions they match are read in one REPEATABLE READ snapshot. Readers keep
 * using the current slot until the final update; an import that commits during the build leaves
 * the new slot stale, and searches take the original path until the next build.
 */
export async function buildProviderSearchKeys(
  db: Database,
): Promise<SearchKeyBuild> {
  const started = Date.now();
  const run = async (session: SqlSession) => {
    await session.query(`SELECT pg_advisory_lock(${BUILD_LOCK})`);
    try {
      await refuseDuringMigration(session);
      return await fill(session);
    } finally {
      await session.query(`SELECT pg_advisory_unlock(${BUILD_LOCK})`);
    }
  };
  const result = db.withSession ? await db.withSession(run) : await run(db);
  return { ...result, elapsed_ms: Date.now() - started };
}

async function fill(
  session: SqlSession,
): Promise<Omit<SearchKeyBuild, "elapsed_ms">> {
  const current = (
    await session.query<{ slot: SearchKeySlot }>(
      "SELECT slot FROM provider_search_build",
    )
  ).rows[0]?.slot;
  const slot: SearchKeySlot = current === "a" ? "b" : "a";
  const previous = current ? searchKeyTable(current) : undefined;
  const table = searchKeyTable(slot);
  // The idle slot has no readers: searches only read the slot provider_search_build names.
  await session.exec("SET lock_timeout = '10s'");
  await session.exec(`TRUNCATE ${table}`);
  await session.exec("BEGIN ISOLATION LEVEL REPEATABLE READ");
  let counts: {
    located_rows: string;
    unlocated_rows: string;
    source_revisions: string | null;
  };
  try {
    // Sorts and hashes spill to disk past this; it stays small for a 1.5 GB database container.
    await session.exec("SET LOCAL work_mem = '64MB'");
    // One row per distinct located point of an identity, and one per practice address without
    // a current point. A point locates an address only through the address's full source key
    // and snapshot, as in a radius search.
    counts = (
      await session.query<
        typeof counts
      >(`WITH revisions AS MATERIALIZED (SELECT ${sourceRevisionsSql} AS source_revisions),
      codes AS MATERIALIZED (SELECT npi,array_agg(DISTINCT code ORDER BY code) AS taxonomy_codes FROM npi_taxonomy GROUP BY npi),
      addresses AS (
        SELECT DISTINCT a.npi,p.latitude,p.longitude,CASE WHEN p.source_row IS NULL THEN a.ordinal END AS unlocated_ordinal
        FROM npi_address a LEFT JOIN address_point p ON p.source_table='npi_address'
          AND p.source_row=a.npi||':'||a.kind||':'||a.ordinal::text AND p.source_snapshot_id=a.snapshot_id
        WHERE a.kind='practice'
      ), inserted AS (
        INSERT INTO ${table}(cell,npi,latitude,longitude,in_scope,entity_type,search_name,taxonomy_codes)
        SELECT ${cellSql("k.latitude", "k.longitude")},k.npi,k.latitude,k.longitude,n.in_scope,n.entity_type,
          concat_ws(' ',n.organization_name,n.first_name,n.last_name),coalesce(t.taxonomy_codes,'{}')
        FROM addresses k JOIN npi_provider n ON n.npi=k.npi LEFT JOIN codes t ON t.npi=k.npi
        ORDER BY 1 NULLS LAST,k.npi
        RETURNING cell
      )
      SELECT count(*) FILTER (WHERE cell IS NOT NULL)::text AS located_rows,
        count(*) FILTER (WHERE cell IS NULL)::text AS unlocated_rows,
        (SELECT source_revisions FROM revisions) AS source_revisions FROM inserted`)
    ).rows[0]!;
    await session.exec("COMMIT");
  } catch (error) {
    await session.exec("ROLLBACK");
    throw error;
  }
  if (!counts.source_revisions)
    throw new Error("Provider tables have no data generation rows");
  await session.exec(`VACUUM (ANALYZE) ${table}`);
  await session.query(
    `INSERT INTO provider_search_build(id,slot,source_revisions,located_rows,unlocated_rows,built_at)
    VALUES (true,$1,$2,$3,$4,now()) ON CONFLICT (id) DO UPDATE SET slot=excluded.slot,
      source_revisions=excluded.source_revisions,located_rows=excluded.located_rows,
      unlocated_rows=excluded.unlocated_rows,built_at=excluded.built_at`,
    [slot, counts.source_revisions, counts.located_rows, counts.unlocated_rows],
  );
  let previousCleared = true;
  if (previous) {
    // A search that read the old slot name before the switch finishes within its own limit.
    try {
      await session.exec(`TRUNCATE ${previous}`);
    } catch {
      previousCleared = false;
    }
  }
  return {
    slot,
    located_rows: Number(counts.located_rows),
    unlocated_rows: Number(counts.unlocated_rows),
    source_revisions: counts.source_revisions,
    previous_cleared: previousCleared,
  };
}
