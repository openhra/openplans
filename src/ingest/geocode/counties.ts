import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import {
  fetchToCache,
  readCachedText,
  sidecarNames,
  streamZipMember,
} from "../../fetch/index.js";
import type { SnapshotMetadata } from "../../fetch/index.js";
import type { SqlSession } from "../../db/database.js";
import { dataDirectory } from "./census.js";
import { readDbf, readPolygons } from "./shapefile.js";

/** National county outlines: the Census 2024 cartographic boundary file at 1:500,000. */
export const countySource = "census-county-outlines-2024";
export const countyUrl =
  "https://www2.census.gov/geo/tiger/GENZ2024/shp/cb_2024_us_county_500k.zip";
export const countyDocumentation =
  "https://www.census.gov/geographies/mapping-files/time-series/geo/cartographic-boundary.html";
const countyMember = "cb_2024_us_county_500k";
/**
 * Per-state oracle: FIPS code, the county count in the 2024 file, and a hand-entered state extent.
 * Every county outline must fall inside its state's extent plus `extentMargin` degrees. Alaska's
 * western longitude runs past -180 because Aleutian points east of the antimeridian are shifted
 * by -360 so that the state stays one continuous box (see `alignLongitude`).
 */
export const geocodeStates = {
  AL: {
    fips: "01",
    counties: 67,
    south: 30.1,
    north: 35.1,
    west: -88.5,
    east: -84.9,
  },
  AK: {
    fips: "02",
    counties: 30,
    south: 51.2,
    north: 71.5,
    west: -187.7,
    east: -129.9,
  },
  AZ: {
    fips: "04",
    counties: 15,
    south: 31.3,
    north: 37.0,
    west: -114.9,
    east: -109.0,
  },
  AR: {
    fips: "05",
    counties: 75,
    south: 33.0,
    north: 36.5,
    west: -94.7,
    east: -89.6,
  },
  CA: {
    fips: "06",
    counties: 58,
    south: 32.5,
    north: 42.0,
    west: -124.5,
    east: -114.1,
  },
  CO: {
    fips: "08",
    counties: 64,
    south: 37.0,
    north: 41.0,
    west: -109.1,
    east: -102.0,
  },
  CT: {
    fips: "09",
    counties: 9,
    south: 40.9,
    north: 42.1,
    west: -73.8,
    east: -71.8,
  },
  DE: {
    fips: "10",
    counties: 3,
    south: 38.4,
    north: 39.9,
    west: -75.8,
    east: -75.0,
  },
  DC: {
    fips: "11",
    counties: 1,
    south: 38.79,
    north: 39.0,
    west: -77.12,
    east: -76.9,
  },
  FL: {
    fips: "12",
    counties: 67,
    south: 24.4,
    north: 31.0,
    west: -87.7,
    east: -79.9,
  },
  GA: {
    fips: "13",
    counties: 159,
    south: 30.3,
    north: 35.0,
    west: -85.7,
    east: -80.8,
  },
  HI: {
    fips: "15",
    counties: 5,
    south: 18.9,
    north: 28.5,
    west: -178.5,
    east: -154.8,
  },
  ID: {
    fips: "16",
    counties: 44,
    south: 42.0,
    north: 49.0,
    west: -117.3,
    east: -111.0,
  },
  IL: {
    fips: "17",
    counties: 102,
    south: 36.97,
    north: 42.5,
    west: -91.6,
    east: -87.0,
  },
  IN: {
    fips: "18",
    counties: 92,
    south: 37.77,
    north: 41.76,
    west: -88.1,
    east: -84.78,
  },
  IA: {
    fips: "19",
    counties: 99,
    south: 40.37,
    north: 43.5,
    west: -96.64,
    east: -90.14,
  },
  KS: {
    fips: "20",
    counties: 105,
    south: 36.99,
    north: 40.0,
    west: -102.05,
    east: -94.59,
  },
  KY: {
    fips: "21",
    counties: 120,
    south: 36.49,
    north: 39.15,
    west: -89.57,
    east: -81.96,
  },
  LA: {
    fips: "22",
    counties: 64,
    south: 28.9,
    north: 33.02,
    west: -94.04,
    east: -88.8,
  },
  ME: {
    fips: "23",
    counties: 16,
    south: 42.97,
    north: 47.46,
    west: -71.08,
    east: -66.95,
  },
  MD: {
    fips: "24",
    counties: 24,
    south: 37.9,
    north: 39.72,
    west: -79.49,
    east: -75.05,
  },
  MA: {
    fips: "25",
    counties: 14,
    south: 41.24,
    north: 42.89,
    west: -73.51,
    east: -69.93,
  },
  MI: {
    fips: "26",
    counties: 83,
    south: 41.7,
    north: 48.3,
    west: -90.42,
    east: -82.4,
  },
  MN: {
    fips: "27",
    counties: 87,
    south: 43.5,
    north: 49.38,
    west: -97.24,
    east: -89.49,
  },
  MS: {
    fips: "28",
    counties: 82,
    south: 30.17,
    north: 35.0,
    west: -91.66,
    east: -88.1,
  },
  MO: {
    fips: "29",
    counties: 115,
    south: 35.99,
    north: 40.61,
    west: -95.77,
    east: -89.1,
  },
  MT: {
    fips: "30",
    counties: 56,
    south: 44.36,
    north: 49.0,
    west: -116.05,
    east: -104.04,
  },
  NE: {
    fips: "31",
    counties: 93,
    south: 40.0,
    north: 43.0,
    west: -104.05,
    east: -95.31,
  },
  NV: {
    fips: "32",
    counties: 17,
    south: 35.0,
    north: 42.0,
    west: -120.0,
    east: -114.04,
  },
  NH: {
    fips: "33",
    counties: 10,
    south: 42.7,
    north: 45.31,
    west: -72.56,
    east: -70.6,
  },
  NJ: {
    fips: "34",
    counties: 21,
    south: 38.93,
    north: 41.36,
    west: -75.56,
    east: -73.89,
  },
  NM: {
    fips: "35",
    counties: 33,
    south: 31.33,
    north: 37.0,
    west: -109.05,
    east: -103.0,
  },
  NY: {
    fips: "36",
    counties: 62,
    south: 40.5,
    north: 45.02,
    west: -79.76,
    east: -71.86,
  },
  NC: {
    fips: "37",
    counties: 100,
    south: 33.8,
    north: 36.59,
    west: -84.32,
    east: -75.46,
  },
  ND: {
    fips: "38",
    counties: 53,
    south: 45.93,
    north: 49.0,
    west: -104.05,
    east: -96.55,
  },
  OH: {
    fips: "39",
    counties: 88,
    south: 38.4,
    north: 41.98,
    west: -84.82,
    east: -80.52,
  },
  OK: {
    fips: "40",
    counties: 77,
    south: 33.62,
    north: 37.0,
    west: -103.0,
    east: -94.43,
  },
  OR: {
    fips: "41",
    counties: 36,
    south: 41.99,
    north: 46.29,
    west: -124.57,
    east: -116.46,
  },
  PA: {
    fips: "42",
    counties: 67,
    south: 39.72,
    north: 42.27,
    west: -80.52,
    east: -74.69,
  },
  RI: {
    fips: "44",
    counties: 5,
    south: 41.15,
    north: 42.02,
    west: -71.9,
    east: -71.12,
  },
  SC: {
    fips: "45",
    counties: 46,
    south: 32.03,
    north: 35.22,
    west: -83.35,
    east: -78.54,
  },
  SD: {
    fips: "46",
    counties: 66,
    south: 42.48,
    north: 45.95,
    west: -104.06,
    east: -96.44,
  },
  TN: {
    fips: "47",
    counties: 95,
    south: 34.98,
    north: 36.68,
    west: -90.31,
    east: -81.65,
  },
  TX: {
    fips: "48",
    counties: 254,
    south: 25.84,
    north: 36.5,
    west: -106.65,
    east: -93.51,
  },
  UT: {
    fips: "49",
    counties: 29,
    south: 37.0,
    north: 42.0,
    west: -114.05,
    east: -109.04,
  },
  VT: {
    fips: "50",
    counties: 14,
    south: 42.73,
    north: 45.02,
    west: -73.44,
    east: -71.46,
  },
  VA: {
    fips: "51",
    counties: 133,
    south: 36.54,
    north: 39.47,
    west: -83.68,
    east: -75.24,
  },
  WA: {
    fips: "53",
    counties: 39,
    south: 45.54,
    north: 49.0,
    west: -124.85,
    east: -116.92,
  },
  WV: {
    fips: "54",
    counties: 55,
    south: 37.2,
    north: 40.64,
    west: -82.64,
    east: -77.72,
  },
  WI: {
    fips: "55",
    counties: 72,
    south: 42.49,
    north: 47.31,
    west: -92.89,
    east: -86.25,
  },
  WY: {
    fips: "56",
    counties: 23,
    south: 41.0,
    north: 45.0,
    west: -111.06,
    east: -104.05,
  },
} as const;
export const extentMargin = 0.5;
export type GeocodeState = keyof typeof geocodeStates;
export const geocodeStateCodes = Object.keys(geocodeStates) as GeocodeState[];
export function geocodeState(state: string): GeocodeState {
  if (!Object.hasOwn(geocodeStates, state))
    throw new TypeError("Geocoding supports the 50 states and DC");
  return state as GeocodeState;
}
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
/**
 * Alaska's Aleutians West outline crosses the antimeridian. Its eastern-hemisphere vertices are
 * stored shifted by -360, so a query point east of 180° is shifted the same way before it is
 * tested against that county. Every other county keeps ordinary longitudes.
 */
export function alignLongitude(
  longitude: number,
  county: Pick<County, "west">,
): number {
  return county.west < -180 && longitude > 0 ? longitude - 360 : longitude;
}
export function insideBounds(
  latitude: number,
  longitude: number,
  county: Pick<County, "south" | "north" | "west" | "east">,
): boolean {
  const x = alignLongitude(longitude, county);
  return (
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    !(latitude === 0 && longitude === 0) &&
    latitude >= county.south &&
    latitude <= county.north &&
    x >= county.west &&
    x <= county.east
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
    const x = alignLongitude(longitude, county);
    let inside = false;
    for (const ring of county.rings)
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i]!,
          [xj, yj] = ring[j]!;
        if (
          yi! > latitude !== yj! > latitude &&
          x < ((xj! - xi!) * (latitude - yi!)) / (yj! - yi!) + xi!
        )
          inside = !inside;
      }
    return inside;
  });
}
export interface CountyFeature {
  GEOID: string;
  NAME: string;
  rings: number[][][];
}
/** Validates one state's outlines against the per-state oracle and computes each county's box. */
export function buildCounties(
  features: CountyFeature[],
  snapshot: string,
  expectedCount: number = 254,
  state: GeocodeState = "TX",
): County[] {
  const scope = geocodeStates[state];
  if (features.length !== expectedCount)
    throw new Error(`Incomplete ${state} county geometry`);
  const result = features.map((f) => {
    const points = f.rings.flat();
    if (
      !new RegExp(`^${scope.fips}\\d{3}$`).test(f.GEOID) ||
      !f.NAME ||
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
      box.south < scope.south - extentMargin ||
      box.north > scope.north + extentMargin ||
      box.west < scope.west - extentMargin ||
      box.east > scope.east + extentMargin ||
      box.south >= box.north ||
      box.west >= box.east
    )
      throw new Error(`Invalid ${state} county extent`);
    return {
      county_fips: f.GEOID,
      name: f.NAME,
      ...box,
      rings: f.rings,
      snapshot_id: snapshot,
    };
  });
  if (new Set(result.map((c) => c.county_fips)).size !== expectedCount)
    throw new Error("Duplicate county geometry");
  return result;
}
/** JSON form of `CountyFeature[]` used by offline fixtures. */
export function parseCounties(
  text: string,
  snapshot: string,
  expectedCount = 254,
  state: GeocodeState = "TX",
): County[] {
  const data = JSON.parse(text) as { features?: CountyFeature[] };
  if (!Array.isArray(data.features))
    throw new Error(`Incomplete ${state} county geometry`);
  return buildCounties(data.features, snapshot, expectedCount, state);
}
const memberLimits = {
  maxMembers: 16,
  maxUncompressedBytes: 128 * 1024 ** 2,
};
async function member(path: string, name: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of streamZipMember(path, name, memberLimits))
    chunks.push(chunk);
  return Buffer.concat(chunks);
}
/**
 * Reads every state's county outlines from the national boundary archive. Territories are left
 * out. Alaska vertices east of the antimeridian are shifted by -360 (see `alignLongitude`).
 */
export async function readCountyArchive(
  path: string,
): Promise<Map<string, CountyFeature[]>> {
  const shapes = readPolygons(await member(path, `${countyMember}.shp`)),
    rows = readDbf(await member(path, `${countyMember}.dbf`));
  if (shapes.length !== rows.length)
    throw new Error("County outline and attribute counts differ");
  const fips = new Set<string>(Object.values(geocodeStates).map((s) => s.fips)),
    byState = new Map<string, CountyFeature[]>();
  rows.forEach((row, i) => {
    const state = row.STATEFP ?? "";
    if (!fips.has(state)) return;
    if (row.GEOID !== state + row.COUNTYFP)
      throw new Error("County outline identifier mismatch");
    const rings = shapes[i]!.rings.map((ring) =>
      ring.map(([x, y]) => [state === "02" && x > 0 ? x - 360 : x, y]),
    );
    const list = byState.get(state) ?? [];
    list.push({ GEOID: row.GEOID!, NAME: row.NAME ?? "", rings });
    byState.set(state, list);
  });
  return byState;
}
export async function cachedSha(root: string): Promise<string | undefined> {
  try {
    // Sidecars are read through the fetch cache's store, local or remote.
    const names = await sidecarNames(root, countySource);
    const metadata = await Promise.all(
      names.map(
        async (n) =>
          JSON.parse(
            await readCachedText(root, countySource, n),
          ) as SnapshotMetadata,
      ),
    );
    return metadata
      .filter((m) => m.source === countySource && m.url === countyUrl)
      .sort((a, b) => b.fetched_at.localeCompare(a.fetched_at))[0]?.sha256;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
/**
 * Loads one state's county outlines from the cached national file, downloading it once through
 * fetch admission when the cache has no copy. Rows already loaded from this file stay frozen so a
 * resumed run keeps the outlines it started with; rows from any earlier outline source are
 * replaced.
 */
export async function acquireCounties(
  db: SqlSession,
  root = dataDirectory(),
  state: GeocodeState = "TX",
): Promise<County[]> {
  const f = await fetchToCache(countyUrl, {
    source: countySource,
    expectedContent: "zip",
    allowHosts: ["www2.census.gov"],
    dataDir: root,
    expectedSha256: await cachedSha(root),
    maxBytes: 48 * 1024 ** 2,
    zipLimits: memberLimits,
  });
  if (f.outcome === "not_modified") throw new Error("Missing county response");
  const raw = await readFile(f.path),
    m = f.metadata,
    id = `${countySource}:${m.sha256}`;
  if (createHash("sha256").update(raw).digest("hex") !== m.sha256)
    throw new Error("County snapshot hash mismatch");
  const scope = geocodeStates[state];
  const counties = buildCounties(
    (await readCountyArchive(f.path)).get(scope.fips) ?? [],
    id,
    scope.counties,
    state,
  );
  await db.query(
    `INSERT INTO source(source_id,publisher,source_kind,registry_evidence,terms_review_reference)
    VALUES($1,'US Census Bureau','geography',$2,$3) ON CONFLICT DO NOTHING`,
    [countySource, JSON.stringify([countyUrl]), countyDocumentation],
  );
  await db.query(
    `INSERT INTO snapshot(snapshot_id,source_id,requested_url,final_url,redirect_chain,retrieved_at,http_status,content_type,
    compressed_bytes,sha256,raw_path,schema_version,parser_version,terms_review_reference,expected_children,fetched_children,validation_state,activated_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'cb-2024-county-500k','shapefile-v1',$12,0,0,'ACTIVE',now()) ON CONFLICT DO NOTHING`,
    [
      id,
      countySource,
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
    ON CONFLICT(county_fips) DO UPDATE SET name=excluded.name,south=excluded.south,north=excluded.north,
    west=excluded.west,east=excluded.east,rings=excluded.rings,snapshot_id=excluded.snapshot_id
    WHERE geocode_tx_county.snapshot_id NOT LIKE $2`,
      [JSON.stringify(county), `${countySource}:%`],
    );
  return (
    await db.query<County>(
      "SELECT * FROM geocode_tx_county WHERE county_fips LIKE $1 ORDER BY county_fips",
      [scope.fips + "%"],
    )
  ).rows;
}
