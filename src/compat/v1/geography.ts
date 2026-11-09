import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { Readable } from "node:stream";
import type { SqlSession } from "../../db/database.js";
import { relationships } from "../../ingest/geo/parse.js";
import { GEO_SOURCES } from "../../ingest/geo/sources.js";

interface CountySnapshot extends Record<string, unknown> {
  raw_path: string;
  sha256: string;
  compressed_bytes: string;
}
let countyLabels:
  { key: string; names: Promise<Map<string, string>> } | undefined;

/** Read legal labels by FIPS from the same verified Census source as native geography. */
export async function countyDisplayNames(db: SqlSession, fips: string[]) {
  const { rows } = await db.query<{ county_fips: string; county_name: string }>(
    `SELECT DISTINCT z.county_fips,z.county_name FROM zcta_county z
    JOIN (SELECT DISTINCT ON (state) relationship_snapshot_id FROM geo_import
      ORDER BY state,imported_at DESC,plan_year DESC) g ON g.relationship_snapshot_id=z.snapshot_id
    WHERE z.county_fips=ANY($1::text[])`,
    [fips],
  );
  const candidates = new Map<string, Set<string>>();
  for (const row of rows) {
    const names = candidates.get(row.county_fips) ?? new Set<string>();
    names.add(row.county_name);
    candidates.set(row.county_fips, names);
  }
  const labels = new Map(
    [...candidates].flatMap(([code, names]) =>
      names.size === 1 ? [[code, [...names][0]!] as const] : [],
    ),
  );
  if (fips.every((code) => labels.has(code))) return labels;
  // State-scoped imports may retain the national source without importing every county.
  const { rows: snapshots } = await db.query<CountySnapshot>(
    `SELECT DISTINCT s.raw_path,s.sha256,s.compressed_bytes::text,s.retrieved_at
    FROM snapshot s JOIN (SELECT DISTINCT ON (state) relationship_snapshot_id FROM geo_import
      ORDER BY state,imported_at DESC,plan_year DESC) g ON g.relationship_snapshot_id=s.snapshot_id
    WHERE s.source_id=$1 AND s.requested_url=$2 AND s.validation_state='ACTIVE'
    ORDER BY s.retrieved_at DESC`,
    [GEO_SOURCES.relationship.source, GEO_SOURCES.relationship.url],
  );
  for (const snapshot of snapshots) {
    let info;
    try {
      info = await stat(snapshot.raw_path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (
      info.size !== Number(snapshot.compressed_bytes) ||
      info.size > GEO_SOURCES.relationship.maxBytes
    )
      throw new Error("Geography snapshot size mismatch");
    const key = JSON.stringify([
      snapshot,
      info.ino,
      info.mtimeMs,
      info.ctimeMs,
    ]);
    if (countyLabels?.key !== key) {
      const names = (async () => {
        const bytes = await readFile(snapshot.raw_path);
        if (
          bytes.length !== info.size ||
          createHash("sha256").update(bytes).digest("hex") !== snapshot.sha256
        )
          throw new Error("Geography snapshot hash mismatch");
        const names = new Map<string, string>();
        const ambiguous = new Set<string>();
        for await (const row of relationships(Readable.from([bytes]))) {
          if (
            names.has(row.countyFips) &&
            names.get(row.countyFips) !== row.countyName
          )
            ambiguous.add(row.countyFips);
          names.set(row.countyFips, row.countyName);
        }
        for (const code of ambiguous) names.delete(code);
        return names;
      })();
      countyLabels = { key, names };
      void names.catch(() => {
        if (countyLabels?.key === key) countyLabels = undefined;
      });
    }
    const names = await countyLabels.names;
    for (const code of fips) {
      const name = names.get(code);
      if (!labels.has(code) && name) labels.set(code, name);
    }
    if (fips.every((code) => labels.has(code))) break;
  }
  return labels;
}

// Census state names paired with the native county-to-state identity lookup.
// Geography identity says nothing about an exchange's supported products.
const names: Record<string, string> = {
  AL: "Alabama",
  AK: "Alaska",
  AZ: "Arizona",
  AR: "Arkansas",
  CA: "California",
  CO: "Colorado",
  CT: "Connecticut",
  DE: "Delaware",
  DC: "District of Columbia",
  FL: "Florida",
  GA: "Georgia",
  HI: "Hawaii",
  ID: "Idaho",
  IL: "Illinois",
  IN: "Indiana",
  IA: "Iowa",
  KS: "Kansas",
  KY: "Kentucky",
  LA: "Louisiana",
  ME: "Maine",
  MD: "Maryland",
  MA: "Massachusetts",
  MI: "Michigan",
  MN: "Minnesota",
  MS: "Mississippi",
  MO: "Missouri",
  MT: "Montana",
  NE: "Nebraska",
  NV: "Nevada",
  NH: "New Hampshire",
  NJ: "New Jersey",
  NM: "New Mexico",
  NY: "New York",
  NC: "North Carolina",
  ND: "North Dakota",
  OH: "Ohio",
  OK: "Oklahoma",
  OR: "Oregon",
  PA: "Pennsylvania",
  RI: "Rhode Island",
  SC: "South Carolina",
  SD: "South Dakota",
  TN: "Tennessee",
  TX: "Texas",
  UT: "Utah",
  VT: "Vermont",
  VA: "Virginia",
  WA: "Washington",
  WV: "West Virginia",
  WI: "Wisconsin",
  WY: "Wyoming",
};
export const stateName = (code: string | null): string | null =>
  code === null ? null : (names[code] ?? null);
