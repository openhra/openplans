import type { SqlSession } from "../../db/database.js";
import { addressIdentity } from "./address.js";
import type { Address } from "./address.js";
import type { BatchFile } from "./census.js";
import { documentation, endpoint, geographyEndpoint } from "./census.js";
import type { BatchRow } from "./parse.js";
import { zipCentroid } from "../../domain/geo/index.js";
export interface Selection {
  county?: string;
  zips?: string[];
  source?: "npi_address" | "qhp_provider_address";
}
export const addressCursor = (a: Address) =>
  `${a.source_table ?? "npi_address"}:${addressIdentity(a).row}`;
export async function addresses(
  db: SqlSession,
  selection: Selection,
  after: string,
  size: number,
): Promise<Address[]> {
  return (
    await db.query<Address>(
      `WITH inputs AS (
    SELECT 'npi_address'::text AS source_table,a.npi||':'||a.kind||':'||a.ordinal::text AS source_row,
      a.npi,a.kind,a.ordinal,a.line_1,a.line_2,a.city,a.state,a.zip5,a.snapshot_id
    FROM npi_address a JOIN npi_provider p USING(npi) WHERE a.kind='practice' AND a.state='TX' AND p.in_scope
      AND ($5::text IS NULL OR $5='npi_address')
    UNION ALL
    SELECT 'qhp_provider_address',a.snapshot_id||':'||a.record_id||':'||a.address_index::text,r.npi,'issuer',a.address_index,
      a.address,a.address_2,a.city,a.state,CASE WHEN btrim(a.zip) ~ '^[0-9]{5}([- ]?[0-9]{4})?$' THEN substring(btrim(a.zip),1,5) END,a.snapshot_id
    FROM qhp_provider_address a JOIN qhp_provider_record r USING(snapshot_id,record_id)
    JOIN provider_shard s USING(snapshot_id) JOIN provider_active_set active ON active.snapshot_id=s.source_set_id
    WHERE a.state='TX' AND ($5::text IS NULL OR $5='qhp_provider_address')
  ) SELECT a.* FROM inputs a WHERE a.source_table||':'||a.source_row > $1
    AND ($2::text[] IS NULL OR a.zip5=ANY($2))
    AND ($3::text IS NULL OR EXISTS (SELECT 1 FROM zcta_county z JOIN geo_import g
      ON g.relationship_snapshot_id=z.snapshot_id WHERE z.zcta=a.zip5 AND z.county_fips=$3 AND g.state='TX'))
    ORDER BY a.source_table||':'||a.source_row LIMIT $4`,
      [
        after,
        selection.zips ?? null,
        selection.county ?? null,
        size,
        selection.source ?? null,
      ],
    )
  ).rows;
}
export async function reused(db: SqlSession, a: Address): Promise<boolean> {
  const key = addressIdentity(a),
    table = a.source_table ?? "npi_address";
  const found = (
    await db.query<{
      source_table: string;
      source_row: string;
      source_snapshot_id: string;
    }>(
      `SELECT source_table,source_row,source_snapshot_id
    FROM geocode_attempt WHERE address_hash=$1 AND outcome<>'issue'
    ORDER BY (match_status='Match') DESC,(source_table=$2 AND source_row=$3) DESC,geocoded_at DESC LIMIT 1`,
      [key.hash, table, key.row],
    )
  ).rows[0];
  if (!found) return false;
  if (
    found.source_table === table &&
    found.source_row === key.row &&
    found.source_snapshot_id === a.snapshot_id
  )
    return true;
  // Reuse the point (or terminal no-point) across rows and publishers without changing geocode provenance.
  await db.query(
    `INSERT INTO geocode_attempt(address_hash,source_table,source_row,normalized_address,source_snapshot_id,
    snapshot_id,match_status,match_quality,outcome,geocoded_at)
    SELECT address_hash,$2,$3,normalized_address,$4,snapshot_id,match_status,match_quality,outcome,geocoded_at
    FROM geocode_attempt WHERE address_hash=$1 AND source_table=$5 AND source_row=$6
    ON CONFLICT(address_hash,source_table,source_row) DO UPDATE SET source_snapshot_id=excluded.source_snapshot_id,
      snapshot_id=excluded.snapshot_id,match_status=excluded.match_status,match_quality=excluded.match_quality,
      outcome=excluded.outcome,geocoded_at=excluded.geocoded_at`,
    [
      key.hash,
      table,
      key.row,
      a.snapshot_id,
      found.source_table,
      found.source_row,
    ],
  );
  await db.query(
    `INSERT INTO address_point(address_hash,source_table,source_row,source_snapshot_id,latitude,longitude,
    method,match_status,match_quality,snapshot_id,centroid_snapshot_id,geocoded_at,normalization)
    SELECT address_hash,$2,$3,$4,latitude,longitude,method,match_status,match_quality,snapshot_id,centroid_snapshot_id,geocoded_at,normalization
    FROM address_point WHERE address_hash=$1 AND source_table=$5 AND source_row=$6
    ON CONFLICT(address_hash,source_table,source_row) DO UPDATE SET source_snapshot_id=excluded.source_snapshot_id,
      latitude=excluded.latitude,longitude=excluded.longitude,method=excluded.method,match_status=excluded.match_status,
      match_quality=excluded.match_quality,snapshot_id=excluded.snapshot_id,centroid_snapshot_id=excluded.centroid_snapshot_id,
      geocoded_at=excluded.geocoded_at,normalization=excluded.normalization`,
    [
      key.hash,
      table,
      key.row,
      a.snapshot_id,
      found.source_table,
      found.source_row,
    ],
  );
  return true;
}
export const snapshotId = (f: BatchFile) =>
  `census-geocoder-batch:${f.metadata.sha256}`;
export async function saveSnapshot(
  db: SqlSession,
  f: BatchFile,
): Promise<void> {
  const m = f.metadata;
  await db.query(
    `INSERT INTO source(source_id,publisher,source_kind,registry_evidence,terms_review_reference)
    VALUES ('census-geocoder-batch','US Census Bureau','geocoding',$1,$2)
    ON CONFLICT(source_id) DO UPDATE SET registry_evidence=excluded.registry_evidence`,
    [JSON.stringify([endpoint, geographyEndpoint]), documentation],
  );
  await db.query(
    `INSERT INTO snapshot(snapshot_id,source_id,requested_url,final_url,redirect_chain,retrieved_at,http_status,
    content_type,compressed_bytes,sha256,raw_path,schema_version,parser_version,terms_review_reference,
    expected_children,fetched_children,validation_state)
    VALUES($1,'census-geocoder-batch',$2,$3,$4,$5,$6,$7,$8,$9,$10,$12,'geocode-v2',$11,0,0,'PARSED')
    ON CONFLICT DO NOTHING`,
    [
      snapshotId(f),
      m.url,
      m.final_url,
      JSON.stringify(m.redirect_chain),
      m.fetched_at,
      m.status,
      m.content_type,
      m.bytes,
      m.sha256,
      f.path,
      documentation,
      m.url.includes("/geographies/")
        ? "census-geographies-batch"
        : "census-locations-batch",
    ],
  );
}
export async function issue(
  db: SqlSession,
  snapshot: string,
  record: string,
  code: string,
): Promise<void> {
  await db.query(
    `INSERT INTO quality_issue(snapshot_id,source_record,severity,issue_code,explanation)
    VALUES($1,$2,'warning',$3,'Census batch row could not be used; no exact location inferred')`,
    [snapshot, record, `geocode_${code}`],
  );
}
export async function saveResult(
  db: SqlSession,
  a: Address,
  row: BatchRow | undefined,
  snapshot: string,
): Promise<"census_geocoder" | "zcta_centroid" | "no_point" | "issue"> {
  const key = addressIdentity(a),
    centroid =
      row && row.status !== "Match" && a.zip5
        ? await zipCentroid(db, a.zip5)
        : null;
  let method: "zcta_centroid" | "census_geocoder" | "issue" | "no_point";
  if (row?.status === "Match") {
    method = "census_geocoder";
  } else if (centroid) {
    method = "zcta_centroid";
  } else if (row) {
    method = "no_point";
  } else {
    method = "issue";
  }
  function attemptOutcome() {
    if (method === "no_point") {
      return "no_point";
    } else if (method === "issue") {
      return "issue";
    } else {
      return "point";
    }
  }
  await db.query(
    `INSERT INTO geocode_attempt(address_hash,source_table,source_row,normalized_address,source_snapshot_id,
    snapshot_id,match_status,match_quality,outcome) VALUES($1,$9,$2,$3,$4,$5,$6,$7,$8)
    ON CONFLICT(address_hash,source_table,source_row) DO UPDATE SET source_snapshot_id=EXCLUDED.source_snapshot_id,
    snapshot_id=EXCLUDED.snapshot_id,match_status=EXCLUDED.match_status,match_quality=EXCLUDED.match_quality,
    outcome=EXCLUDED.outcome,geocoded_at=now()`,
    [
      key.hash,
      key.row,
      key.normalized,
      a.snapshot_id,
      snapshot,
      row?.status ?? "invalid",
      row?.quality ?? null,
      attemptOutcome(),
      a.source_table ?? "npi_address",
    ],
  );
  if (method === "no_point" || method === "issue") return method;
  await db.query(
    `INSERT INTO address_point(address_hash,source_table,source_row,source_snapshot_id,latitude,longitude,
    method,match_status,match_quality,snapshot_id,centroid_snapshot_id) VALUES($1,$11,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    ON CONFLICT(address_hash,source_table,source_row) DO UPDATE SET source_snapshot_id=EXCLUDED.source_snapshot_id,
    latitude=EXCLUDED.latitude,longitude=EXCLUDED.longitude,method=EXCLUDED.method,match_status=EXCLUDED.match_status,
    match_quality=EXCLUDED.match_quality,snapshot_id=EXCLUDED.snapshot_id,centroid_snapshot_id=EXCLUDED.centroid_snapshot_id,geocoded_at=now()`,
    [
      key.hash,
      key.row,
      a.snapshot_id,
      centroid?.latitude ?? row!.latitude,
      centroid?.longitude ?? row!.longitude,
      method,
      row!.status,
      row!.quality,
      snapshot,
      centroid?.snapshot_id ?? null,
      a.source_table ?? "npi_address",
    ],
  );
  return method;
}
