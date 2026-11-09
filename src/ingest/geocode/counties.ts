import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { fetchToCache } from "../../fetch/index.js";
import type { SnapshotMetadata } from "../../fetch/index.js";
import type { SqlSession } from "../../db/database.js";
import { dataDirectory } from "./census.js";

export const countyDocumentation =
  "https://www.census.gov/data/developers/data-sets/TIGERweb-map-service.html";
export const geocodeStates = {
  TX: {
    fips: "48",
    counties: 254,
    south: 25,
    north: 37,
    west: -107,
    east: -93,
  },
  FL: { fips: "12", counties: 67, south: 24, north: 32, west: -88, east: -79 },
  NC: { fips: "37", counties: 100, south: 33, north: 37, west: -85, east: -75 },
} as const;
export type GeocodeState = keyof typeof geocodeStates;
export function geocodeState(state: string): GeocodeState {
  if (!Object.hasOwn(geocodeStates, state))
    throw new TypeError("Geocoding supports TX, FL and NC");
  return state as GeocodeState;
}
export const countyQuery = (state: GeocodeState) =>
  `https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/State_County/MapServer/1/query?where=STATE%3D%27${geocodeStates[state].fips}%27&outFields=GEOID%2CNAME&returnGeometry=true&outSR=4326&f=json`;
export const countyUrl = countyQuery("TX");
export interface County extends Record<string, unknown> {
  county_fips: string;
  name: string;
  south: number;
  north: number;
  west: number;
  east: number;
  rings: number[][][];
  snapshot_id: string;
}
export function insideBounds(
  latitude: number,
  longitude: number,
  county: Pick<County, "south" | "north" | "west" | "east">,
): boolean {
  return (
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    !(latitude === 0 && longitude === 0) &&
    latitude >= county.south &&
    latitude <= county.north &&
    longitude >= county.west &&
    longitude <= county.east
  );
}
export function checkCountyPoint(
  latitude: number,
  longitude: number,
  countyFips: string,
  counties: County[],
): void {
  const county = counties.find((c) => c.county_fips === countyFips);
  if (!county || !insideBounds(latitude, longitude, county))
    throw new Error(`County bounds check failed: ${countyFips}`);
}
/** Even/odd ring rule handles polygon holes and multipart counties. */
export function countyAt(
  latitude: number,
  longitude: number,
  counties: County[],
): County | undefined {
  return counties.find((county) => {
    if (!insideBounds(latitude, longitude, county)) return false;
    let inside = false;
    for (const ring of county.rings)
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [x, y] = ring[i]!,
          [xj, yj] = ring[j]!;
        if (
          y! > latitude !== yj! > latitude &&
          longitude < ((xj! - x!) * (latitude - y!)) / (yj! - y!) + x!
        )
          inside = !inside;
      }
    return inside;
  });
}
export function parseCounties(
  text: string,
  snapshot: string,
  expectedCount = 254,
  state: GeocodeState = "TX",
): County[] {
  const scope = geocodeStates[state];
  const data = JSON.parse(text) as {
    error?: unknown;
    exceededTransferLimit?: boolean;
    spatialReference?: { wkid: number };
    features?: {
      attributes: { GEOID: string; NAME: string };
      geometry: { rings: number[][][] };
    }[];
  };
  if (
    data.error ||
    data.exceededTransferLimit ||
    data.spatialReference?.wkid !== 4326 ||
    data.features?.length !== expectedCount
  )
    throw new Error(`Incomplete ${state} county geometry`);
  const result = data.features.map((f) => {
    const points = f.geometry?.rings?.flat() ?? [];
    if (
      !new RegExp(`^${scope.fips}\\d{3}$`).test(f.attributes.GEOID) ||
      !points.length ||
      points.some((p) => p.length < 2 || !p.every(Number.isFinite))
    )
      throw new Error(`Invalid ${state} county geometry`);
    const box = {
      south: Infinity,
      north: -Infinity,
      west: Infinity,
      east: -Infinity,
    };
    for (const [x, y] of points) {
      box.south = Math.min(box.south, y!);
      box.north = Math.max(box.north, y!);
      box.west = Math.min(box.west, x!);
      box.east = Math.max(box.east, x!);
    }
    if (
      box.south <= scope.south ||
      box.north >= scope.north ||
      box.west <= scope.west ||
      box.east >= scope.east
    )
      throw new Error(`Invalid ${state} county extent`);
    return {
      county_fips: f.attributes.GEOID,
      name: f.attributes.NAME,
      ...box,
      rings: f.geometry.rings,
      snapshot_id: snapshot,
    };
  });
  if (new Set(result.map((c) => c.county_fips)).size !== expectedCount)
    throw new Error("Duplicate county geometry");
  return result;
}
export async function acquireCounties(
  db: SqlSession,
  root = dataDirectory(),
  state: GeocodeState = "TX",
): Promise<County[]> {
  const countyUrl = countyQuery(state);
  const source = `census-${state.toLowerCase()}-county-bounds`;
  let sha256: string | undefined;
  try {
    const names = await readdir(join(root, "raw", source));
    const metadata = await Promise.all(
      names
        .filter((n) => n.endsWith(".meta.json"))
        .map(
          async (n) =>
            JSON.parse(
              await readFile(join(root, "raw", source, n), "utf8"),
            ) as SnapshotMetadata,
        ),
    );
    // Fetch metadata deliberately redacts query values; this dedicated source has one reviewed query.
    sha256 = metadata
      .filter(
        (m) =>
          m.source === source &&
          new URL(m.url).pathname === new URL(countyUrl).pathname,
      )
      .sort((a, b) => b.fetched_at.localeCompare(a.fetched_at))[0]?.sha256;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const f = await fetchToCache(countyUrl, {
    source,
    expectedContent: "json",
    allowHosts: ["tigerweb.geo.census.gov"],
    dataDir: root,
    expectedSha256: sha256,
    maxBytes: 64 * 1024 ** 2,
  });
  if (f.outcome === "not_modified") throw new Error("Missing county response");
  const raw = await readFile(f.path),
    m = f.metadata,
    id = `${source}:${m.sha256}`;
  if (createHash("sha256").update(raw).digest("hex") !== m.sha256)
    throw new Error("County snapshot hash mismatch");
  const counties = parseCounties(
    raw.toString("utf8"),
    id,
    geocodeStates[state].counties,
    state,
  );
  await db.query(
    `INSERT INTO source(source_id,publisher,source_kind,registry_evidence,terms_review_reference)
    VALUES($1,'US Census Bureau','geography',$2,$3) ON CONFLICT DO NOTHING`,
    [source, JSON.stringify([countyUrl]), countyDocumentation],
  );
  await db.query(
    `INSERT INTO snapshot(snapshot_id,source_id,requested_url,final_url,redirect_chain,retrieved_at,http_status,content_type,
    compressed_bytes,sha256,raw_path,schema_version,parser_version,terms_review_reference,expected_children,fetched_children,validation_state,activated_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'tigerweb-counties-2026','state-bounds-v1',$12,0,0,'ACTIVE',now()) ON CONFLICT DO NOTHING`,
    [
      id,
      source,
      m.url,
      m.final_url,
      JSON.stringify(m.redirect_chain),
      m.fetched_at,
      m.status,
      m.content_type,
      m.bytes,
      m.sha256,
      f.path,
      countyDocumentation,
    ],
  );
  for (const county of counties)
    await db.query(
      `INSERT INTO geocode_tx_county SELECT * FROM json_populate_record(NULL::geocode_tx_county,$1::json)
    ON CONFLICT(county_fips) DO NOTHING`,
      [JSON.stringify(county)],
    );
  // Resume against the same frozen county snapshot even if the publisher has subsequently changed it.
  return (
    await db.query<County>(
      "SELECT * FROM geocode_tx_county WHERE county_fips LIKE $1 ORDER BY county_fips",
      [geocodeStates[state].fips + "%"],
    )
  ).rows;
}
