import type { Database } from "../../db/database.js";
import { countyAt } from "./counties.js";
import type { County } from "./counties.js";
import { publishStatewide } from "./statewide.js";

/** Restore matched observations after compact or a serving-artifact restore, without requests. */
export async function reuseStatewideMatches(
  db: Database,
  runId: string,
  counties: County[],
  deadline?: number,
) {
  let after = "";
  for (;;) {
    if (deadline && Date.now() >= deadline) return;
    const { rows } = await db.query<{
      address_hash: string;
      normalized_address: string;
      latitude: number;
      longitude: number;
      snapshot_id: string;
      match_quality: string | null;
      geocoded_at: string;
      normalization: unknown;
    }>(
      `SELECT a.address_hash,coalesce(g.normalized_address,p.normalized_address) normalized_address,
      p.latitude,p.longitude,p.snapshot_id,p.match_quality,p.geocoded_at,p.normalization
      FROM geocode_tx_address a
      JOIN LATERAL (SELECT p.*,i.normalized_address FROM address_point p
        JOIN geocode_tx_input i ON i.run_id=a.run_id AND i.address_hash=a.address_hash
        WHERE p.address_hash=a.address_hash AND p.match_status='Match' AND p.method='census_geocoder'
        ORDER BY p.geocoded_at DESC LIMIT 1) p ON true
      LEFT JOIN LATERAL (SELECT normalized_address FROM geocode_match_archive g
        WHERE g.address_hash=a.address_hash ORDER BY g.geocoded_at DESC LIMIT 1) g ON true
      WHERE a.run_id=$1 AND a.address_hash>$2
        AND NOT EXISTS(SELECT 1 FROM geocode_tx_result r WHERE r.address_hash=a.address_hash)
        AND NOT EXISTS(SELECT 1 FROM geocode_tx_batch b WHERE b.run_id=a.run_id AND NOT b.completed
          AND a.address_hash=ANY(b.address_hashes))
      ORDER BY a.address_hash LIMIT 10000`,
      [runId, after],
    );
    if (!rows.length) return;
    after = rows.at(-1)!.address_hash;
    const results = rows.flatMap((row) => {
      const county = countyAt(row.latitude, row.longitude, counties);
      return county
        ? [
            {
              ...row,
              county_fips: county.county_fips,
              bounds_snapshot_id: county.snapshot_id,
            },
          ]
        : [];
    });
    if (!results.length) continue;
    await db.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO geocode_tx_result(address_hash,normalized_address,match_status,match_quality,
        method,latitude,longitude,county_fips,county_basis,snapshot_id,bounds_snapshot_id,geocoded_at,normalization)
        SELECT address_hash,normalized_address,'Match',match_quality,'census_geocoder',latitude,longitude,
          county_fips,'point_in_county',snapshot_id,bounds_snapshot_id,geocoded_at,normalization
        FROM json_to_recordset($1::json) x(address_hash text,normalized_address text,match_quality text,
          latitude float8,longitude float8,county_fips text,snapshot_id text,bounds_snapshot_id text,
          geocoded_at timestamptz,normalization jsonb) ON CONFLICT DO NOTHING`,
        [JSON.stringify(results)],
      );
      await publishStatewide(
        tx,
        runId,
        results.map((row) => row.address_hash),
      );
    });
  }
}
