import { Hono } from "hono";
import { compatRoutes } from "../../src/compat/v1/index.js";
import { providerCompatRoutes } from "../../src/compat/v1/providers.js";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SqlSession } from "../../src/db/database.js";
import { setup } from "../ingest/qhp/provider-helpers.js";
import {
  buildProviderSearchKeys,
  currentSearchKeys,
} from "../../src/api/provider-search-keys.js";
import * as repository from "../../src/api/provider-repository.js";
import type {
  ProviderLocationPage,
  ProviderSearch,
} from "../../src/api/provider-repository.js";
import { storeOperatorPoints } from "../../src/ingest/geocode/operator-store.js";
import { importMutant, withMutantFile } from "../mutant-file.js";
import { replaceSyntax } from "../source-mutation.js";
import {
  equivalenceSeeds,
  freshDatabase,
  load,
  origin,
  recording,
  serverUrl,
} from "./provider-search-keys-fixtures.js";

// Compatibility location pages and searches with operator geocoder points read the search keys.
// Each answer must equal the original path's byte for byte. Synthetic data only.

type Repository = Pick<
  typeof repository,
  "searchProviders" | "searchProviderLocations" | "searchUnlocatedInState"
>;
const source = new URL("../../src/api/provider-repository.ts", import.meta.url);

/** Plants a mutated provider repository and hands its search functions to `use`. */
async function withMutant<T>(
  before: string,
  after: string,
  use: (mutant: Repository) => Promise<T>,
) {
  const mutated = replaceSyntax(await readFile(source, "utf8"), before, after);
  return withMutantFile(source, mutated, async (file) =>
    use(
      await importMutant<Repository>(
        file,
        "searchProviders",
        "searchProviderLocations",
        "searchUnlocatedInState",
      ),
    ),
  );
}

const ORIGINS: [number, number][] = [
  [30.3, -97.7], // a cell corner, Texas
  [30.35, -97.65],
  [64.84, -147.72], // interior Alaska
  [21.3, -157.8], // Honolulu
  [51.88, 180], // on the antimeridian
  [51.88, -180],
  [51.9, 179.99],
];
const RADII = [0, 0.000001, 1, 5, 25, 120, 500];
const FILTERS: Partial<ProviderSearch>[] = [
  {},
  { name: "reviewtie" },
  { taxonomy: "208D00000X" },
  { specialty: "family", type: "INDIVIDUAL" },
];

interface LocationSearch {
  q: ProviderSearch;
  page: ProviderLocationPage;
}
function locationSearches(origins = ORIGINS): LocationSearch[] {
  const list: LocationSearch[] = [];
  for (const [lat, lon] of origins)
    for (const radius of RADII)
      for (const filter of FILTERS) {
        const pages: ProviderLocationPage[] = [{ offset: 0, size: 10 }];
        if (radius >= 25)
          pages.push(
            { offset: 0, size: 1000 },
            { offset: 45, size: 10, reverse: true },
            { offset: 5000, size: 10 },
          );
        for (const page of pages)
          list.push({
            q: { page: 1, origin: origin(lat, lon), radius, ...filter },
            page,
          });
      }
  return list;
}
function nativeSearches(origins = ORIGINS): ProviderSearch[] {
  const list: ProviderSearch[] = [];
  for (const [lat, lon] of origins)
    for (const radius of RADII)
      for (const filter of FILTERS)
        for (const page of radius >= 120 ? [1, 2, 3] : [1])
          list.push({ page, origin: origin(lat, lon), radius, ...filter });
  return list;
}

/** Every answer of one repository, as text, for byte comparison. */
async function answers(
  db: SqlSession,
  api: Repository,
  locations: LocationSearch[],
  native: ProviderSearch[] = [],
) {
  const out: string[] = [];
  for (const { q, page } of locations)
    out.push(JSON.stringify(await api.searchProviderLocations(db, q, page)));
  for (const q of native)
    out.push(JSON.stringify(await api.searchProviders(db, q)));
  return out;
}
/** Location pages read the keys only with an identity filter. */
const filtered = (list: LocationSearch[]) =>
  list.filter(({ q }) => q.taxonomy || q.specialty || q.name || q.type).length;
const differing = (a: string[], b: string[]) =>
  a.flatMap((body, i) => (body === b[i] ? [] : [i]));

/** Location-page features the plain equivalence seeds lack, made from those seeds. */
async function locationFeatures(db: SqlSession) {
  // Two practice addresses of one identity that normalize to the same text: one location.
  await db.query(`UPDATE npi_address a SET line_1='  synthetic   REVIEW address 0 '
    WHERE a.ordinal=1 AND a.npi IN (SELECT npi FROM npi_provider WHERE last_name LIKE 'ReviewMulti%')`);
  // ZIP-centroid points make a location approximate.
  await db.query(`UPDATE address_point SET method='zcta_centroid',centroid_snapshot_id='catalog',match_quality=NULL
    WHERE source_row IN (SELECT a.npi||':practice:'||a.ordinal FROM npi_address a
      WHERE right(a.npi,1) IN ('3','8') AND a.ordinal=0)`);
  // A primary taxonomy code without a published name.
  await db.query(`UPDATE npi_taxonomy SET code='208D00000X'
    WHERE ordinal=1 AND right(npi,2) IN ('11','47','90')`);
}

describe.skipIf(!serverUrl)(
  "compatibility location pages read the search keys",
  () => {
    let h: Awaited<ReturnType<typeof setup>>,
      fresh: Awaited<ReturnType<typeof freshDatabase>>;
    const list = locationSearches();
    let original: string[] = [];
    beforeAll(async () => {
      fresh = await freshDatabase();
      h = await setup(fresh.db);
      await load(h.db, equivalenceSeeds());
      await h.db
        .query(`INSERT INTO provider_taxonomy(code,display_name,classification,version,snapshot_id)
        VALUES ('207Q00000X','Family Medicine Physician','Family Medicine','26.1','catalog')`);
      await locationFeatures(h.db);
      original = await answers(h.db, repository, list);
    }, 300_000);
    afterAll(async () => {
      await h?.close();
      await fresh?.drop();
    });

    it("the fixture reaches every location-page feature", () => {
      const bodies = original.map(
        (body) =>
          JSON.parse(body) as {
            total: number;
            unlocated: boolean;
            approximate: boolean;
            taxonomy_unknown: boolean;
            providers: unknown[];
          },
      );
      expect(bodies.some((b) => b.total > 50)).toBe(true);
      expect(bodies.some((b) => b.total > 0 && b.providers.length === 0)).toBe(
        true,
      );
      for (const flag of [
        "unlocated",
        "approximate",
        "taxonomy_unknown",
      ] as const)
        expect(new Set(bodies.map((b) => b[flag]))).toEqual(
          new Set([true, false]),
        );
    });

    it("gives byte-identical pages for every origin, radius, filter and page", async () => {
      expect((await buildProviderSearchKeys(h.db)).slot).toBe("a");
      const { seen, session } = recording(h.db);
      const keyed = await answers(session, repository, list);
      expect(seen).toEqual({
        keyed: filtered(list),
        original: list.length - filtered(list),
      });
      expect(differing(keyed, original).map((i) => list[i])).toEqual([]);
    }, 300_000);

    it("fails when a location page probes only one page of identities (planted mutant)", async () => {
      expect(await currentSearchKeys(h.db)).toBe("a");
      await withMutant(
        'const probed = locationPage ? `search_hits WHERE ${fewHits}` : "page_keys";',
        'const probed = locationPage ? "(SELECT * FROM search_hits ORDER BY distance_miles,record_id LIMIT 50) h" : "page_keys";',
        async (mutant) => {
          const { seen, session } = recording(h.db);
          const keyed = await answers(session, mutant, list);
          expect(seen.keyed).toBeGreaterThan(0);
          expect(differing(keyed, original)).not.toEqual([]);
        },
      );
    }, 300_000);

    it("takes the original path once the keys are stale, also inside an older snapshot", async () => {
      const some = list.filter((_, i) => i % 17 === 0);
      const expected = some.map((s) => original[list.indexOf(s)] ?? "missing");
      // A snapshot pinned before the next build switches slots reads the emptied slot.
      const db = fresh.db;
      const pinned = await db.withSession!(async (session) => {
        await session.exec("BEGIN ISOLATION LEVEL REPEATABLE READ");
        try {
          await session.query("SELECT 1 FROM provider_search_build");
          expect(await buildProviderSearchKeys(db)).toMatchObject({
            slot: "b",
            previous_cleared: true,
          });
          const record = recording(session);
          return {
            bodies: await answers(record.session, repository, some),
            seen: record.seen,
          };
        } finally {
          await session.exec("COMMIT");
        }
      });
      expect(pinned.seen.original).toBe(some.length);
      expect(pinned.bodies).toEqual(expected);
      // A write to a source table retires the keys.
      await h.db.query(
        "UPDATE npi_provider SET credential=credential WHERE npi=(SELECT min(npi) FROM npi_provider)",
      );
      expect(await currentSearchKeys(h.db)).toBeUndefined();
      const stale = recording(h.db);
      expect(await answers(stale.session, repository, some)).toEqual(expected);
      expect(stale.seen).toEqual({ keyed: 0, original: some.length });
    }, 300_000);
  },
);

describe.skipIf(!serverUrl)(
  "a location page with many matching keys rejects an unbounded fallback",
  () => {
    let h: Awaited<ReturnType<typeof setup>>,
      fresh: Awaited<ReturnType<typeof freshDatabase>>;
    const at = (
      name?: string,
      page: ProviderLocationPage = { offset: 0, size: 10 },
    ) => ({
      q: {
        page: 1,
        origin: origin(40, -100),
        radius: 5,
        ...(name ? { name } : {}),
      },
      page,
    });
    // 2,100 identities match "reviewcrowd"; 1,111 of them match "reviewcrowd1".
    const list = [
      at("reviewcrowd"),
      at("reviewcrowd", { offset: 2050, size: 100, reverse: true }),
      at("reviewcrowd1"),
      at("reviewcrowd1", { offset: 0, size: 1000 }),
      at("reviewcrowd1", { offset: 1100, size: 10, reverse: true }),
      at(),
    ];
    beforeAll(async () => {
      fresh = await freshDatabase();
      h = await setup(fresh.db);
      await load(
        h.db,
        Array.from({ length: 2100 }, (_, i) => ({
          npi: String(1000060000 + i),
          name: `ReviewCrowd${i}`,
          type: "1" as const,
          codes: i < 2000 ? ["207Q00000X", "208D00000X"] : ["207Q00000X"],
          addresses: [[[40 + (i % 50) / 1e4, -100 + Math.floor(i / 50) / 1e4]]],
        })),
      );
      await h.db
        .exec(`INSERT INTO zcta_centroid(zcta,latitude,longitude,snapshot_id,source_row)
        VALUES ('77030',40,-100,'catalog',2);
        INSERT INTO geo_import(state,plan_year,relationship_snapshot_id,centroid_snapshot_id,rating_snapshot_id)
        VALUES ('TX',2026,'catalog','catalog','catalog');
        INSERT INTO provider_taxonomy(code,display_name,classification,version,snapshot_id)
        VALUES ('207Q00000X','Synthetic family medicine','Synthetic','test','catalog')`);
    }, 300_000);
    afterAll(async () => {
      await h?.close();
      await fresh?.drop();
    });

    it("keeps exact pages below the limit and rejects broad filters before reading addresses", async () => {
      const original = await answers(h.db, repository, list);
      expect(
        original.map((b) => (JSON.parse(b) as { total: number }).total),
      ).toEqual([2100, 2100, 1111, 1111, 1111, 2100]);
      await buildProviderSearchKeys(h.db);
      for (const search of list.slice(0, 2)) {
        const { seen, session } = recording(h.db);
        await expect(answers(session, repository, [search])).rejects.toThrow(
          repository.ProviderLocationLimitError,
        );
        expect(seen).toEqual({ keyed: 0, original: 0 });
      }
      const { seen, session } = recording(h.db);
      expect(await answers(session, repository, list.slice(2))).toEqual(
        original.slice(2),
      );
      expect(seen).toEqual({ keyed: 3, original: 1 });
      // Exactly 2,000 key rows remains a supported, exact search.
      expect(
        (
          await repository.searchProviderLocations(
            h.db,
            { ...at().q, taxonomy: "208D00000X" },
            at().page,
          )
        ).total,
      ).toBe(2000);
    }, 300_000);

    async function bounded(api: Repository, slot: "a" | "b") {
      const captured: { sql: string; args: unknown[] }[] = [];
      const session: SqlSession = {
        exec: (sql) => h.db.exec(sql),
        query: (sql, args, options) => {
          const match = /\$provider_query\$([\s\S]*)\$provider_query\$/.exec(
            sql,
          );
          if (match) captured.push({ sql: match[1]!, args: args ?? [] });
          return h.db.query(sql, args, options);
        },
      };
      await expect(
        api.searchProviderLocations(
          session,
          { ...at().q, taxonomy: "207Q00000X" },
          at().page,
        ),
      ).rejects.toThrow(
        "Use a smaller radius or add a more specific search term.",
      );
      expect(captured).toHaveLength(1);
      const probe = captured[0]!;
      expect(probe.sql).toContain("LIMIT 2001");
      expect(probe.sql).not.toMatch(
        /FROM npi_address|FROM address_point|wire_keys/,
      );
      const result = await h.db.transaction(async (tx) => {
        await tx.exec("SET LOCAL enable_seqscan=off");
        return tx.query<{ "QUERY PLAN": unknown }>(
          "EXPLAIN (ANALYZE, FORMAT JSON) " + probe.sql,
          probe.args,
        );
      });
      const plan = JSON.stringify(result.rows[0]!["QUERY PLAN"]);
      expect(plan).toContain(`provider_search_key_${slot}_cell`);
      expect(plan).toContain('"Node Type":"Limit"');
      expect(plan).toContain('"Actual Rows":2001');
    }

    it("bounds taxonomy probes to LIMIT+1 in both slots and never runs the fallback", async () => {
      await bounded(repository, "a");
      await buildProviderSearchKeys(h.db);
      await bounded(repository, "b");
    });

    it("rejects a missing bound in a disposable mutant", async () => {
      const probe = (await readFile(source, "utf8")).match(
        /const probe = `SELECT [\s\S]*?LIMIT \$\{KEYED_LOCATION_IDENTITIES \+ 1\}\) k`;/,
      )?.[0];
      expect(probe).toBeDefined();
      await withMutant(
        probe!,
        probe!.replace("LIMIT ${KEYED_LOCATION_IDENTITIES + 1}", ""),
        async (mutant) => {
          await expect(bounded(mutant, "b")).rejects.toThrow();
        },
      );
    });

    it("rejects a disabled cutoff in a disposable mutant", async () => {
      await withMutant(
        "rows[0]!.result.key_rows > KEYED_LOCATION_IDENTITIES",
        "rows[0]!.result.key_rows < 0",
        async (mutant) => {
          await expect(bounded(mutant, "b")).rejects.toThrow();
        },
      );
    });

    it("returns an actionable HTTP 422 for taxonomy codes, specialty names and later pages", async () => {
      const app = compatRoutes(h.db, { compatKey: "synthetic-taxonomy-token" });
      for (const filter of [
        { taxonomy: "207Q00000X" },
        { specialty: "207Q00000X" },
        { specialty: "family" },
      ]) {
        for (const page of [1, 20]) {
          const response = await app.request("/compat/v1/providers/search", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Api-Key": "synthetic-taxonomy-token",
            },
            body: JSON.stringify({
              zip_code: "77030",
              radius: 5,
              per_page: 10,
              page,
              ...filter,
            }),
          });
          expect(response.status).toBe(422);
          expect(await response.json()).toEqual({
            error: {
              code: "provider_search_too_broad",
              message:
                "Use a smaller radius or add a more specific search term.",
            },
          });
        }
      }
    });

    it("does not reject from stale revisions or an emptied slot", async () => {
      for (const change of [
        "UPDATE npi_address SET city=city",
        "TRUNCATE provider_search_key_b",
      ]) {
        let changed = false;
        const rollback = new Error("rollback stale-key control");
        await expect(
          h.db.transaction(async (tx) => {
            // Keep the source change and the query on this transaction's session.
            const local: SqlSession = {
              exec: (sql) => tx.exec(sql),
              query: async (sql, args, options) => {
                if (!changed && sql.includes("AS key_rows")) {
                  changed = true;
                  await tx.exec(change);
                }
                return tx.query(sql, args, options);
              },
            };
            expect(
              (
                await repository.searchProviderLocations(
                  local,
                  { ...at().q, taxonomy: "207Q00000X" },
                  at().page,
                )
              ).total,
            ).toBe(2100);
            expect(changed).toBe(true);
            throw rollback;
          }),
        ).rejects.toBe(rollback);
      }
    }, 300_000);
  },
);

/** A Travis County stand-in: operator points must fall inside a stored Texas county. */
const COUNTY = {
  county_fips: "48453",
  name: "Synthetic Travis rectangle",
  south: 29.5,
  north: 31,
  west: -98.5,
  east: -97,
  rings: [
    [
      [-98.5, 29.5],
      [-97, 29.5],
      [-97, 31],
      [-98.5, 31],
      [-98.5, 29.5],
    ],
  ],
  snapshot_id: "catalog",
};

/**
 * Addresses whose effective points operator points change, beside the equivalence seeds.
 * Returns the address hashes that get an operator point and where.
 */
async function operatorFeatures(db: SqlSession) {
  let n = 0;
  const points: { hash: string; lat: number; lon: number }[] = [];
  const identity = async (
    name: string,
    addresses: {
      status: "Match" | "No_Match" | "Tie";
      point?: { lat: number; lon: number; method: string };
      operator?: { lat: number; lon: number };
    }[],
  ) => {
    const npi = String(1000050000 + n++);
    await db.query(
      `INSERT INTO npi_provider(npi,entity_type,first_name,last_name,in_scope,state_filter,data_date,snapshot_id)
      VALUES ($1,'1','Synthetic',$2,true,'TX','2026-11-07','catalog')`,
      [npi, name],
    );
    await db.query(
      `INSERT INTO npi_taxonomy(npi,ordinal,code,is_primary,license_state,snapshot_id)
      VALUES ($1,1,$2,true,'TX','catalog')`,
      [npi, n % 2 ? "207Q00000X" : "208D00000X"],
    );
    for (const [ordinal, a] of addresses.entries()) {
      const row = `${npi}:practice:${ordinal}`;
      await db.query(
        `INSERT INTO npi_address(npi,kind,ordinal,line_1,city,state,zip5,snapshot_id)
        VALUES ($1,'practice',$2::int,'Synthetic operator address '||$2::text,'AUSTIN','TX','78701','catalog')`,
        [npi, ordinal],
      );
      const hash = (
        await db.query<{ hash: string }>(
          `INSERT INTO ${a.status === "Match" ? "geocode_match_archive" : "geocode_attempt"}(address_hash,source_table,source_row,normalized_address,source_snapshot_id,
            snapshot_id,match_status,match_quality,outcome)
          VALUES (encode(sha256(convert_to($1,'UTF8')),'hex'),'npi_address',$1,'synthetic operator','catalog','catalog',
            $2,NULL,$3) RETURNING address_hash AS hash`,
          [row, a.status, a.point ? "point" : "no_point"],
        )
      ).rows[0]!.hash;
      if (a.point)
        await db.query(
          `INSERT INTO address_point(address_hash,source_table,source_row,source_snapshot_id,latitude,longitude,
            method,match_status,match_quality,snapshot_id,centroid_snapshot_id)
          VALUES ($1,'npi_address',$2,'catalog',$3,$4,$5,$6,NULL,'catalog',
            CASE WHEN $5='zcta_centroid' THEN 'catalog' END)`,
          [hash, row, a.point.lat, a.point.lon, a.point.method, a.status],
        );
      if (a.operator) points.push({ hash, ...a.operator });
    }
  };
  const centroid = (lat: number, lon: number) => ({
    lat,
    lon,
    method: "zcta_centroid",
  });
  const census = (lat: number, lon: number) => ({
    lat,
    lon,
    method: "census_geocoder",
  });
  for (let i = 0; i < 4; i++) {
    const d = i / 50;
    // The Census geocoder missed the address; the operator point locates it.
    await identity("ReviewOperatorMiss", [
      { status: "No_Match", operator: { lat: 30.3 + d, lon: -97.7 } },
    ]);
    await identity("ReviewOperatorTie", [
      { status: "Tie", operator: { lat: 30.3, lon: -97.7 + d } },
    ]);
    // A ZIP-centroid fallback the operator point replaces, near and far from its centroid.
    await identity("ReviewOperatorCentroid", [
      {
        status: "No_Match",
        point: centroid(30.27, -97.74),
        operator: { lat: 30.9 - d, lon: -98.4 },
      },
    ]);
    // A centroid whose attempt matched: the operator point removes it and adds nothing.
    await identity("ReviewOperatorDropped", [
      {
        status: "Match",
        point: centroid(30.3 + d, -97.7),
        operator: { lat: 30.31, lon: -97.71 },
      },
      { status: "Match", point: census(30.32 + d, -97.69) },
    ]);
    // A Census point stays; the operator point for it changes nothing.
    await identity("ReviewOperatorKept", [
      {
        status: "Match",
        point: census(30.3 - d, -97.7),
        operator: { lat: 30.6, lon: -97.2 },
      },
    ]);
    // One touched address and one untouched far away.
    await identity("ReviewOperatorMixed", [
      { status: "No_Match", operator: { lat: 30.3, lon: -97.7 } },
      { status: "Match", point: census(64.84, -147.72) },
    ]);
  }
  // An identity at a cell edge whose operator point ties with the seeds there.
  await identity("ReviewTie", [
    { status: "No_Match", operator: { lat: 30.32, lon: -97.68 } },
  ]);
  await db.query(
    `INSERT INTO geocode_tx_county VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      COUNTY.county_fips,
      COUNTY.name,
      COUNTY.south,
      COUNTY.north,
      COUNTY.west,
      COUNTY.east,
      JSON.stringify(COUNTY.rings),
      COUNTY.snapshot_id,
    ],
  );
  return points;
}

describe.skipIf(!serverUrl)(
  "searches with operator geocoder points read the search keys",
  () => {
    let h: Awaited<ReturnType<typeof setup>>,
      fresh: Awaited<ReturnType<typeof freshDatabase>>,
      root: string;
    const names = [
      "OPENPLANS_DATA_DIR",
      "OPENPLANS_GEOCODER_STORE",
      "OPENPLANS_API_CACHE",
    ] as const;
    const previous = Object.fromEntries(names.map((k) => [k, process.env[k]]));
    const operatorOn = () => {
      process.env.OPENPLANS_DATA_DIR = root;
      process.env.OPENPLANS_GEOCODER_STORE = "1";
      process.env.OPENPLANS_API_CACHE = "off";
    };
    const operatorOff = () => {
      for (const k of names)
        if (previous[k] === undefined) delete process.env[k];
        else process.env[k] = previous[k];
    };
    // Texas origins reach the operator points; the others check the keyed rows still answer.
    const origins = ORIGINS.slice(0, 4);
    const locations = locationSearches(origins);
    const native = nativeSearches(origins);
    let original: string[] = [];
    beforeAll(async () => {
      fresh = await freshDatabase();
      h = await setup(fresh.db);
      root = await mkdtemp(join(tmpdir(), "provider-keys-operator-"));
      await load(h.db, equivalenceSeeds());
      await h.db
        .query(`INSERT INTO provider_taxonomy(code,display_name,classification,version,snapshot_id)
        VALUES ('207Q00000X','Family Medicine Physician','Family Medicine','26.1','catalog')`);
      await locationFeatures(h.db);
      const points = await operatorFeatures(h.db);
      await storeOperatorPoints(
        points.map((p) => ({
          address_hash: p.hash,
          latitude: p.lat,
          longitude: p.lon,
          county_fips: COUNTY.county_fips,
          source: "operator_geocoder" as const,
          as_of: "2026-11-08",
          bounds_snapshot_id: COUNTY.snapshot_id,
        })),
        [COUNTY],
        root,
        { OPENPLANS_GEOCODER_STORE: "1" },
      );
      operatorOn();
      original = await answers(h.db, repository, locations, native);
    }, 300_000);
    afterAll(async () => {
      operatorOff();
      await h?.close();
      await fresh?.drop();
      if (root) await rm(root, { recursive: true, force: true });
    });

    it("the operator points change the answers (fixture check)", async () => {
      operatorOff();
      try {
        const publicOnly = await answers(h.db, repository, locations, native);
        expect(differing(publicOnly, original).length).toBeGreaterThan(20);
      } finally {
        operatorOn();
      }
      expect(
        original.some((body) => body.includes('"operator_geocoder"')),
      ).toBe(true);
    }, 300_000);

    it("gives byte-identical native and location pages", async () => {
      expect((await buildProviderSearchKeys(h.db)).slot).toBe("a");
      const { seen, session } = recording(h.db);
      const keyed = await answers(session, repository, locations, native);
      expect(seen).toEqual({
        keyed: filtered(locations) + native.length,
        original: locations.length - filtered(locations),
      });
      expect(differing(keyed, original)).toEqual([]);
    }, 300_000);

    it("fails when touched identities also answer from their keys (planted mutant)", async () => {
      expect(await currentSearchKeys(h.db)).toBe("a");
      await withMutant(
        `const notOperatorIdentity = operatorKeys
    ? "AND k.npi NOT IN (SELECT npi FROM operator_identities)"
    : "";`,
        'const notOperatorIdentity = "";',
        async (mutant) => {
          const { seen, session } = recording(h.db);
          const keyed = await answers(session, mutant, locations, native);
          expect(seen.keyed).toBeGreaterThan(0);
          expect(differing(keyed, original)).not.toEqual([]);
        },
      );
    }, 300_000);

    it("fails when replaced ZIP-centroid points are not counted as touched (planted mutant)", async () => {
      await withMutant(
        'const operatorIdentities = operatorTouched.join(" UNION ");',
        "const operatorIdentities = operatorTouched[1];",
        async (mutant) => {
          const { seen, session } = recording(h.db);
          const keyed = await answers(session, mutant, locations, native);
          expect(seen.keyed).toBeGreaterThan(0);
          expect(differing(keyed, original)).not.toEqual([]);
        },
      );
    }, 300_000);
  },
);

describe.skipIf(!serverUrl)(
  "compatibility name fallback reads cell-less keys",
  () => {
    let h: Awaited<ReturnType<typeof setup>>,
      fresh: Awaited<ReturnType<typeof freshDatabase>>;
    const q = { name: "SMITH", states: ["TX"] };
    const requests = [
      {},
      { per_page: 1, page: 1 },
      { per_page: 1, page: 2 },
      { per_page: 1, page: 3 },
      { per_page: 1, page: 30 },
      { sort: "-distance" },
      { type: "individual" },
      { taxonomy: "207Q00000X" },
      { search_term: "SM%TH" },
    ];
    const pages = async (db: SqlSession) => {
      const app = providerCompatRoutes(db, new Hono());
      const out = [];
      for (const extra of requests) {
        const response = await app.request("/providers/search", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            zip_code: "77002",
            search_term: "SMITH",
            ...extra,
          }),
        });
        expect(response.status).toBe(200);
        out.push([
          await response.text(),
          response.headers.get("x-openplans-gaps"),
        ]);
      }
      return out;
    };
    beforeAll(async () => {
      fresh = await freshDatabase();
      h = await setup(fresh.db);
      await load(h.db, [
        {
          npi: "1000070000",
          name: "SMITH",
          type: "1",
          codes: ["207Q00000X"],
          addresses: [[[29.76, -95.37]]],
        },
        {
          npi: "1000070001",
          name: "SMITH",
          type: "1",
          codes: ["207Q00000X"],
          addresses: [[], []],
        },
        {
          npi: "1000070002",
          name: "SMITH",
          type: "2",
          codes: ["208D00000X"],
          addresses: [[]],
        },
        {
          npi: "1000070003",
          name: "SMITH",
          type: "1",
          codes: [],
          addresses: [[]],
        },
        {
          npi: "1000070004",
          name: "OTHER",
          type: "1",
          codes: [],
          addresses: [[]],
        },
      ]);
      await h.db.exec(`UPDATE npi_address SET state='LA' WHERE npi='1000070003';
      UPDATE npi_address SET line_1=' Synthetic review address 0 ' WHERE npi='1000070001';
      INSERT INTO geo_import(state,plan_year,relationship_snapshot_id,centroid_snapshot_id,rating_snapshot_id)
        VALUES ('TX',2026,'catalog','catalog','catalog');
      INSERT INTO zcta_centroid VALUES ('77002',29.76,-95.37,'catalog',2);
      INSERT INTO zcta_county VALUES ('77002','48201','Harris County',1,0,1,0,1,0,'catalog',2),
        ('77001','48201','Harris County',1,0,1,0,1,0,'catalog',2);`);
    }, 120_000);
    afterAll(async () => {
      await h?.close();
      await fresh?.drop();
    });

    it("keeps response bytes, totals, gaps and paging for both slots", async () => {
      const original = await pages(h.db);
      const fallback = await repository.searchUnlocatedInState(h.db, q, {
        offset: 0,
        size: 10,
      });
      expect(fallback.total).toBe(2);
      expect(fallback.providers.map((p) => p.npi)).toEqual([
        "1000070001",
        "1000070002",
      ]);
      const allLocations = await repository.searchUnlocatedInState(
        h.db,
        { ...q, includeLocated: true },
        { offset: 0 },
      );
      expect(allLocations.total).toBe(3);
      for (const slot of ["a", "b"]) {
        expect((await buildProviderSearchKeys(h.db)).slot).toBe(slot);
        expect(await pages(h.db)).toEqual(original);
        expect(
          await repository.searchUnlocatedInState(
            h.db,
            { ...q, includeLocated: true },
            { offset: 0 },
          ),
        ).toEqual(allLocations);
        expect(
          await repository.searchUnlocatedInState(h.db, q, {
            offset: 0,
            size: 10,
          }),
        ).toEqual(fallback);
      }
    });

    async function bounded(search: typeof repository.searchUnlocatedInState) {
      let captured: { sql: string; parameters: unknown[] } | undefined;
      const session: SqlSession = {
        exec: (sql) => h.db.exec(sql),
        query: (sql, parameters, options) => {
          if (sql.includes("WITH names AS MATERIALIZED"))
            captured = { sql, parameters: parameters ?? [] };
          return h.db.query(sql, parameters, options);
        },
      };
      await search(session, q, { offset: 0, size: 10 });
      expect(captured?.sql).toContain("k.cell IS NULL");
      const plan = await h.db.transaction(async (tx) => {
        await tx.exec("SET LOCAL enable_seqscan=off");
        return tx.query<{ "QUERY PLAN": string }>(
          "EXPLAIN " + captured!.sql,
          captured!.parameters,
        );
      });
      const text = plan.rows.map((r) => r["QUERY PLAN"]).join("\n");
      expect(text).toMatch(
        /Index (?:Only )?Scan using provider_search_key_b_cell[\s\S]*Index Cond: \(cell IS NULL\)/,
      );
      expect(text).not.toContain("provider_identity_name_search");
    }

    it("uses the cell index before probing identities", async () => {
      await bounded(repository.searchUnlocatedInState);
    });

    it("rejects the old nationwide name path in a disposable mutant", async () => {
      await withMutant(
        "const keys = q.includeLocated ? undefined : await currentSearchKeys(db);",
        "const keys = undefined;",
        async (mutant) => {
          await expect(
            bounded(mutant.searchUnlocatedInState),
          ).rejects.toThrow();
        },
      );
    });

    it("falls back when the chosen slot has been emptied", async () => {
      const expected = await repository.searchUnlocatedInState(h.db, q, {
        offset: 0,
        size: 10,
      });
      const rollback = new Error("rollback emptied slot control");
      await expect(
        h.db.transaction(async (tx) => {
          await tx.exec("TRUNCATE provider_search_key_b");
          expect(
            await repository.searchUnlocatedInState(tx, q, {
              offset: 0,
              size: 10,
            }),
          ).toEqual(expected);
          throw rollback;
        }),
      ).rejects.toBe(rollback);
    });

    it("falls back when source revisions change after choosing the slot", async () => {
      let changed = false;
      const session: SqlSession = {
        exec: (sql) => h.db.exec(sql),
        query: async (sql, parameters, options) => {
          if (!changed && sql.includes("WITH names AS MATERIALIZED")) {
            changed = true;
            await h.db.exec(
              "UPDATE npi_address SET state='TX' WHERE npi='1000070003'",
            );
          }
          return h.db.query(sql, parameters, options);
        },
      };
      expect(
        (
          await repository.searchUnlocatedInState(session, q, {
            offset: 0,
            size: 10,
          })
        ).total,
      ).toBe(3);
      expect(changed).toBe(true);
      expect(await currentSearchKeys(h.db)).toBeUndefined();
    });
  },
);
