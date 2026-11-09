import type { Database } from "../../db/database.js";
import { createHash } from "node:crypto";
import type { Address } from "./address.js";
import { addressIdentity } from "./address.js";
import {
  normalizeAddress,
  assertHouseNumber,
  normalizationVersion,
} from "./normalize.js";
import { createRun, geocodeStatewide, publishStatewide } from "./statewide.js";
import type { StatewideOptions } from "./statewide.js";
import type { County } from "./counties.js";
import { geocodeStates, geocodeState } from "./counties.js";
import type { OperatorGeocoder } from "./operator.js";
import { validateOperatorPoint } from "./operator.js";
import { storeOperatorPoints } from "./operator-store.js";

interface CleanupRow extends Record<string, unknown> {
  address_hash: string;
  retry_hash: string;
  changed: boolean;
  geocodable: boolean;
  provenance: ReturnType<typeof normalizeAddress>;
  original_result: Record<string, unknown>;
}
export const cleanupScopeSignature = (sourceRunId: string) =>
  createHash("sha256")
    .update(JSON.stringify(["cleanup", sourceRunId, normalizationVersion]))
    .digest("hex");
export async function cleanupGeocodes(
  db: Database,
  counties: County[],
  options: StatewideOptions & {
    sourceRunId: string;
    operator?: OperatorGeocoder | null;
    env?: NodeJS.ProcessEnv;
  },
) {
  if (options.sourceRunId === options.runId)
    throw new Error("Cleanup requires a separate run ID");
  const original = (
    await db.query("SELECT * FROM geocode_tx_run WHERE run_id=$1", [
      options.sourceRunId,
    ])
  ).rows[0];
  if (!original?.npi_staged || !original.issuer_staged)
    throw new Error("Cleanup requires a fully staged source run");
  const state = geocodeState(String(original.state));
  if (options.state && options.state !== state)
    throw new Error("Statewide run state differs");
  if (
    !counties.length ||
    counties.some((c) => !c.county_fips.startsWith(geocodeStates[state].fips))
  )
    throw new Error("County geometry state differs from run");
  const existing = (
    await db.query("SELECT * FROM geocode_tx_run WHERE run_id=$1", [
      options.runId,
    ])
  ).rows[0];
  const scope = cleanupScopeSignature(options.sourceRunId);
  if (existing) {
    const frozen = existing.scope_signature;
    if (frozen && frozen !== scope)
      throw new Error("Cleanup run scope differs");
    if (
      !frozen &&
      ((existing.source_shards as string[]).length ||
        (
          await db.query(
            "SELECT 1 FROM geocode_tx_input WHERE run_id=$1 LIMIT 1",
            [options.runId],
          )
        ).rows.length)
    )
      throw new Error("Cleanup requires its own run ID");
  }
  await createRun(db, options.runId, options.geographies, state);
  await db.query(
    `UPDATE geocode_tx_run SET npi_staged=true,issuer_staged=true,source_shards='{}',scope_signature=$2 WHERE run_id=$1`,
    [options.runId, scope],
  );
  let after = "";
  for (;;) {
    const rows = (
      await db.query<{
        address_hash: string;
        address: Address;
        result: Record<string, unknown>;
      }>(
        `SELECT a.address_hash,a.address,to_jsonb(r) result
      FROM geocode_tx_address a JOIN geocode_tx_result r USING(address_hash)
      WHERE a.run_id=$1 AND a.address_hash>$2 AND r.match_status IN ('No_Match','Tie')
      ORDER BY a.address_hash LIMIT 2000`,
        [options.sourceRunId, after],
      )
    ).rows;
    if (!rows.length) break;
    const candidates = rows.map((r) => {
      const clean = normalizeAddress(r.address);
      assertHouseNumber(r.address, clean.request);
      return {
        address_hash: r.address_hash,
        retry_hash: addressIdentity(clean.request).hash,
        provenance: clean,
        original_result: r.result,
        changed: clean.changed,
        geocodable: clean.geocodable,
      };
    });
    await db.query(
      `INSERT INTO geocode_cleanup_address(run_id,address_hash,retry_hash,provenance,original_result,changed,geocodable)
      SELECT $1,address_hash,retry_hash,provenance,original_result,changed,geocodable FROM json_to_recordset($2::json)
      AS x(address_hash text,retry_hash text,provenance jsonb,original_result jsonb,changed boolean,geocodable boolean) ON CONFLICT DO NOTHING`,
      [options.runId, JSON.stringify(candidates)],
    );
    after = rows.at(-1)!.address_hash;
  }
  // A cleaned hash can already have a valid cached result. It is still retained in this run's scope.
  await db.query(
    `INSERT INTO geocode_tx_address(run_id,address_hash,address,selection_county)
    SELECT DISTINCT ON(c.retry_hash) $1,c.retry_hash,c.provenance->'request',a.selection_county
    FROM geocode_cleanup_address c JOIN geocode_tx_address a ON a.run_id=$2 AND a.address_hash=c.address_hash
    WHERE c.run_id=$1 AND c.changed AND c.geocodable ORDER BY c.retry_hash,c.address_hash ON CONFLICT DO NOTHING`,
    [options.runId, options.sourceRunId],
  );
  const census = await geocodeStatewide(db, counties, {
    ...options,
    state,
    get deadline() {
      return options.deadline;
    },
  });
  const recovered = (
    await db.query<{ address_hash: string }>(
      `SELECT c.address_hash FROM geocode_cleanup_address c
    JOIN geocode_tx_result r ON r.address_hash=c.retry_hash WHERE c.run_id=$1 AND c.changed AND c.geocodable
    AND r.match_status='Match' AND r.method='census_geocoder' ORDER BY c.address_hash`,
      [options.runId],
    )
  ).rows;
  for (let i = 0; i < recovered.length; i += 1000)
    await db.transaction(async (tx) => {
      const hashes = recovered.slice(i, i + 1000).map((r) => r.address_hash);
      await tx.query(
        `UPDATE geocode_tx_result original SET match_status=r.match_status,match_quality=r.match_quality,
      method=r.method,latitude=r.latitude,longitude=r.longitude,county_fips=r.county_fips,county_basis=r.county_basis,
      snapshot_id=r.snapshot_id,centroid_snapshot_id=NULL,bounds_snapshot_id=r.bounds_snapshot_id,geocoded_at=r.geocoded_at,
      rejection=NULL,normalization=c.provenance||jsonb_build_object('original_snapshot_id',c.original_result->>'snapshot_id')
      FROM geocode_cleanup_address c JOIN geocode_tx_result r ON r.address_hash=c.retry_hash
      WHERE c.run_id=$1 AND c.address_hash=ANY($2::text[]) AND original.address_hash=c.address_hash
      AND original.match_status IN ('Tie','No_Match')`,
        [options.runId, hashes],
      );
      await publishStatewide(tx, options.sourceRunId, hashes);
    });
  const operator = {
    enabled: !!options.operator,
    matched: 0,
    rejected: 0,
    stored: 0,
    storage_failures: 0,
  };
  if (options.operator) {
    const pending = (
      await db.query<CleanupRow>(
        `SELECT c.* FROM geocode_cleanup_address c JOIN geocode_tx_result r USING(address_hash)
      WHERE c.run_id=$1 AND c.geocodable AND r.match_status IN ('No_Match','Tie') ORDER BY c.address_hash`,
        [options.runId],
      )
    ).rows;
    for (const row of pending) {
      if (options.deadline && Date.now() >= options.deadline) break;
      // Unchanged addresses qualify only after Census cleanup has finished; incomplete batches never skip ahead.
      if (
        row.changed &&
        !(
          await db.query(
            "SELECT 1 FROM geocode_tx_result WHERE address_hash=$1",
            [row.retry_hash],
          )
        ).rows.length
      )
        continue;
      const point = await options.operator.geocode(row.provenance.request);
      if (!point) continue;
      if (!validateOperatorPoint(point, counties)) {
        operator.rejected++;
        continue;
      }
      operator.matched++;
      try {
        operator.stored += await storeOperatorPoints(
          [
            {
              ...point,
              address_hash: row.address_hash,
              bounds_snapshot_id: counties.find(
                (c) => c.county_fips === point.county_fips,
              )!.snapshot_id,
            },
          ],
          counties,
          options.dataDir,
          options.env,
        );
      } catch {
        operator.storage_failures++;
      }
    }
  }
  const totals = (
    await db.query<{
      addresses: number;
      matched_after: number;
      normalized_matches: number;
      zcta_fallback: number;
    }>(
      `SELECT count(*)::int addresses,count(*) FILTER(WHERE r.match_status='Match')::int matched_after,
    count(*) FILTER(WHERE r.normalization IS NOT NULL AND r.match_status='Match')::int normalized_matches,
    count(*) FILTER(WHERE r.method='zcta_centroid')::int zcta_fallback
    FROM geocode_tx_address a JOIN geocode_tx_result r USING(address_hash) WHERE a.run_id=$1`,
      [options.sourceRunId],
    )
  ).rows[0]!;
  const rules = (
    await db.query(
      `SELECT rule,count(*)::int addresses,
    count(*) FILTER(WHERE c.changed AND c.geocodable)::int eligible,
    count(*) FILTER(WHERE r.match_status='Match' AND c.changed AND c.geocodable)::int recovered
    FROM geocode_cleanup_address c CROSS JOIN LATERAL jsonb_array_elements_text(c.provenance->'rules') rule
    LEFT JOIN geocode_tx_result r ON r.address_hash=c.retry_hash WHERE c.run_id=$1 GROUP BY rule ORDER BY rule`,
      [options.runId],
    )
  ).rows;
  const candidates = (
    await db.query<{
      unresolved_before: number;
      eligible: number;
      po_boxes: number;
      pending: number;
    }>(
      `SELECT count(*)::int unresolved_before,count(*) FILTER(WHERE changed AND geocodable)::int eligible,
    count(*) FILTER(WHERE NOT geocodable)::int po_boxes,
    count(*) FILTER(WHERE changed AND geocodable AND NOT EXISTS(SELECT 1 FROM geocode_tx_result r WHERE r.address_hash=c.retry_hash))::int pending
    FROM geocode_cleanup_address c WHERE run_id=$1`,
      [options.runId],
    )
  ).rows[0]!;
  return {
    state,
    source_run: options.sourceRunId,
    cleanup_run: options.runId,
    normalizer: normalizationVersion,
    ...totals,
    ...candidates,
    matched_before: Number(totals.matched_after) - recovered.length,
    recovered: recovered.length,
    rules,
    census,
    operator,
  };
}
