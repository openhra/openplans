import { createHash, randomUUID } from "node:crypto";
import type { Database, SqlSession } from "./database.js";
import { loadConfig } from "../config/index.js";
import { applicationVersion } from "../mcp/version.js";
import { canonical } from "../api/cache/index.js";
import type { LowestInput } from "../api/handy.js";

export const HANDY_ALGORITHM = `${applicationVersion}:lowest-silver-v1`;
export const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
// Conservative: all admitted source revisions, including rules, geography and policy changes.
// Derived publications are excluded so a build cannot invalidate its own inputs.
const sourceVector = `SELECT table_name,revision::text FROM api_data_generation
 WHERE table_name NOT LIKE 'handy_lowest_%' ORDER BY table_name`;
export async function handyManifest(db: SqlSession) {
  const { rows } = await db.query<{ table_name: string; revision: string }>(
    sourceVector,
  );
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
export const handyKey = (input: LowestInput) =>
  digest(canonical({ ...input, page: 1 }));

export async function readLowestCell(
  db: SqlSession,
  input: LowestInput,
  manifest: string,
) {
  const { rows } = await db.query<{
    payload: string;
    payload_sha256: string;
    request_json: string;
  }>(
    `SELECT b.payload,b.payload_sha256,b.request_json FROM handy_lowest_active a
    JOIN handy_lowest_build b USING(build_id)
    WHERE a.request_key=$1 AND b.request_key=$1 AND b.input_manifest=$2 AND b.algorithm=$3
      AND b.complete AND b.expected_partitions=b.written_partitions
      AND b.expires_at>now() AND (b.expired_at IS NULL OR b.expired_at>now())
      AND (a.expired_at IS NULL OR a.expired_at>now())`,
    [handyKey(input), manifest, HANDY_ALGORITHM],
  );
  const cell = rows[0];
  if (
    !cell ||
    digest(cell.payload) !== cell.payload_sha256 ||
    cell.request_json !== canonical({ ...input, page: 1 })
  )
    return undefined;
  try {
    return JSON.parse(cell.payload) as unknown;
  } catch {
    return undefined;
  }
}

/** One partition at a time, with an enforced 2 GiB total payload budget. */
export async function stageLowestCell(
  tx: SqlSession,
  input: LowestInput,
  manifest: string,
  payload: string,
) {
  if (Buffer.byteLength(payload) > 2 * 1024 ** 2)
    throw new Error("Lowest premium cell too large");
  const size = await tx.query<{ bytes: string }>(
    "SELECT coalesce(sum(octet_length(payload)),0)::text AS bytes FROM handy_lowest_build",
  );
  // Payload cap leaves half the 2 GiB active allowance for indexes and manifests.
  if (Number(size.rows[0]?.bytes ?? 0) + Buffer.byteLength(payload) > 1024 ** 3)
    throw new Error("Lowest premium build budget exceeded");
  const id = randomUUID();
  await tx.query(
    `INSERT INTO handy_lowest_build
    (build_id,request_key,request_json,input_manifest,algorithm,expected_partitions,written_partitions,complete,payload,payload_sha256,expires_at)
    VALUES($1,$2,$3,$4,$5,1,1,true,$6,$7,now()+interval '1 day')`,
    [
      id,
      handyKey(input),
      canonical({ ...input, page: 1 }),
      manifest,
      HANDY_ALGORITHM,
      payload,
      digest(payload),
    ],
  );
  const actual = await tx.query<{ bytes: string }>(`SELECT
    (pg_total_relation_size('handy_lowest_build') + pg_total_relation_size('handy_lowest_active'))::text AS bytes`);
  if (Number(actual.rows[0]?.bytes ?? 0) > 2 * 1024 ** 3)
    throw new Error("Lowest premium disk budget exceeded");
  return id;
}

/** Fresh transaction: source locks prevent a publication between validation and activation. */
export async function activateLowestCell(
  db: Database,
  id: string,
  manifest: string,
) {
  return db.transaction(async (tx) => {
    await tx.query(
      "SELECT table_name FROM api_data_generation WHERE table_name NOT LIKE 'handy_lowest_%' ORDER BY table_name FOR SHARE",
    );
    if ((await handyManifest(tx)) !== manifest) return false;
    const activated = await tx.query(
      `INSERT INTO handy_lowest_active(request_key,build_id)
      SELECT request_key,build_id FROM handy_lowest_build WHERE build_id=$1 AND complete
       AND expected_partitions=written_partitions AND input_manifest=$2 AND expires_at>now()
      ON CONFLICT(request_key) DO UPDATE SET build_id=EXCLUDED.build_id RETURNING build_id`,
      [id, manifest],
    );
    if (!activated.rows.length) return false;
    // MVCC DELETE preserves rows visible to existing readers; never TRUNCATE a used version.
    await tx.query(
      `DELETE FROM handy_lowest_build b WHERE b.build_id<>$1
      AND b.request_key=(SELECT request_key FROM handy_lowest_build WHERE build_id=$1)
      AND NOT EXISTS(SELECT 1 FROM handy_lowest_active a WHERE a.build_id=b.build_id)`,
      [id],
    );
    return true;
  });
}
export async function* lowestBuildRequests(db: SqlSession) {
  let after = "";
  for (;;) {
    const { rows } = await db.query<{
      request_key: string;
      request_json: string;
    }>(
      `SELECT a.request_key,b.request_json
      FROM handy_lowest_active a JOIN handy_lowest_build b USING(build_id)
      WHERE a.request_key>$1 ORDER BY a.request_key LIMIT 100`,
      [after],
    );
    if (!rows.length) return;
    for (const row of rows) yield JSON.parse(row.request_json) as LowestInput;
    after = rows[rows.length - 1]!.request_key;
  }
}

export async function handySnapshots(db: SqlSession, ids: string[]) {
  return (
    await db.query(
      `SELECT s.snapshot_id,p.publisher,
    coalesce(s.final_url,s.requested_url) AS url,s.sha256,s.validation_state
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
