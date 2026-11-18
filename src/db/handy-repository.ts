import { createHash, randomUUID } from "node:crypto";
import type { SqlSession } from "./database.js";
import { loadConfig } from "../config/index.js";
import { applicationVersion } from "../mcp/version.js";
import { canonical } from "../api/cache/index.js";
import { lowestInput, type LowestInput } from "../api/handy.js";
import { LowestEvidence } from "./lowest-evidence.js";

export const HANDY_ALGORITHM = `${applicationVersion}:lowest-silver-v1`;
export const LOWEST_PUBLICATION_ALGORITHM = `${HANDY_ALGORITHM}:county-v3`;
export const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
// Conservative: all admitted source revisions, including rules, geography and policy changes.
// Derived publications are excluded so a build cannot invalidate its own inputs.
const sourceVector = `SELECT table_name,revision::text FROM api_data_generation
 WHERE table_name NOT LIKE 'handy_lowest_%' ORDER BY table_name COLLATE "C"`;
type SourceRevision = { table_name: string; revision: string };
export async function handyManifest(db: SqlSession) {
  const { rows } = await db.query<SourceRevision>(sourceVector);
  return manifestFromRows(rows);
}

/** One atomic read for the public generation and its pricing source vector. */
export async function handyVersion(db: SqlSession) {
  const { rows } = await db.query<{
    generation: string;
    revisions: SourceRevision[];
  }>(`SELECT
    md5(string_agg(table_name || ':' || revision::text, ',' ORDER BY table_name COLLATE "C")) AS generation,
    coalesce(jsonb_agg(jsonb_build_object('table_name',table_name,'revision',revision::text) ORDER BY table_name COLLATE "C")
      FILTER (WHERE table_name NOT LIKE 'handy_lowest_%'), '[]'::jsonb) AS revisions
    FROM api_data_generation`);
  const state = rows[0];
  if (!state?.generation) throw new Error("Data generation unavailable");
  return {
    generation: state.generation,
    manifest: manifestFromRows(state.revisions),
  };
}

function manifestFromRows(rows: SourceRevision[]) {
  const required = [
    "snapshot",
    "source",
    "puf_active_catalog",
    "puf_import_file",
    "plan",
    "plan_attribute",
    "rate",
    "service_area_county",
    "rating_area",
    "geo_import",
    "zcta_county",
    "state_rating_rule",
    "state_rate_active",
    "state_community_rate",
    "record_policy",
  ];
  if (
    required.some((name) => !rows.some((r) => r.table_name === name)) ||
    !rows.some((r) => r.table_name.startsWith("__database__:"))
  )
    throw new Error("Data generation unavailable");
  const config = loadConfig();
  return digest(
    canonical([HANDY_ALGORITHM, rows, config.ny, config.gaQuoteRecovery]),
  );
}
/** ZIPs resolve before this boundary. All adult ages above 64 share the filed 64+ cell. */
export function countyLowestInput(input: LowestInput): LowestInput {
  if (!input.county) throw new Error("County required for publication");
  const { zip: _, ...county } = input;
  return lowestInput({ ...county, age: Math.min(input.age, 64), page: 1 });
}
export const handyKey = (input: LowestInput) =>
  digest(canonical(countyLowestInput(input)));
export const lowestEvidenceKey = (input: LowestInput, manifest: string) =>
  digest(
    canonical([
      countyLowestInput({ ...input, age: 0 }),
      manifest,
      LOWEST_PUBLICATION_ALGORITHM,
    ]),
  );

const readableLowest = `b.input_manifest=$2 AND b.algorithm=$3
      AND b.complete AND b.expected_partitions=b.written_partitions
      AND b.expires_at>now() AND (b.expired_at IS NULL OR b.expired_at>now())
      AND (a.expired_at IS NULL OR a.expired_at>now())
`;
type StoredLowest = {
  request_key: string;
  payload: string;
  payload_sha256: string;
  request_json: string;
};
// Payload hashes are checked on every read, including cache hits. Expiry stays in SQL.
const evidenceCache = new Map<string, LowestEvidence>();
function decodedEvidence(payload: string, hash: string) {
  let evidence = evidenceCache.get(hash);
  if (evidence) evidenceCache.delete(hash);
  else evidence = new LowestEvidence(payload);
  if (evidence.decodedBytes <= 16 * 1024 ** 2)
    evidenceCache.set(hash, evidence);
  let bytes = [...evidenceCache.values()].reduce(
    (sum, entry) => sum + entry.decodedBytes,
    0,
  );
  while (evidenceCache.size > 8 || bytes > 16 * 1024 ** 2) {
    const key = evidenceCache.keys().next().value!;
    bytes -= evidenceCache.get(key)!.decodedBytes;
    evidenceCache.delete(key);
  }
  return evidence;
}
export type CompactLowest = [
  root: number,
  plan: number | null,
  issuer: number | null,
  cents: number | null,
  metal: number,
  snapshot: number | null,
];

function storedPayload(cell: StoredLowest, evidence: LowestEvidence) {
  if (digest(cell.payload) !== cell.payload_sha256) return undefined;
  try {
    const tuple = JSON.parse(cell.payload) as CompactLowest;
    if (!Array.isArray(tuple) || tuple.length !== 6) return undefined;
    const input = lowestInput(JSON.parse(cell.request_json));
    if (
      cell.request_key !== handyKey(input) ||
      cell.request_json !== canonical(countyLowestInput(input))
    )
      return undefined;
    const body = evidence.get(String(input.age), tuple[0]) as
      | {
          lowest?: { plan_id: string | null; monthly_cents: number | null };
          basis?: { metal: string };
          location?: { age: number };
        }
      | undefined;
    if (
      !body?.lowest ||
      !body.basis ||
      body.location?.age !== input.age ||
      body.lowest.plan_id !== evidence.scalar(tuple[1]) ||
      body.lowest.monthly_cents !== tuple[3] ||
      body.basis.metal !== evidence.scalar(tuple[4])
    )
      return undefined;
    return body;
  } catch {
    return undefined;
  }
}

export async function readLowestCell(
  db: SqlSession,
  value: LowestInput,
  manifest: string,
) {
  const input = countyLowestInput(value);
  const { rows } = await db.query<
    StoredLowest & { evidence: string; evidence_sha256: string }
  >(
    `SELECT b.request_key,b.payload,b.payload_sha256,b.request_json,e.payload AS evidence,e.payload_sha256 AS evidence_sha256 FROM handy_lowest_active a
     JOIN handy_lowest_build b USING(build_id) JOIN handy_lowest_evidence e USING(evidence_id)
     WHERE (e.expired_at IS NULL OR e.expired_at>now()) AND a.request_key=$1 AND b.request_key=$1 AND ${readableLowest}`,
    [handyKey(input), manifest, LOWEST_PUBLICATION_ALGORITHM],
  );
  const row = rows[0];
  if (
    !row ||
    row.request_json !== canonical(input) ||
    digest(row.evidence) !== row.evidence_sha256
  )
    return undefined;
  try {
    return storedPayload(
      row,
      decodedEvidence(row.evidence, row.evidence_sha256),
    );
  } catch {
    return undefined;
  }
}

/** Read each shared dictionary once while auditing the persisted inventory. */
export async function* lowestPublishedCells(db: SqlSession, manifest: string) {
  let after = "";
  for (;;) {
    const { rows } = await db.query<{
      evidence_id: string;
      payload: string;
      payload_sha256: string;
      cells: (StoredLowest & { expires_at_ms: string })[];
    }>(
      `SELECT e.evidence_id,e.payload,e.payload_sha256,
      (SELECT jsonb_agg(jsonb_build_object('request_key',b.request_key,'request_json',b.request_json,
        'payload',b.payload,'payload_sha256',b.payload_sha256,
        'expires_at_ms',(extract(epoch from least(b.expires_at,b.expired_at,a.expired_at))*1000)::text) ORDER BY b.request_key)
       FROM handy_lowest_build b JOIN handy_lowest_active a USING(build_id)
       WHERE b.evidence_id=e.evidence_id AND a.request_key=b.request_key AND ${readableLowest}) AS cells
      FROM handy_lowest_evidence e WHERE (e.expired_at IS NULL OR e.expired_at>now()) AND e.evidence_id>$1 ORDER BY e.evidence_id LIMIT 20`,
      [after, manifest, LOWEST_PUBLICATION_ALGORITHM],
    );
    if (!rows.length) return;
    for (const row of rows) {
      if (!row.cells?.length || digest(row.payload) !== row.payload_sha256)
        continue;
      let evidence: LowestEvidence;
      try {
        evidence = new LowestEvidence(row.payload);
      } catch {
        continue;
      }
      for (const cell of row.cells) {
        const payload = storedPayload(cell, evidence);
        if (payload !== undefined)
          yield {
            request_key: cell.request_key,
            request_json: cell.request_json,
            payload,
            expiresAt: Number(cell.expires_at_ms),
          };
      }
    }
    after = rows[rows.length - 1]!.evidence_id;
  }
}

export async function readLowestEvidence(db: SqlSession, id: string) {
  const { rows } = await db.query<{ payload: string; payload_sha256: string }>(
    "SELECT payload,payload_sha256 FROM handy_lowest_evidence WHERE evidence_id=$1 AND (expired_at IS NULL OR expired_at>now())",
    [id],
  );
  const row = rows[0];
  if (row && digest(row.payload) === row.payload_sha256) {
    try {
      return new LowestEvidence(row.payload);
    } catch {
      /* Rebuild corrupt evidence. */
    }
  }
  return new LowestEvidence();
}

export async function readLowestGroup(
  db: SqlSession,
  input: LowestInput,
  manifest: string,
  evidence: LowestEvidence,
) {
  const { rows } = await db.query<StoredLowest>(
    `SELECT b.request_key,b.payload,b.payload_sha256,b.request_json
    FROM handy_lowest_active a JOIN handy_lowest_build b USING(build_id)
    WHERE b.evidence_id=$1 AND a.request_key=b.request_key AND ${readableLowest}`,
    [
      lowestEvidenceKey(input, manifest),
      manifest,
      LOWEST_PUBLICATION_ALGORITHM,
    ],
  );
  return new Map(
    rows.map((row) => [row.request_key, storedPayload(row, evidence)]),
  );
}

/** Replace a county's requested cells atomically with their shared evidence. */
export async function publishLowestCells(
  tx: SqlSession,
  input: LowestInput,
  manifest: string,
  evidence: LowestEvidence,
  cells: { input: LowestInput; compact: CompactLowest; snapshots: string[] }[],
) {
  const evidenceId = lowestEvidenceKey(input, manifest),
    encoded = evidence.encode();
  const keys = cells.map((cell) => handyKey(cell.input));
  // Reclaim interrupted rows before admission, including obsolete evidence left by a new source vector.
  await tx.query(
    "DELETE FROM handy_lowest_active WHERE request_key=ANY($1::text[])",
    [keys],
  );
  await tx.query(
    "DELETE FROM handy_lowest_build WHERE request_key=ANY($1::text[])",
    [keys],
  );
  await tx.query(
    "DELETE FROM handy_lowest_evidence e WHERE NOT EXISTS(SELECT 1 FROM handy_lowest_build b WHERE b.evidence_id=e.evidence_id)",
  );
  await tx.query(
    `INSERT INTO handy_lowest_evidence(evidence_id,payload,payload_sha256,raw_bytes) VALUES($1,$2,$3,$4)
    ON CONFLICT(evidence_id) DO UPDATE SET payload=EXCLUDED.payload,payload_sha256=EXCLUDED.payload_sha256,raw_bytes=EXCLUDED.raw_bytes,sourced_at=clock_timestamp(),expired_at=NULL`,
    [evidenceId, encoded.payload, digest(encoded.payload), encoded.rawBytes],
  );
  const records = cells.map((cell) => ({
    id: randomUUID(),
    key: handyKey(cell.input),
    request: canonical(countyLowestInput(cell.input)),
    payload: JSON.stringify(cell.compact),
    hash: digest(JSON.stringify(cell.compact)),
    snapshots: cell.snapshots,
  }));
  await tx.query(
    `INSERT INTO handy_lowest_build
    (build_id,request_key,request_json,input_manifest,algorithm,expected_partitions,written_partitions,complete,payload,payload_sha256,expires_at,evidence_id)
    SELECT r.id,r.key,r.request,$2,$3,1,1,true,r.payload,r.hash,least(now()+interval '1 day',
      (SELECT min(s.expired_at) FROM snapshot s WHERE s.snapshot_id=ANY(r.snapshots))),$4
    FROM jsonb_to_recordset($1::jsonb) AS r(id text,key text,request text,payload text,hash text,snapshots text[])`,
    [
      JSON.stringify(records),
      manifest,
      LOWEST_PUBLICATION_ALGORITHM,
      evidenceId,
    ],
  );
  await tx.query(
    `INSERT INTO handy_lowest_active(request_key,build_id)
    SELECT request_key,build_id FROM handy_lowest_build WHERE request_key=ANY($1::text[]) AND expires_at>now()
    AND (expired_at IS NULL OR expired_at>now())`,
    [keys],
  );
  const actual = await tx.query<{ bytes: string }>(`SELECT
    (pg_total_relation_size('handy_lowest_build') + pg_total_relation_size('handy_lowest_active') + pg_total_relation_size('handy_lowest_evidence') + pg_total_relation_size('handy_lowest_usage'))::text AS bytes`);
  if (Number(actual.rows[0]?.bytes ?? 0) > 2 * 1024 ** 3)
    throw new Error("Lowest premium disk budget exceeded");
}

/** Registered cells are rebuilt as bounded county/year groups after an import. */
export async function* lowestBuildGroups(db: SqlSession) {
  let after = "";
  for (;;) {
    const { rows } = await db.query<{
      evidence_id: string;
      requests: string[];
    }>(
      `SELECT b.evidence_id,jsonb_agg(b.request_json ORDER BY b.request_key) AS requests
       FROM handy_lowest_active a JOIN handy_lowest_build b USING(build_id)
       WHERE b.evidence_id>$1 GROUP BY b.evidence_id ORDER BY b.evidence_id LIMIT 20`,
      [after],
    );
    if (!rows.length) return;
    for (const row of rows)
      yield row.requests.map((request) => lowestInput(JSON.parse(request)));
    after = rows[rows.length - 1]!.evidence_id;
  }
}

export async function handySnapshots(
  db: SqlSession,
  ids: string[],
  includeDates = false,
) {
  return (
    await db.query(
      `SELECT s.snapshot_id,p.publisher,
    coalesce(s.final_url,s.requested_url) AS url,s.sha256,s.validation_state${includeDates ? `,to_char(s.retrieved_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS retrieved_at` : ""}
    FROM snapshot s JOIN source p USING(source_id) WHERE s.snapshot_id=ANY($1::text[])
    ORDER BY s.snapshot_id`,
      [ids],
    )
  ).rows;
}

/** Catalog evidence also backs a complete empty result. */
export async function handyScopeSnapshotIds(
  db: SqlSession,
  state: string | null,
  year: number,
) {
  const { rows } = await db.query<{ snapshot_id: string }>(
    `SELECT f.snapshot_id
    FROM puf_active_catalog a JOIN puf_import_file f USING(import_id) WHERE a.state=$1 AND a.plan_year=$2
    UNION SELECT import_id AS snapshot_id FROM state_rate_active WHERE state=$1 AND plan_year=$2`,
    [state, year],
  );
  return rows.map((r) => r.snapshot_id);
}

/** Loaded geography, using the same current source priority as ZIP resolution. */
export async function lowestInventoryLocations(db: SqlSession) {
  const scopes = await db.query<{ state: string; year: number }>(
    `SELECT state,plan_year AS year FROM puf_active_catalog
     UNION SELECT state,plan_year AS year FROM state_rate_active
     ORDER BY year,state`,
  );
  const geography = await db.query<{ zip: string; county: string }>(
    `WITH zcta AS (
       SELECT DISTINCT z.zcta AS zip,z.county_fips AS county FROM zcta_county z
       JOIN (SELECT DISTINCT ON (state) relationship_snapshot_id FROM geo_import
         ORDER BY state,imported_at DESC,plan_year DESC) g
         ON g.relationship_snapshot_id=z.snapshot_id
     )
     SELECT zip,county FROM zcta
     UNION SELECT f.zip,f.county_fips AS county FROM zip_county_fallback f
       JOIN geonames_import g ON g.snapshot_id=f.snapshot_id AND g.singleton
       WHERE f.source='geonames' AND NOT EXISTS(SELECT 1 FROM zcta z WHERE z.zip=f.zip)
     ORDER BY zip,county`,
  );
  // Counties without a ZCTA can still occur in filed county/rating-area data.
  const additional = await db.query<{
    county: string;
  }>(`SELECT county_fips AS county FROM rating_area WHERE county_fips ~ '^[0-9]{5}$'
    UNION SELECT county_fips AS county FROM service_area_county WHERE county_fips ~ '^[0-9]{5}$'`);
  return {
    scopes: scopes.rows,
    counties: [
      ...new Set([
        ...geography.rows.map((row) => row.county),
        ...additional.rows.map((row) => row.county),
      ]),
    ].sort(),
  };
}

export async function lowestBuildSize(db: SqlSession) {
  const { rows } = await db.query<{
    database_bytes: string;
    derived_bytes: string;
    payload_bytes: string;
    raw_payload_bytes: string;
    active_cells: string;
    checked_at_ms: string;
  }>(`SELECT pg_database_size(current_database())::text AS database_bytes,
    (pg_total_relation_size('handy_lowest_build') + pg_total_relation_size('handy_lowest_active') + pg_total_relation_size('handy_lowest_evidence') + pg_total_relation_size('handy_lowest_usage'))::text AS derived_bytes,
    (SELECT payload_bytes FROM handy_lowest_usage)::text AS payload_bytes,
    (SELECT raw_payload_bytes FROM handy_lowest_usage)::text AS raw_payload_bytes,
    (SELECT count(*) FROM handy_lowest_active)::text AS active_cells,
    (extract(epoch from clock_timestamp())*1000)::text AS checked_at_ms`);
  const row = rows[0]!;
  return {
    database_bytes: Number(row.database_bytes),
    derived_bytes: Number(row.derived_bytes),
    payload_bytes: Number(row.payload_bytes),
    raw_payload_bytes: Number(row.raw_payload_bytes),
    active_cells: Number(row.active_cells),
    checked_at_ms: Number(row.checked_at_ms),
  };
}
