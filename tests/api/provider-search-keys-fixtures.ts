import { randomUUID } from "node:crypto";
import pg from "pg";
import { createDatabase } from "../../src/db/database.js";
import type { Database, SqlSession } from "../../src/db/database.js";

// Shared fixtures for the provider search key suites. Synthetic identities and coordinates only,
// never publisher evidence. The keyed path needs PostGIS: P3I_POSTGIS_URL names a disposable
// server whose role may create databases; each suite makes and drops its own empty database.
export const serverUrl = process.env.P3I_POSTGIS_URL;

export async function freshDatabase(): Promise<{
  db: Database;
  drop: () => Promise<void>;
}> {
  const name = `pskeys_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const admin = new pg.Client({ connectionString: serverUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const url = new URL(serverUrl!);
  url.pathname = `/${name}`;
  const db = createDatabase(url.toString());
  return {
    db,
    drop: async () => {
      const again = new pg.Client({ connectionString: serverUrl });
      await again.connect();
      await again.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await again.end();
    },
  };
}

export interface Seed {
  npi: string;
  name: string;
  type: "1" | "2";
  codes: string[];
  /** Practice addresses; each holds zero or more points (several when re-geocoded). */
  addresses: [number, number][][];
}

/** Bulk-loads synthetic identities, practice addresses, attempts and points. */
export async function load(db: SqlSession, seeds: Seed[]) {
  const providers = seeds.map((s) => [s.npi, s.type, s.name]);
  await db.query(
    `INSERT INTO npi_provider(npi,entity_type,first_name,last_name,in_scope,state_filter,data_date,snapshot_id)
    SELECT p[1],p[2],'Synthetic',p[3],true,'TX','2026-11-07','catalog'
    FROM (SELECT ARRAY[a,b,c] AS p FROM unnest($1::text[],$2::text[],$3::text[]) u(a,b,c)) x`,
    [
      providers.map((p) => p[0]),
      providers.map((p) => p[1]),
      providers.map((p) => p[2]),
    ],
  );
  const taxonomy = seeds.flatMap((s) =>
    s.codes.map((code, i) => [s.npi, String(i + 1), code]),
  );
  await db.query(
    `INSERT INTO npi_taxonomy(npi,ordinal,code,is_primary,license_state,snapshot_id)
    SELECT a,b::int,c,b='1','TX','catalog' FROM unnest($1::text[],$2::text[],$3::text[]) u(a,b,c)`,
    [
      taxonomy.map((t) => t[0]),
      taxonomy.map((t) => t[1]),
      taxonomy.map((t) => t[2]),
    ],
  );
  const addresses = seeds.flatMap((s) =>
    s.addresses.map((_, ordinal) => [s.npi, String(ordinal)]),
  );
  await db.query(
    `INSERT INTO npi_address(npi,kind,ordinal,line_1,city,state,zip5,snapshot_id)
    SELECT a,'practice',b::int,'Synthetic review address '||b,'HOUSTON','TX','77030','catalog'
    FROM unnest($1::text[],$2::text[]) u(a,b)`,
    [addresses.map((a) => a[0]), addresses.map((a) => a[1])],
  );
  const points = seeds.flatMap((s) =>
    s.addresses.flatMap((list, ordinal) =>
      list.map(([lat, lon], k) => ({
        hash: `${s.npi}-${ordinal}-${k}`,
        row: `${s.npi}:practice:${ordinal}`,
        lat,
        lon,
      })),
    ),
  );
  const columns = [
    points.map((p) => p.hash),
    points.map((p) => p.row),
    points.map((p) => p.lat),
    points.map((p) => p.lon),
  ];
  await db.query(
    `INSERT INTO geocode_match_archive(address_hash,source_table,source_row,normalized_address,source_snapshot_id,
      snapshot_id,match_status,match_quality,outcome)
    SELECT encode(sha256(convert_to(h,'UTF8')),'hex'),'npi_address',r,'synthetic review','catalog','catalog','Match','Exact','point'
    FROM unnest($1::text[],$2::text[]) u(h,r)`,
    columns.slice(0, 2),
  );
  await db.query(
    `INSERT INTO address_point(address_hash,source_table,source_row,source_snapshot_id,latitude,longitude,
      method,match_status,match_quality,snapshot_id)
    SELECT encode(sha256(convert_to(h,'UTF8')),'hex'),'npi_address',r,'catalog',la,lo,'census_geocoder','Match','Exact','catalog'
    FROM unnest($1::text[],$2::text[],$3::float8[],$4::float8[]) u(h,r,la,lo)`,
    columns,
  );
}

/** A session that reports whether a search read the keys. */
export function recording(db: SqlSession) {
  const seen = { keyed: 0, original: 0 };
  const session: SqlSession = {
    query: (sql, args, options) => {
      if (sql.includes("AS total")) {
        if (sql.includes("search_hits AS MATERIALIZED")) seen.keyed += 1;
        else seen.original += 1;
      }
      return db.query(sql, args, options);
    },
    exec: (sql) => db.exec(sql),
  };
  return { seen, session };
}

export const origin = (latitude: number, longitude: number) => ({
  latitude,
  longitude,
  method: "supplied_coordinates",
});

// Points placed on the tricky parts of the grid: cell edges (exactly on and a hair either side
// of 0.1-degree lines), interior Alaska, Hawaii, the Aleutians on both sides of the antimeridian,
// several identities at one point (distance ties), identities with several practice points and
// with re-geocoded duplicate points, and addresses with no point.
export function equivalenceSeeds(): Seed[] {
  const seeds: Seed[] = [];
  let n = 0;
  const add = (
    addresses: [number, number][][],
    name = "ReviewEdge",
    codes = ["207Q00000X"],
    type: "1" | "2" = "1",
  ) =>
    seeds.push({
      npi: String(1000030000 + n++),
      name: `${name}${n % 7}`,
      type,
      codes,
      addresses,
    });
  const anchors: [number, number][] = [
    [30.3, -97.7], // a cell corner
    [64.84, -147.72], // interior Alaska
    [21.3, -157.8], // Honolulu
    [51.88, 179.9], // Aleutians, east of the antimeridian
    [51.88, -179.9], // Aleutians, west of it
  ];
  for (const [lat, lon] of anchors) {
    for (const dLat of [-1e-9, 0, 1e-9, 0.05, -0.05, 0.1])
      for (const dLon of [-1e-9, 0, 1e-9, 0.07, -0.07]) {
        let plon = lon + dLon;
        if (plon > 180) plon -= 360;
        if (plon < -180) plon += 360;
        add(
          [[[lat + dLat, plon]]],
          n % 3 ? "ReviewEdge" : "reviewMixedCase",
          n % 4 ? ["207Q00000X"] : ["207Q00000X", "208D00000X"],
          n % 5 ? "1" : "2",
        );
      }
    // Five identities at one point: their order is by NPI.
    for (let i = 0; i < 5; i++)
      add([[[lat + 0.02, lon > 179 ? 179.95 : lon + 0.02]]], "ReviewTie");
    // One identity with a near and a far practice point, one with a re-geocoded address.
    add(
      [
        [[lat + 0.3, lon > 179 ? 179.5 : lon + 0.3]],
        [[lat + 0.001, lon > 179 ? 179.95 : lon + 0.001]],
      ],
      "ReviewMulti",
    );
    add(
      [
        [
          [lat - 0.01, lon > 179 ? 179.9 : lon - 0.01],
          [lat + 0.2, lon > 179 ? 179.9 : lon + 0.2],
        ],
      ],
      "ReviewRegeocoded",
    );
    // No point at all: counted as unlocated, never in the radius.
    add([[]], "ReviewUnlocated");
  }
  return seeds;
}
