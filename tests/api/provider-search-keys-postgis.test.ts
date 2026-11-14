import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase } from "../../src/db/database.js";
import type { Database, SqlSession } from "../../src/db/database.js";
import { setup } from "../ingest/qhp/provider-helpers.js";
import {
  buildProviderSearchKeys,
  currentSearchKeys,
} from "../../src/api/provider-search-keys.js";
import { searchProviders } from "../../src/api/provider-repository.js";
import type { ProviderSearch } from "../../src/api/provider-repository.js";

// Checks for the provider search keys. Synthetic identities and coordinates only, never
// publisher evidence. The keyed path needs PostGIS: P3I_POSTGIS_URL names a disposable server
// whose role may create databases; each suite makes and drops its own empty database.
const serverUrl = process.env.P3I_POSTGIS_URL;

async function freshDatabase(): Promise<{
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

interface Seed {
  npi: string;
  name: string;
  type: "1" | "2";
  codes: string[];
  /** Practice addresses; each holds zero or more points (several when re-geocoded). */
  addresses: [number, number][][];
}

/** Bulk-loads synthetic identities, practice addresses, attempts and points. */
async function load(db: SqlSession, seeds: Seed[]) {
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
    `INSERT INTO geocode_attempt(address_hash,source_table,source_row,normalized_address,source_snapshot_id,
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
function recording(db: SqlSession) {
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

const origin = (latitude: number, longitude: number) => ({
  latitude,
  longitude,
  method: "supplied_coordinates",
});

describe.skipIf(!serverUrl)(
  "a search that started before a slot switch never answers from the emptied slot",
  () => {
    let h: Awaited<ReturnType<typeof setup>>,
      fresh: Awaited<ReturnType<typeof freshDatabase>>;
    const q: ProviderSearch = {
      page: 1,
      origin: origin(29.7105, -95.3973),
      radius: 5,
    };
    beforeAll(async () => {
      fresh = await freshDatabase();
      h = await setup(fresh.db);
      await load(
        h.db,
        Array.from({ length: 12 }, (_, i) => ({
          npi: String(1000020000 + i),
          name: `ReviewNear${i}`,
          type: "1" as const,
          codes: ["207Q00000X"],
          addresses: [[[29.7105 + i / 1000, -95.3973]]],
        })),
      );
    });
    afterAll(async () => {
      await h?.close();
      await fresh?.drop();
    });

    it("a snapshot taken before the switch does not answer from the truncated old slot", async () => {
      const before = await searchProviders(h.db, q);
      expect(before.total).toBe(12);
      expect((await buildProviderSearchKeys(h.db)).slot).toBe("a");
      const db = fresh.db;
      // provider_search_query is STABLE: its EXECUTE reads in the snapshot of the outer
      // statement, taken before the inner statement locks the slot table. A REPEATABLE READ
      // transaction pins that snapshot the same way, deterministically.
      const during = await db.withSession!(async (pinned) => {
        await pinned.exec("BEGIN ISOLATION LEVEL REPEATABLE READ");
        try {
          await pinned.query("SELECT 1 FROM provider_search_build");
          // Switches to slot b and truncates slot a: no lock conflict, the pinned reader
          // has not touched slot a yet.
          expect(await buildProviderSearchKeys(db)).toMatchObject({
            slot: "b",
            previous_cleared: true,
          });
          expect(await currentSearchKeys(pinned)).toBe("a");
          const { seen, session } = recording(pinned);
          const answer = await searchProviders(session, q);
          return { answer, seen };
        } finally {
          await pinned.exec("COMMIT");
        }
      });
      // TRUNCATE is not MVCC-safe, so slot a looks empty to the old snapshot, yet the check in
      // the same snapshot still names it current. The answer must fall back, not be empty.
      expect(during.answer.total).toBe(12);
      expect(during.answer.providers.map((p) => p.npi)).toEqual(
        before.providers.map((p) => p.npi),
      );
    });

    it("nor from a slot that a later build emptied and refilled", async () => {
      const before = await searchProviders(h.db, q);
      const db = fresh.db;
      const current = await currentSearchKeys(db);
      const during = await db.withSession!(async (pinned) => {
        await pinned.exec("BEGIN ISOLATION LEVEL REPEATABLE READ");
        try {
          await pinned.query("SELECT 1 FROM provider_search_build");
          // After two builds the second has emptied the pinned slot, filled it again and named it.
          await buildProviderSearchKeys(db);
          expect((await buildProviderSearchKeys(db)).slot).toBe(current);
          const { seen, session } = recording(pinned);
          const answer = await searchProviders(session, q);
          return { answer, seen };
        } finally {
          await pinned.exec("COMMIT");
        }
      });
      // The refilled rows were written after the snapshot, so it reads the slot as empty.
      expect(during.answer.total).toBe(before.total);
      expect(during.seen.original).toBe(1);
      // Outside the old snapshot the refilled slot answers again.
      const after = recording(db);
      expect((await searchProviders(after.session, q)).total).toBe(
        before.total,
      );
      expect(after.seen).toEqual({ keyed: 1, original: 0 });
    });
  },
);

// Points placed on the tricky parts of the grid: cell edges (exactly on and a hair either side
// of 0.1-degree lines), interior Alaska, Hawaii, the Aleutians on both sides of the antimeridian,
// several identities at one point (distance ties), identities with several practice points and
// with re-geocoded duplicate points, and addresses with no point.
function equivalenceSeeds(): Seed[] {
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

describe.skipIf(!serverUrl)(
  "keyed and original searches give identical answers",
  () => {
    let h: Awaited<ReturnType<typeof setup>>,
      fresh: Awaited<ReturnType<typeof freshDatabase>>;
    beforeAll(async () => {
      fresh = await freshDatabase();
      h = await setup(fresh.db);
      await load(h.db, equivalenceSeeds());
      await h.db
        .query(`INSERT INTO provider_taxonomy(code,display_name,classification,version,snapshot_id)
        VALUES ('207Q00000X','Family Medicine Physician','Family Medicine','26.1','catalog')`);
    }, 120_000);
    afterAll(async () => {
      await h?.close();
      await fresh?.drop();
    });

    const searches = () => {
      const list: ProviderSearch[] = [];
      const origins: [number, number][] = [
        [30.3, -97.7],
        [30.35, -97.65],
        [64.84, -147.72],
        [21.3, -157.8],
        [51.88, 180],
        [51.88, -180],
        [51.9, 179.99],
      ];
      for (const [lat, lon] of origins)
        for (const radius of [0, 0.000001, 1, 5, 25, 120, 500])
          for (const filter of [
            {},
            { name: "reviewtie" },
            { taxonomy: "208D00000X" },
            { specialty: "family", type: "INDIVIDUAL" as const },
          ])
            for (const page of radius >= 120 ? [1, 2, 3] : [1])
              list.push({ page, origin: origin(lat, lon), radius, ...filter });
      return list;
    };

    it("for every origin, radius, filter and page", async () => {
      const list = searches();
      const original: string[] = [];
      for (const q of list)
        original.push(JSON.stringify(await searchProviders(h.db, q)));
      const built = await buildProviderSearchKeys(h.db);
      expect(built.unlocated_rows).toBe(5);
      const { seen, session } = recording(h.db);
      const differences: string[] = [];
      for (const [i, q] of list.entries()) {
        const keyed = JSON.stringify(await searchProviders(session, q));
        if (keyed !== original[i]) differences.push(JSON.stringify(q));
      }
      expect(seen).toEqual({ keyed: list.length, original: 0 });
      expect(differences).toEqual([]);
      // At least one page boundary is crossed, so pagination is exercised.
      expect(
        original.some(
          (body) => (JSON.parse(body) as { total: number }).total > 50,
        ),
      ).toBe(true);
    }, 300_000);
  },
);
