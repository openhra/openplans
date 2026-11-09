import type { SqlSession } from "../../db/database.js";
export const metresPerMile = 1609.344;
// PostGIS ST_DWithin(..., false) uses the WGS84 mean-radius sphere.
const earthRadiusMetres = 6371008.771415059;
function coordinates(lat: number, lon: number): void {
  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lon) ||
    Math.abs(lat) > 90 ||
    Math.abs(lon) > 180
  )
    throw new TypeError("Invalid latitude/longitude");
}
export function haversineMiles(
  lat: number,
  lon: number,
  otherLat: number,
  otherLon: number,
): number {
  coordinates(lat, lon);
  coordinates(otherLat, otherLon);
  const r = Math.PI / 180,
    dLat = (otherLat - lat) * r,
    dLon = (otherLon - lon) * r;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat * r) * Math.cos(otherLat * r) * Math.sin(dLon / 2) ** 2;
  return (
    (2 *
      earthRadiusMetres *
      Math.asin(Math.sqrt(Math.max(0, Math.min(1, a))))) /
    metresPerMile
  );
}
export interface Centroid extends Record<string, unknown> {
  zip: string;
  latitude: number;
  longitude: number;
  method: "zcta_centroid";
  snapshot_id: string;
}
export interface RadiusPoint extends Record<string, unknown> {
  address_hash: string;
  source_table: string;
  source_row: string;
  source_snapshot_id: string;
  latitude: number;
  longitude: number;
  method: "census_geocoder" | "zcta_centroid";
  match_status: string;
  match_quality: string | null;
  snapshot_id: string;
  centroid_snapshot_id: string | null;
  distance_miles: number;
}
export async function zipCentroid(
  db: SqlSession,
  zip: string,
): Promise<Centroid | null> {
  if (!/^\d{5}$/.test(zip)) throw new TypeError("ZIP must have five digits");
  return (
    (
      await db.query<Centroid>(
        `SELECT z.zcta AS zip,z.latitude::float8,z.longitude::float8,
    'zcta_centroid'::text AS method,z.snapshot_id FROM zcta_centroid z
    JOIN geo_import g ON g.centroid_snapshot_id=z.snapshot_id
    WHERE z.zcta=$1 ORDER BY g.imported_at DESC,g.plan_year DESC LIMIT 1`,
        [zip],
      )
    ).rows[0] ?? null
  );
}
export function createGeoRepository(db: SqlSession) {
  return {
    zipCentroid: (zip: string) => zipCentroid(db, zip),
    pointsWithinRadius: (lat: number, lon: number, miles: number) =>
      pointsWithinRadius(db, lat, lon, miles),
  };
}
export async function pointsWithinRadius(
  db: SqlSession,
  lat: number,
  lon: number,
  miles: number,
  source: "npi_address" | "qhp_provider_address" = "npi_address",
): Promise<RadiusPoint[]> {
  coordinates(lat, lon);
  if (!Number.isFinite(miles) || miles < 0)
    throw new TypeError("Radius must be nonnegative miles");
  const postgis =
    (
      await db.query(`SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema()
    AND table_name='address_point' AND column_name='point'`)
    ).rows.length > 0;
  const columns = `p.address_hash,p.source_table,p.source_row,p.source_snapshot_id,p.latitude,p.longitude,
    p.method,p.match_status,p.match_quality,p.snapshot_id,p.centroid_snapshot_id`;
  // Restrict to the current source row and snapshot: historic points never locate a changed address.
  const current =
    source === "npi_address"
      ? `FROM address_point p JOIN npi_address a ON p.source_table='npi_address'
    AND p.source_row=a.npi||':'||a.kind||':'||a.ordinal::text AND p.source_snapshot_id=a.snapshot_id
    WHERE a.kind='practice'`
      : `FROM address_point p JOIN qhp_provider_address a
    ON p.source_table='qhp_provider_address' AND p.source_row=a.snapshot_id||':'||a.record_id||':'||a.address_index::text
      AND p.source_snapshot_id=a.snapshot_id
    JOIN provider_shard s ON s.snapshot_id=a.snapshot_id
    JOIN provider_active_set active ON active.snapshot_id=s.source_set_id WHERE true`;
  let rows: RadiusPoint[];
  if (postgis) {
    rows = (
      await db.query<RadiusPoint>(
        `SELECT ${columns},
      ST_Distance(p.point,ST_SetSRID(ST_MakePoint($2,$1),4326)::geography,false)/$4 AS distance_miles
      ${current} AND ST_DWithin(p.point,ST_SetSRID(ST_MakePoint($2,$1),4326)::geography,$3*$4,false)
      ORDER BY distance_miles,p.source_row`,
        [lat, lon, miles, metresPerMile],
      )
    ).rows;
  } else {
    rows = (
      await db.query<RadiusPoint>(
        `SELECT ${columns},0::float8 AS distance_miles ${current}`,
      )
    ).rows
      .map((p) => ({
        ...p,
        distance_miles: haversineMiles(lat, lon, p.latitude, p.longitude),
      }))
      .filter((p) => p.distance_miles <= miles)
      .sort(
        (a, b) =>
          a.distance_miles - b.distance_miles ||
          a.source_row.localeCompare(b.source_row),
      );
  }
  return rows;
}
