import type { SqlSession } from "../../db/database.js";
import type { GeoFile, GeoKind } from "./sources.js";
import { STATE_FIPS } from "./states.js";
import { geoSources } from "./sources.js";
import { cmsCountySnapshot } from "./cms.js";
import type { CmsLookupOptions } from "./cms.js";
import { geonamesAttribution } from "./fallback-snapshot.js";

export const snapshotId = (file: GeoFile) =>
  `${file.metadata.source}:${file.metadata.sha256}`;
export async function saveSnapshot(
  tx: SqlSession,
  kind: GeoKind,
  file: GeoFile,
  state = "TX",
): Promise<void> {
  const source = geoSources(state)[kind],
    m = file.metadata;
  if (
    m.source !== source.source ||
    m.url !== source.url ||
    !/^[a-f0-9]{64}$/.test(m.sha256)
  ) {
    throw new Error("Geography snapshot metadata does not match its source");
  }
  await tx.query(
    `INSERT INTO source (source_id, publisher, source_kind, registry_evidence, terms_review_reference)
    VALUES ($1, $2, 'geography', $3, $4) ON CONFLICT (source_id) DO NOTHING`,
    [m.source, source.publisher, JSON.stringify([source.url]), source.url],
  );
  function snapshotSchema() {
    if (kind === "ratingAreas") {
      return "cms-state-gra-observed";
    } else if (kind === "centroids") {
      return "census-gazetteer-2021-zcta2020";
    } else {
      return "census-2020";
    }
  }
  await tx.query(
    `INSERT INTO snapshot (snapshot_id, source_id, requested_url, final_url, redirect_chain,
    retrieved_at, http_status, etag, last_modified, content_type, compressed_bytes, sha256, raw_path,
    schema_version, parser_version, expected_children, fetched_children, validation_state)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'geo-v1',0,0,'PARSED')
    ON CONFLICT (snapshot_id) DO NOTHING`,
    [
      snapshotId(file),
      m.source,
      m.url,
      m.final_url,
      JSON.stringify(m.redirect_chain),
      m.fetched_at,
      m.status,
      m.etag,
      m.last_modified,
      m.content_type,
      m.bytes,
      m.sha256,
      file.path,
      snapshotSchema(),
    ],
  );
}
export async function insertRows(
  tx: SqlSession,
  table: "zcta_county" | "zcta_centroid" | "rating_area",
  rows: unknown[][],
): Promise<void> {
  if (!rows.length) return;
  const columns = {
    zcta_county:
      "zcta,county_fips,county_name,arealand_zcta,areawater_zcta,arealand_county,areawater_county,arealand_part,areawater_part,snapshot_id,source_row",
    zcta_centroid: "zcta,latitude,longitude,snapshot_id,source_row",
    rating_area:
      "state,county_fips,rating_area_id,plan_year,snapshot_id,source_row",
  }[table];
  const values: unknown[] = [];
  const placeholders = rows.map(
    (row) =>
      `(${row
        .map((value) => {
          values.push(value);
          return `$${values.length}`;
        })
        .join(",")})`,
  );
  await tx.query(
    `INSERT INTO ${table} (${columns}) VALUES ${placeholders.join(",")} ON CONFLICT DO NOTHING`,
    values,
  );
}
export interface CountyShare extends Record<string, unknown> {
  county_fips: string;
  county_name: string;
  snapshot_id: string;
  source_row: number;
  arealand_zcta: string | null;
  areawater_zcta: string | null;
  arealand_county: string | null;
  areawater_county: string | null;
  arealand_part: string | null;
  areawater_part: string | null;
  source?: "zcta" | "cms_marketplace" | "geonames";
  attribution?: typeof geonamesAttribution;
  /** Decimal fractions of the ZCTA and county land area; null when the denominator is zero. */
  zcta_land_share: string | null;
  county_land_share: string | null;
}
export interface ZipCounties {
  zip: string;
  status: "available" | "unknown";
  geography: "2020_zcta" | "postal_zip";
  source: "zcta" | "cms_marketplace" | "geonames" | null;
  counties: CountyShare[];
  attribution?: typeof geonamesAttribution;
}
export function createGeoRepository(
  db: SqlSession,
  options: CmsLookupOptions = {},
) {
  return {
    async zipToCounties(zip: string): Promise<ZipCounties> {
      if (!/^\d{5}$/.test(zip))
        throw new TypeError("ZIP must be a five-digit string");
      const { rows } = await db.query<CountyShare>(
        `SELECT DISTINCT z.county_fips, z.county_name,
        z.arealand_zcta::text, z.areawater_zcta::text, z.arealand_county::text, z.areawater_county::text,
        z.arealand_part::text, z.areawater_part::text, z.snapshot_id, z.source_row,
        (z.arealand_part::numeric / NULLIF(z.arealand_zcta, 0))::text AS zcta_land_share,
        (z.arealand_part::numeric / NULLIF(z.arealand_county, 0))::text AS county_land_share
        FROM zcta_county z JOIN (
          SELECT DISTINCT ON (state) relationship_snapshot_id FROM geo_import
          ORDER BY state, imported_at DESC, plan_year DESC
        ) g ON g.relationship_snapshot_id = z.snapshot_id
        WHERE z.zcta = $1 ORDER BY z.county_fips`,
        [zip],
      );
      // This early return is the hard source boundary: no fallback cache read or live call for a ZCTA.
      if (rows.length)
        return {
          zip,
          status: "available",
          geography: "2020_zcta",
          source: "zcta",
          counties: rows.map((row) => ({ ...row, source: "zcta" })),
        };
      const cmsSnapshot = await cmsCountySnapshot(db, zip, options);
      if (cmsSnapshot) {
        const counties = await fallbackCounties(
          db,
          zip,
          "cms_marketplace",
          cmsSnapshot,
        );
        if (counties.length)
          return {
            zip,
            status: "available",
            geography: "postal_zip",
            source: "cms_marketplace",
            counties,
          };
      }
      const counties = await fallbackCounties(db, zip, "geonames");
      return counties.length
        ? {
            zip,
            status: "available",
            geography: "postal_zip",
            source: "geonames",
            attribution: geonamesAttribution,
            counties,
          }
        : {
            zip,
            status: "unknown",
            geography: "2020_zcta",
            source: null,
            counties: [],
          };
    },
  };
}
export async function zipToCounties(
  db: SqlSession,
  zip: string,
  options: CmsLookupOptions = {},
): Promise<ZipCounties> {
  return createGeoRepository(db, options).zipToCounties(zip);
}

async function fallbackCounties(
  db: SqlSession,
  zip: string,
  source: "cms_marketplace" | "geonames",
  snapshot?: string,
): Promise<CountyShare[]> {
  const { rows } = await db.query<CountyShare>(
    `SELECT f.county_fips,f.county_name,f.snapshot_id,f.source_row,
    NULL::text AS arealand_zcta,NULL::text AS areawater_zcta,NULL::text AS arealand_county,
    NULL::text AS areawater_county,NULL::text AS arealand_part,NULL::text AS areawater_part,
    NULL::text AS zcta_land_share,NULL::text AS county_land_share
    FROM zip_county_fallback f WHERE f.zip=$1 AND f.source=$2
      AND f.snapshot_id=${snapshot ? "$3" : "(SELECT snapshot_id FROM geonames_import WHERE singleton)"}
    ORDER BY f.county_fips`,
    snapshot ? [zip, source, snapshot] : [zip, source],
  );
  return rows.map((row) => ({
    ...row,
    source,
    ...(source === "geonames" ? { attribution: geonamesAttribution } : {}),
  }));
}

export const RATING_AREA_SQL = `
    SELECT r.rating_area_id,r.snapshot_id,r.source_row FROM geo_import g
    JOIN rating_area r ON r.snapshot_id=g.rating_snapshot_id AND r.state=g.state AND r.plan_year=g.plan_year
    WHERE g.state=$1 AND g.plan_year=$2 AND r.county_fips=$3
    UNION ALL
    SELECT z.rating_area_id,z.snapshot_id,z.source_row FROM geo_import g
    JOIN rating_area_zip z ON z.snapshot_id=g.rating_snapshot_id AND z.state=g.state AND z.plan_year=g.plan_year
    WHERE g.state=$1 AND g.plan_year=$2 AND z.zip_prefix=substring($4::text,1,3)`;
/** Resolve published geography without inferring a county area from ZIP3 divisions. */
export async function ratingAreaForLocation(
  db: SqlSession,
  state: string,
  year: number,
  county: string,
  zip?: string,
) {
  if (
    !/^[A-Z]{2}$/.test(state) ||
    !/^\d{5}$/.test(county) ||
    (zip !== undefined && !/^\d{5}$/.test(zip))
  )
    throw new TypeError("Invalid rating location");
  if (!STATE_FIPS[state] || !county.startsWith(STATE_FIPS[state]!))
    return { status: "unknown" as const, areas: [] };
  const { rows } = await db.query<{
    rating_area_id: string;
    snapshot_id: string;
    source_row: number;
  }>(RATING_AREA_SQL, [state, year, county, zip ?? null]);
  function ratingAreaStatus() {
    if (rows.length === 1) {
      return "available" as const;
    } else if (rows.length) {
      return "ambiguous" as const;
    } else {
      return "unknown" as const;
    }
  }
  return {
    status: ratingAreaStatus(),
    areas: rows,
  };
}
