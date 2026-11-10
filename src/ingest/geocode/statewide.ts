import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Database, SqlSession } from "../../db/database.js";
import type { Address } from "./address.js";
import { addressIdentity, batchCsv } from "./address.js";
import { acquireBatch } from "./census.js";
import type { BatchFile, CensusOptions } from "./census.js";
import { parseBatch } from "./parse.js";
import { saveSnapshot, snapshotId } from "./repository.js";
import {
  countyAt,
  checkCountyPoint,
  insideBounds,
  geocodeState,
  geocodeStates,
} from "./counties.js";
import type { County } from "./counties.js";

interface Run extends Record<string, unknown> {
  state: string;
  source_shards: string[];
  npi_cursor: string[];
  issuer_cursor: string[];
  npi_staged: boolean;
  issuer_staged: boolean;
}
interface Work extends Record<string, unknown> {
  address_hash: string;
  address: Address;
  selection_county: string | null;
}
interface Batch extends Record<string, unknown> {
  run_id: string;
  batch_id: string;
  address_hashes: string[];
  request_csv: string;
}
export interface StatewideOptions extends CensusOptions {
  state?: string;
  runId: string;
  batchSize?: number;
  maxBatches?: number;
  deadline?: number;
  acquire?: (csv: string) => Promise<{ file: BatchFile; requests: number }>;
  progress?: (message: string) => void;
  /** Test/fault injection inside the transaction, after results but before its completion marker. */
  beforeCommit?: () => Promise<void>;
}
export async function createRun(
  db: SqlSession,
  runId: string,
  geographies = false,
  state = "TX",
): Promise<void> {
  geocodeState(state);
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(runId))
    throw new TypeError("Invalid geocode run ID");
  const profile = geographies ? "geographies" : "locations";
  await db.query(
    `INSERT INTO geocode_tx_run(run_id,source_shards,return_type,state)
    SELECT $1,coalesce(array_agg(s.snapshot_id ORDER BY s.snapshot_id),'{}'),$2,$3 FROM provider_shard s
    JOIN provider_active_set a ON a.snapshot_id=s.source_set_id
    JOIN snapshot snap ON snap.snapshot_id=s.snapshot_id AND snap.validation_state='ACTIVE'
    ON CONFLICT DO NOTHING`,
    [runId, profile, state],
  );
  if (
    (
      await db.query("SELECT state FROM geocode_tx_run WHERE run_id=$1", [
        runId,
      ])
    ).rows[0]?.state !== state
  )
    throw new Error("Statewide run state differs; use a new run ID");
  // Staging can precede the first submission. Once a manifest exists its endpoint/vintage cannot change.
  await db.query(
    `UPDATE geocode_tx_run r SET return_type=$2 WHERE run_id=$1 AND return_type<>$2
    AND NOT EXISTS(SELECT 1 FROM geocode_tx_batch b WHERE b.run_id=r.run_id)`,
    [runId, profile],
  );
  if (
    (
      await db.query("SELECT return_type FROM geocode_tx_run WHERE run_id=$1", [
        runId,
      ])
    ).rows[0]?.return_type !== profile
  )
    throw new Error(
      "Census request profile differs; use the original --geographies setting or a new run ID",
    );
}
export async function stagePage(
  db: Database,
  runId: string,
  source: "npi_address" | "qhp_provider_address",
  size = 20_000,
): Promise<number> {
  const run = (
    await db.query<Run>("SELECT * FROM geocode_tx_run WHERE run_id=$1", [runId])
  ).rows[0];
  if (!run) throw new Error("Missing statewide run");
  const npi = source === "npi_address",
    done = npi ? "npi_staged" : "issuer_staged",
    cursorColumn = npi ? "npi_cursor" : "issuer_cursor";
  if (run[done]) return 0;
  let cursor = run[cursorColumn];
  if (!npi) {
    // Page one indexed issuer shard at a time. Sorting all nationwide shards for each state page
    // repeatedly scans millions of irrelevant addresses on the real multi-issuer database.
    const shards = run.source_shards.filter((s) => s >= (cursor[0] ?? ""));
    for (const shard of shards) {
      const previous = shard === cursor[0] ? cursor : [shard, "", "-1"];
      const found = (
        await db.query(
          `SELECT 1 FROM qhp_provider_address WHERE snapshot_id=$1 AND state=$4
        AND (record_id,address_index)>($2,$3) ORDER BY record_id,address_index LIMIT 1`,
          [shard, previous[1] ?? "", Number(previous[2] ?? -1), run.state],
        )
      ).rows.length;
      if (found) {
        cursor = previous;
        break;
      }
      cursor = [shard, "", "-1"];
      if (shard === shards[shards.length - 1]) {
        await db.query(
          "UPDATE geocode_tx_run SET issuer_staged=true WHERE run_id=$1",
          [runId],
        );
        return 0;
      }
    }
    if (!shards.length) {
      await db.query(
        "UPDATE geocode_tx_run SET issuer_staged=true WHERE run_id=$1",
        [runId],
      );
      return 0;
    }
  }
  const rows = (
    await db.query<Address>(
      npi
        ? `SELECT 'npi_address'::text AS source_table,a.npi,a.kind,a.ordinal,a.line_1,a.line_2,a.city,a.state,a.zip5,a.snapshot_id
    FROM npi_address a JOIN npi_provider p USING(npi) WHERE a.kind='practice' AND a.state=$5 AND p.in_scope
    AND (a.npi,a.kind,a.ordinal)>($1,$2,$3) ORDER BY a.npi,a.kind,a.ordinal LIMIT $4`
        : `SELECT 'qhp_provider_address'::text AS source_table,a.snapshot_id||':'||a.record_id||':'||a.address_index::text AS source_row,
    NULL::text AS npi,'issuer'::text AS kind,a.address_index AS ordinal,a.address AS line_1,a.address_2 AS line_2,a.city,a.state,
    CASE WHEN btrim(a.zip) ~ '^[0-9]{5}([- ]?[0-9]{4})?$' THEN substring(btrim(a.zip),1,5) END AS zip5,a.snapshot_id,a.record_id
    FROM qhp_provider_address a WHERE a.snapshot_id=$5 AND a.state=$6
    AND (a.snapshot_id,a.record_id,a.address_index)>($1,$2,$3) ORDER BY a.snapshot_id,a.record_id,a.address_index LIMIT $4`,
      npi
        ? [
            cursor[0] ?? "",
            cursor[1] ?? "",
            Number(cursor[2] ?? -1),
            size,
            run.state,
          ]
        : [
            cursor[0] ?? "",
            cursor[1] ?? "",
            Number(cursor[2] ?? -1),
            size,
            cursor[0],
            run.state,
          ],
    )
  ).rows;
  const items = rows.map((a) => {
    const key = addressIdentity(a);
    return {
      run_id: runId,
      source_table: source,
      source_row: key.row,
      source_snapshot_id: a.snapshot_id,
      address_hash: key.hash,
      normalized_address: key.normalized,
      address: a,
    };
  });
  await db.transaction(async (tx) => {
    if (items.length) {
      const json = JSON.stringify(items);
      await tx.query(
        `INSERT INTO geocode_tx_input SELECT run_id,source_table,source_row,source_snapshot_id,address_hash,normalized_address
        FROM json_to_recordset($1::json) AS x(run_id text,source_table text,source_row text,source_snapshot_id text,address_hash text,normalized_address text)
        ON CONFLICT DO NOTHING`,
        [json],
      );
      await tx.query(
        `INSERT INTO geocode_tx_address(run_id,address_hash,address)
        SELECT DISTINCT ON(address_hash) run_id,address_hash,address FROM json_to_recordset($1::json) AS x(run_id text,address_hash text,address jsonb)
        ORDER BY address_hash ON CONFLICT DO NOTHING`,
        [json],
      );
      const last = rows[rows.length - 1]!;
      const next = npi
        ? [last.npi, last.kind, String(last.ordinal)]
        : [last.snapshot_id, last.record_id, String(last.ordinal)];
      await tx.query(
        `UPDATE geocode_tx_run SET ${cursorColumn}=$2 WHERE run_id=$1`,
        [runId, next],
      );
    } else
      await tx.query(`UPDATE geocode_tx_run SET ${done}=true WHERE run_id=$1`, [
        runId,
      ]);
  });
  return items.length;
}
export async function stageStatewide(
  db: Database,
  options: StatewideOptions,
): Promise<boolean> {
  await createRun(db, options.runId, options.geographies, options.state);
  for (const source of ["npi_address", "qhp_provider_address"] as const) {
    for (;;) {
      if (options.deadline && Date.now() >= options.deadline) return false;
      const n = await stagePage(db, options.runId, source);
      if (!n) break;
      options.progress?.(JSON.stringify({ stage: source, rows: n }));
    }
  }
  // Candidate scheduling county: greatest published ZCTA overlap, not an address county claim.
  await db.query(
    `WITH ranked AS (SELECT DISTINCT ON(z.zcta) z.zcta,z.county_fips FROM zcta_county z
    JOIN geo_import g ON g.relationship_snapshot_id=z.snapshot_id AND g.state=$2
    WHERE z.county_fips LIKE $3 ORDER BY z.zcta,z.arealand_part DESC,z.areawater_part DESC,z.county_fips)
    UPDATE geocode_tx_address a SET selection_county=z.county_fips FROM ranked z
    WHERE a.run_id=$1 AND a.address->>'zip5'=z.zcta AND a.selection_county IS NULL`,
    [
      options.runId,
      options.state ?? "TX",
      geocodeStates[geocodeState(options.state ?? "TX")].fips + "%",
    ],
  );
  await db.exec("ANALYZE geocode_tx_address; ANALYZE geocode_tx_input");
  return true;
}
interface Schedule {
  counties: (string | null)[];
  index: number;
}
async function nextBatch(
  db: Database,
  options: StatewideOptions,
  schedule: Schedule,
): Promise<Batch | undefined> {
  const pending = (
    await db.query<Batch>(
      "SELECT * FROM geocode_tx_batch WHERE run_id=$1 AND NOT completed",
      [options.runId],
    )
  ).rows[0];
  if (pending) return pending;
  // Keep JSON address payloads out of the population join. A null-safe join over all counties
  // can become a quadratic nested loop as the pending set shrinks on a real statewide database.
  const work: Work[] = [],
    size = options.batchSize ?? 10_000;
  while (work.length < size && schedule.index < schedule.counties.length) {
    const county = schedule.counties[schedule.index]!,
      remaining = size - work.length;
    const parameters =
      county === null
        ? [options.runId, remaining]
        : [options.runId, county, remaining];
    const page = (
      await db.query<Work>(
        `SELECT a.* FROM geocode_tx_address a WHERE a.run_id=$1
      AND ${county === null ? "a.selection_county IS NULL" : "a.selection_county=$2"}
      AND NOT EXISTS(SELECT 1 FROM geocode_tx_result r WHERE r.address_hash=a.address_hash)
      ORDER BY a.address_hash LIMIT ${county === null ? "$2" : "$3"}`,
        parameters,
      )
    ).rows;
    work.push(...page);
    if (page.length < remaining) schedule.index++;
  }
  if (!work.length) return;
  const csv = batchCsv(work.map((w) => w.address)),
    batchId = createHash("sha256").update(csv).digest("hex");
  return (
    await db.query<Batch>(
      `INSERT INTO geocode_tx_batch(run_id,batch_id,address_hashes,request_csv)
    VALUES($1,$2,$3,$4) RETURNING *`,
      [options.runId, batchId, work.map((w) => w.address_hash), csv],
    )
  ).rows[0];
}
export async function publishStatewide(
  db: SqlSession,
  runId: string,
  hashes?: string[],
): Promise<void> {
  const params = hashes ? [runId, hashes] : [runId];
  const inputs = hashes
    ? "batch_input i JOIN geocode_tx_result r USING(address_hash)"
    : `geocode_tx_result r
    JOIN LATERAL (SELECT * FROM geocode_tx_input i WHERE i.run_id=$1 AND i.address_hash=r.address_hash OFFSET 0) i ON true`;
  // Freeze this batch's indexed input keys before joining the growing result ledger.
  // A merge join can otherwise scan every source row in hash order on every batch.
  const batchInput = hashes
    ? `WITH batch_input AS MATERIALIZED (
    SELECT i.* FROM (SELECT DISTINCT unnest($2::text[]) address_hash ORDER BY address_hash) keys
    JOIN LATERAL (SELECT * FROM geocode_tx_input i WHERE i.run_id=$1 AND i.address_hash=keys.address_hash OFFSET 0) i ON true
  ) `
    : "";
  await db.query(
    `${batchInput}INSERT INTO geocode_attempt(address_hash,source_table,source_row,normalized_address,source_snapshot_id,
    snapshot_id,match_status,match_quality,outcome,geocoded_at)
    SELECT i.address_hash,i.source_table,i.source_row,i.normalized_address,i.source_snapshot_id,r.snapshot_id,r.match_status,r.match_quality,
    CASE WHEN r.method IS NULL THEN 'no_point' ELSE 'point' END,r.geocoded_at FROM ${inputs}
    ON CONFLICT(address_hash,source_table,source_row) DO UPDATE SET source_snapshot_id=excluded.source_snapshot_id,
    snapshot_id=excluded.snapshot_id,match_status=excluded.match_status,match_quality=excluded.match_quality,outcome=excluded.outcome,geocoded_at=excluded.geocoded_at
    WHERE (geocode_attempt.source_snapshot_id,geocode_attempt.snapshot_id,geocode_attempt.match_status,geocode_attempt.match_quality,geocode_attempt.outcome,geocode_attempt.geocoded_at)
      IS DISTINCT FROM (excluded.source_snapshot_id,excluded.snapshot_id,excluded.match_status,excluded.match_quality,excluded.outcome,excluded.geocoded_at)`,
    params,
  );
  // Keep each source's nearby batch points together while maintaining the live spatial indexes.
  // Full reconciliation retains its existing order: unchanged rows do not update those indexes.
  await db.query(
    `${batchInput}INSERT INTO address_point(address_hash,source_table,source_row,source_snapshot_id,latitude,longitude,method,match_status,match_quality,
    snapshot_id,centroid_snapshot_id,geocoded_at,normalization)
    SELECT i.address_hash,i.source_table,i.source_row,i.source_snapshot_id,r.latitude,r.longitude,r.method,r.match_status,r.match_quality,
    r.snapshot_id,r.centroid_snapshot_id,r.geocoded_at,r.normalization FROM ${inputs}
    WHERE r.method IS NOT NULL
    ${hashes ? "ORDER BY i.source_table,r.latitude,r.longitude,i.address_hash,i.source_row" : ""}
    ON CONFLICT(address_hash,source_table,source_row) DO UPDATE SET source_snapshot_id=excluded.source_snapshot_id,
    latitude=excluded.latitude,longitude=excluded.longitude,method=excluded.method,match_status=excluded.match_status,match_quality=excluded.match_quality,
    snapshot_id=excluded.snapshot_id,centroid_snapshot_id=excluded.centroid_snapshot_id,geocoded_at=excluded.geocoded_at,normalization=excluded.normalization
    WHERE (address_point.source_snapshot_id,address_point.latitude,address_point.longitude,address_point.method,address_point.match_status,
      address_point.match_quality,address_point.snapshot_id,address_point.centroid_snapshot_id,address_point.geocoded_at,address_point.normalization)
      IS DISTINCT FROM (excluded.source_snapshot_id,excluded.latitude,excluded.longitude,excluded.method,excluded.match_status,
        excluded.match_quality,excluded.snapshot_id,excluded.centroid_snapshot_id,excluded.geocoded_at,excluded.normalization)`,
    params,
  );
}
/** New geography can add an approximation to an existing unmatched Census observation; never invent a new match. */
export async function refreshStatewideFallbacks(
  db: Database,
  counties: County[],
  runId: string,
): Promise<number> {
  const candidates = (
    await db.query<{
      address_hash: string;
      latitude: number;
      longitude: number;
      snapshot_id: string;
    }>(
      `SELECT DISTINCT ON(r.address_hash)
    r.address_hash,c.latitude::float8,c.longitude::float8,c.snapshot_id FROM geocode_tx_result r
    JOIN geocode_tx_address a ON a.address_hash=r.address_hash AND a.run_id=$1
    JOIN zcta_centroid c ON c.zcta=a.address->>'zip5' JOIN geo_import g ON g.centroid_snapshot_id=c.snapshot_id AND g.state=(SELECT state FROM geocode_tx_run WHERE run_id=$1)
    WHERE r.method IS NULL AND r.match_status IN ('Tie','No_Match','rejected_out_of_bounds') ORDER BY r.address_hash,g.plan_year DESC`,
      [runId],
    )
  ).rows;
  const updates = candidates.flatMap((c) => {
    const county = countyAt(c.latitude, c.longitude, counties);
    return county
      ? [
          {
            ...c,
            county_fips: county.county_fips,
            bounds_snapshot_id: county.snapshot_id,
          },
        ]
      : [];
  });
  for (let i = 0; i < updates.length; i += 1000)
    await db.transaction(async (tx) => {
      await tx.query(
        `UPDATE geocode_tx_result r SET latitude=x.latitude,longitude=x.longitude,method='zcta_centroid',
      centroid_snapshot_id=x.snapshot_id,county_fips=x.county_fips,county_basis='point_in_county',bounds_snapshot_id=x.bounds_snapshot_id
      FROM json_to_recordset($1::json) AS x(address_hash text,latitude float8,longitude float8,snapshot_id text,county_fips text,bounds_snapshot_id text)
      WHERE r.address_hash=x.address_hash AND r.method IS NULL`,
        [JSON.stringify(updates.slice(i, i + 1000))],
      );
      await publishStatewide(
        tx,
        runId,
        updates.slice(i, i + 1000).map((u) => u.address_hash),
      );
    });
  return updates.length;
}
export async function geocodeStatewide(
  db: Database,
  counties: County[],
  options: StatewideOptions,
) {
  const size = options.batchSize ?? 10_000;
  if (!Number.isInteger(size) || size < 1 || size > 10_000)
    throw new TypeError("Batch size must be 1–10000");
  const report = { batches: 0, requests: 0, addressesSent: 0, stopped: false };
  const run = (
    await db.query(
      "SELECT state,return_type FROM geocode_tx_run WHERE run_id=$1",
      [options.runId],
    )
  ).rows[0];
  if (!run) throw new Error("Missing statewide run");
  const profile = run.return_type;
  const state = geocodeState(String(run.state));
  if (options.state !== undefined && options.state !== state)
    throw new Error("Statewide run state differs; use a new run ID");
  if (
    !counties.length ||
    counties.some((c) => !c.county_fips.startsWith(geocodeStates[state].fips))
  )
    throw new Error("County geometry state differs from run");
  if (!profile) throw new Error("Missing statewide run");
  const geographies = profile === "geographies";
  if (options.geographies !== undefined && options.geographies !== geographies)
    throw new Error(
      "Census request profile differs; use the original --geographies setting or a new run ID",
    );
  const centroids = (
    await db.query<{
      zcta: string;
      latitude: number;
      longitude: number;
      snapshot_id: string;
    }>(
      `SELECT DISTINCT ON(c.zcta) c.zcta,
    c.latitude::float8,c.longitude::float8,c.snapshot_id FROM zcta_centroid c JOIN geo_import g ON g.centroid_snapshot_id=c.snapshot_id
    WHERE g.state=$1 ORDER BY c.zcta,g.plan_year DESC`,
      [state],
    )
  ).rows;
  if (!centroids.length)
    throw new Error(
      `${state} geography import required before statewide geocoding`,
    );
  const byZip = new Map(centroids.map((c) => [c.zcta, c]));
  const schedule: Schedule = {
    index: 0,
    counties: (
      await db.query<{ selection_county: string | null }>(
        `SELECT selection_county
    FROM geocode_tx_address WHERE run_id=$1 GROUP BY selection_county
    ORDER BY (selection_county IS NULL),count(*) DESC,selection_county`,
        [options.runId],
      )
    ).rows.map((r) => r.selection_county),
  };
  for (;;) {
    if (
      (options.deadline && Date.now() >= options.deadline) ||
      report.batches >= (options.maxBatches ?? Infinity)
    ) {
      report.stopped = true;
      break;
    }
    const batch = await nextBatch(db, options, schedule);
    if (!batch) break;
    if (report.batches)
      await (options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))))(
        1000,
      );
    const { file, requests } = await (
      options.acquire ??
      ((csv) => acquireBatch(csv, { ...options, geographies }))
    )(batch.request_csv);
    report.requests += requests;
    const raw = await readFile(file.path);
    if (createHash("sha256").update(raw).digest("hex") !== file.metadata.sha256)
      throw new Error("Census snapshot hash mismatch");
    const parsed = await parseBatch(raw.toString("utf8"));
    // Keep the exact pending manifest on malformed/partial replies. Never skip or call this unmatched.
    if (
      parsed.issues.length ||
      parsed.rows.size !== batch.address_hashes.length ||
      batch.address_hashes.some((_, i) => !parsed.rows.has(String(i + 1)))
    )
      throw new Error("Incomplete Census batch; pending manifest retained");
    const inputs = (
      await db.query<Work>(
        "SELECT * FROM geocode_tx_address WHERE run_id=$1 AND address_hash=ANY($2::text[])",
        [options.runId, batch.address_hashes],
      )
    ).rows;
    const byHash = new Map(inputs.map((a) => [a.address_hash, a]));
    const results = batch.address_hashes.map((hash, i) => {
      const work = byHash.get(hash)!;
      if (!work) throw new Error("Lost batch address");
      const row = parsed.rows.get(String(i + 1))!;
      if (geographies && row.status === "Match" && !row.countyFips)
        throw new Error(
          "Incomplete Census county claim; pending manifest retained",
        );
      const claimedCounty = row.countyFips
        ? counties.find((c) => c.county_fips === row.countyFips)
        : undefined;
      const containingCounty =
        row.status === "Match"
          ? countyAt(row.latitude!, row.longitude!, counties)
          : undefined;
      // A claimed code missing from the outline vintage (Connecticut's former counties, for
      // example) falls back to the county that contains the point.
      const matchedCounty = claimedCounty ?? containingCounty;
      // Census matched-address state is evidence too: reject even an in-state coordinate with another state label.
      const returnedState = row.matchedAddress
        ?.split(",")
        .at(-2)
        ?.trim()
        .toUpperCase();
      const wrongState = Boolean(
        returnedState &&
        returnedState !== work.address.state.trim().toUpperCase(),
      );
      const rejected =
        row.status === "Match" &&
        (wrongState ||
          !containingCounty ||
          !matchedCounty ||
          !insideBounds(row.latitude!, row.longitude!, matchedCounty));
      const status = rejected ? "rejected_out_of_bounds" : row.status;
      function pointRejectionReason() {
        if (wrongState) {
          return "state_mismatch";
        } else if (!containingCounty) {
          return "outside_state_bounds";
        } else {
          return "outside_county_bounds";
        }
      }
      const rejection = rejected
        ? {
            response_row_id: row.id,
            raw_response: row.rawResponse,
            matched_address: row.matchedAddress,
            returned_state: returnedState ?? null,
            latitude: row.latitude,
            longitude: row.longitude,
            county_fips: row.countyFips ?? null,
            match_quality: row.quality,
            input_state: work.address.state,
            bounds_snapshot_id: counties[0]?.snapshot_id ?? null,
            reason: pointRejectionReason(),
          }
        : null;
      const candidate =
        status !== "Match" ? byZip.get(work.address.zip5 ?? "") : undefined;
      const fallbackCounty = candidate
        ? countyAt(candidate.latitude, candidate.longitude, counties)
        : undefined;
      const centroid = fallbackCounty ? candidate : undefined;
      const pointCounty = status === "Match" ? matchedCounty : fallbackCounty;
      const latitude =
        status === "Match" ? row.latitude! : (centroid?.latitude ?? null);
      const longitude =
        status === "Match" ? row.longitude! : (centroid?.longitude ?? null);
      let method;
      if (status === "Match") {
        method = "census_geocoder";
      } else if (centroid) {
        method = "zcta_centroid";
      } else {
        method = null;
      }
      const county = pointCounty?.county_fips ?? work.selection_county;
      let basis;
      if (status === "Match" && claimedCounty) {
        basis = "census_response";
      } else if (pointCounty) {
        basis = "point_in_county";
      } else if (county) {
        basis = "zip_candidate";
      } else {
        basis = "unknown";
      }
      if (latitude !== null && longitude !== null)
        checkCountyPoint(latitude, longitude, county!, counties);
      return {
        address_hash: hash,
        normalized_address: addressIdentity(work.address).normalized,
        match_status: status,
        match_quality: status === "Match" ? row.quality : null,
        method,
        latitude,
        longitude,
        county_fips: county,
        county_basis: basis,
        snapshot_id: snapshotId(file),
        centroid_snapshot_id: centroid?.snapshot_id ?? null,
        bounds_snapshot_id: pointCounty?.snapshot_id ?? null,
        rejection,
      };
    });
    await db.transaction(async (tx) => {
      await saveSnapshot(tx, file);
      await tx.query(
        `INSERT INTO geocode_tx_result(address_hash,normalized_address,match_status,match_quality,method,latitude,longitude,
        county_fips,county_basis,snapshot_id,centroid_snapshot_id,bounds_snapshot_id,rejection)
        SELECT address_hash,normalized_address,match_status,match_quality,method,latitude,longitude,county_fips,county_basis,snapshot_id,centroid_snapshot_id,bounds_snapshot_id,rejection
        FROM json_to_recordset($1::json) AS x(address_hash text,normalized_address text,match_status text,match_quality text,method text,
          latitude float8,longitude float8,county_fips text,county_basis text,snapshot_id text,centroid_snapshot_id text,bounds_snapshot_id text,rejection jsonb)
        ON CONFLICT DO NOTHING`,
        [JSON.stringify(results)],
      );
      await publishStatewide(tx, options.runId, batch.address_hashes);
      await options.beforeCommit?.();
      await tx.query(
        `UPDATE snapshot SET validation_state='ACTIVE',activated_at=coalesce(activated_at,now()) WHERE snapshot_id=$1`,
        [snapshotId(file)],
      );
      await tx.query(
        `UPDATE geocode_tx_batch SET completed=true,snapshot_id=$3,completed_at=now() WHERE run_id=$1 AND batch_id=$2`,
        [options.runId, batch.batch_id, snapshotId(file)],
      );
    });
    report.batches++;
    report.addressesSent += batch.address_hashes.length;
    options.progress?.(JSON.stringify({ ...report, batch: batch.batch_id }));
  }
  if (report.batches)
    await db.exec(
      "ANALYZE geocode_attempt; ANALYZE address_point; ANALYZE geocode_tx_result",
    );
  return report;
}
