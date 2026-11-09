import type { Database } from "../../db/database.js";
import type { Address } from "./address.js";
import type { County } from "./counties.js";
import { countyAt, insideBounds, geocodeStates } from "./counties.js";
import type { OpenGeocoder, OpenPoint } from "./open.js";
import { openAttribution, openLicence, validateOpenDataset } from "./open.js";
import { cleanupScopeSignature } from "./cleanup.js";

export interface OpenRetryOptions {
  runId: string;
  sourceRunId: string;
  cleanupRunId: string;
  adapter: OpenGeocoder;
  limit?: number;
  deadline?: number;
  progress?: (message: string) => void;
}
export function validOpenPoint(
  point: OpenPoint,
  adapter: OpenGeocoder,
  counties: County[],
): boolean {
  const d = adapter.dataset,
    c = counties.find((c) => c.county_fips === point.county_fips);
  return (
    point.source === "open_geocoder" &&
    point.licence === openLicence &&
    point.attribution === openAttribution &&
    point.sha256 === d.sha256 &&
    point.index_sha256 === d.index_sha256 &&
    point.import_profile === d.import_profile &&
    point.data_date === d.data_date &&
    point.state === d.state &&
    !!c &&
    point.bounds_snapshot_id === c.snapshot_id &&
    insideBounds(point.latitude, point.longitude, c) &&
    countyAt(point.latitude, point.longitude, [c]) !== undefined
  );
}

/** Resume the frozen cleanup cohort without changing any Census or source address evidence. */
export async function retryOpenGeocoder(
  db: Database,
  counties: County[],
  options: OpenRetryOptions,
) {
  const { adapter } = options,
    d = adapter.dataset,
    limit = options.limit ?? 0;
  validateOpenDataset(d);
  if (
    !/^[a-zA-Z0-9_-]{1,80}$/.test(options.runId) ||
    !Number.isInteger(limit) ||
    limit < 0
  )
    throw new Error("Invalid open geocoder run");
  if (
    !counties.length ||
    counties.some((c) => !c.county_fips.startsWith(geocodeStates[d.state].fips))
  )
    throw new Error("Open geocoder county state differs");
  const cleanup = (
    await db.query(
      `SELECT r.state,r.npi_staged,r.issuer_staged,r.scope_signature FROM geocode_tx_run r WHERE run_id=$1`,
      [options.cleanupRunId],
    )
  ).rows[0];
  if (
    cleanup?.state !== d.state ||
    !cleanup.npi_staged ||
    !cleanup.issuer_staged
  )
    throw new Error("Open geocoder requires a completed cleanup run");
  if (cleanup.scope_signature !== cleanupScopeSignature(options.sourceRunId))
    throw new Error("Cleanup and source run identities differ");
  const incomplete = (
    await db.query(
      `SELECT 1 FROM geocode_cleanup_address c WHERE c.run_id=$1 AND c.changed AND c.geocodable
    AND NOT EXISTS(SELECT 1 FROM geocode_tx_result r WHERE r.address_hash=c.retry_hash) LIMIT 1`,
      [options.cleanupRunId],
    )
  ).rows.length;
  if (incomplete) throw new Error("Census cleanup is still pending");
  await db.transaction(async (tx) => {
    const run = (
      await tx.query(
        "SELECT *,to_char(data_date,'YYYY-MM-DD') data_date_iso FROM geocode_open_run WHERE run_id=$1",
        [options.runId],
      )
    ).rows[0];
    if (run) {
      if (
        run.cleanup_run_id !== options.cleanupRunId ||
        run.source_run_id !== options.sourceRunId ||
        run.state !== d.state ||
        run.dataset_sha256 !== d.sha256 ||
        run.index_sha256 !== d.index_sha256 ||
        run.import_profile !== d.import_profile ||
        run.data_date_iso !== d.data_date ||
        run.sample_limit !== limit
      )
        throw new Error("Open geocoder run scope differs");
      return;
    }
    const source = (
      await tx.query(
        "SELECT state,npi_staged,issuer_staged FROM geocode_tx_run WHERE run_id=$1",
        [options.sourceRunId],
      )
    ).rows[0];
    if (
      source?.state !== d.state ||
      !source.npi_staged ||
      !source.issuer_staged
    )
      throw new Error("Missing original state geocode run");
    const totals = (
      await tx.query(
        `SELECT count(*)::int addresses,count(*) FILTER(WHERE r.match_status='Match')::int matched
      FROM geocode_tx_address a JOIN geocode_tx_result r USING(address_hash) WHERE a.run_id=$1`,
        [options.sourceRunId],
      )
    ).rows[0]!;
    await tx.query(
      `INSERT INTO geocode_open_run(run_id,cleanup_run_id,source_run_id,state,dataset_sha256,data_date,sample_limit,census_matches_before,source_addresses,index_sha256,import_profile)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        options.runId,
        options.cleanupRunId,
        options.sourceRunId,
        d.state,
        d.sha256,
        d.data_date,
        limit,
        totals.matched,
        totals.addresses,
        d.index_sha256,
        d.import_profile,
      ],
    );
    await tx.query(
      `INSERT INTO geocode_open_result(run_id,address_hash,request_address)
      SELECT $1,c.address_hash,c.provenance->'request' FROM geocode_cleanup_address c JOIN geocode_tx_result r USING(address_hash)
      WHERE c.run_id=$2 AND c.geocodable AND r.match_status IN ('No_Match','Tie')
      ORDER BY c.address_hash LIMIT NULLIF($3,0)`,
      [options.runId, options.cleanupRunId, limit],
    );
  });
  let attempts = 0,
    errors = 0,
    rejected = 0,
    after = "";
  for (;;) {
    if (options.deadline && Date.now() >= options.deadline) break;
    const rows = (
      await db.query<{ address_hash: string; request_address: Address }>(
        `SELECT address_hash,request_address
      FROM geocode_open_result WHERE run_id=$1 AND NOT completed AND address_hash>$2 ORDER BY address_hash LIMIT 200`,
        [options.runId, after],
      )
    ).rows;
    if (!rows.length) break;
    for (const row of rows) {
      if (options.deadline && Date.now() >= options.deadline) break;
      after = row.address_hash;
      // An independent Census recovery during a resumed run always wins.
      if (
        (
          await db.query(
            "SELECT 1 FROM geocode_tx_result WHERE address_hash=$1 AND match_status='Match'",
            [row.address_hash],
          )
        ).rows.length
      ) {
        await db.query(
          "UPDATE geocode_open_result SET completed=true,observed_at=now() WHERE run_id=$1 AND address_hash=$2",
          [options.runId, row.address_hash],
        );
        continue;
      }
      let point: OpenPoint | null;
      try {
        attempts++;
        point = await adapter.geocode(row.request_address);
      } catch {
        errors++;
        continue;
      }
      if (point && !validOpenPoint(point, adapter, counties)) {
        rejected++;
        point = null;
      }
      await db.query(
        "UPDATE geocode_open_result SET completed=true,point=$3::jsonb,observed_at=now() WHERE run_id=$1 AND address_hash=$2",
        [options.runId, row.address_hash, point ? JSON.stringify(point) : null],
      );
    }
    options.progress?.(JSON.stringify({ attempts, errors, rejected }));
  }
  const run = (
    await db.query("SELECT * FROM geocode_open_run WHERE run_id=$1", [
      options.runId,
    ])
  ).rows[0]!;
  const totals = (
    await db.query<{ selected: number; pending: number; recovered: number }>(
      `SELECT count(*)::int selected,count(*) FILTER(WHERE NOT completed)::int pending,
    count(*) FILTER(WHERE point IS NOT NULL)::int recovered FROM geocode_open_result WHERE run_id=$1`,
      [options.runId],
    )
  ).rows[0]!;
  return {
    state: d.state,
    run_id: options.runId,
    cleanup_run: options.cleanupRunId,
    dataset: d,
    source: "open_geocoder",
    licence: openLicence,
    attribution: openAttribution,
    source_addresses: run.source_addresses,
    matched_before: run.census_matches_before,
    matched_after: Number(run.census_matches_before) + Number(totals.recovered),
    ...totals,
    attempts,
    errors,
    rejected,
    scope: limit ? "sample" : "all_unresolved",
    publication: "separate_open_ledger",
  };
}
