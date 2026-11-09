import { describe, it, expect } from "vitest";
import { readFile, mkdtemp, rm, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { setup } from "./helpers.js";
import type { Address } from "../../../src/ingest/geocode/address.js";
import {
  normalizeAddress,
  assertHouseNumber,
} from "../../../src/ingest/geocode/normalize.js";
import {
  stageStatewide,
  geocodeStatewide,
} from "../../../src/ingest/geocode/statewide.js";
import { cleanupGeocodes } from "../../../src/ingest/geocode/cleanup.js";
import {
  operatorGeocoder,
  assertNoGeocoderKey,
  validateOperatorPoint,
} from "../../../src/ingest/geocode/operator.js";
import {
  readOperatorPoints,
  storeOperatorPoints,
} from "../../../src/ingest/geocode/operator-store.js";
import type { County } from "../../../src/ingest/geocode/counties.js";
import { createApp } from "../../../src/api/app.js";
import { reused } from "../../../src/ingest/geocode/repository.js";
import { createDatabase } from "../../../src/db/database.js";
import type { Database } from "../../../src/db/database.js";

const synthetic: Address = {
  npi: null,
  kind: "practice",
  ordinal: 0,
  line_1: "123 NORTH MAIN STREET SUITE 4",
  line_2: null,
  city: "SYNTHETIC",
  state: "TX",
  zip5: "77002-1234",
  snapshot_id: "synthetic",
};
const county: County = {
  county_fips: "48201",
  name: "Synthetic Harris rectangle",
  south: 29.5,
  north: 30,
  west: -96,
  east: -95,
  rings: [
    [
      [-96, 29.5],
      [-95, 29.5],
      [-95, 30],
      [-96, 30],
      [-96, 29.5],
    ],
  ],
  snapshot_id: "synthetic-bounds",
};

describe("conservative address cleanup", () => {
  it("keeps the original, records rules, separates units and trims ZIP+4", () => {
    const result = normalizeAddress(synthetic);
    expect(result.original).toEqual(synthetic);
    expect(result.request).toMatchObject({
      line_1: "123 N MAIN ST",
      line_2: null,
      zip5: "77002",
    });
    expect(result.normalized.line_2).toBe("SUITE 4");
    expect(result.rules).toEqual([
      "secondary_unit",
      "street_suffix",
      "directional",
      "zip_plus4",
    ]);
    expect(normalizeAddress(result.normalized).request).toEqual(result.request);
    assertHouseNumber(synthetic, result.request);
    expect(() =>
      assertHouseNumber(synthetic, { ...result.request, line_1: "N MAIN ST" }),
    ).toThrow("house number");
  });
  it.each([
    "STE 9",
    "# 9",
    "UNIT 9",
    "FL 9",
    "BLDG 9",
    "ROOM 9",
    "SUITE 9",
    "FLOOR 9",
  ])("splits %s without dropping a house number", (unit) => {
    const a = { ...synthetic, line_1: `123-45 1/2 MAIN ROAD ${unit}` };
    const c = normalizeAddress(a);
    expect(c.request.line_1).toBe("123-45 1/2 MAIN RD");
    assertHouseNumber(a, c.request);
    expect(c.secondary).toEqual([unit]);
  });
  it("preserves street names, repeated numeric tokens, unrecognized line two and flags PO boxes", () => {
    for (const number of ["123-B", "123.5", "123", "123A", "123-45 1/2"]) {
      const a = { ...synthetic, line_1: `${number} MAIN ROAD` };
      assertHouseNumber(a, normalizeAddress(a).request);
    }
    for (const name of [
      "123 NORTH STREET",
      "123 MAIN NORTH STREET",
      "123 NORTH SOUTH STREET",
    ]) {
      const c = normalizeAddress({ ...synthetic, line_1: name });
      expect(c.request.line_1).toContain(
        name.split(" ").slice(0, -1).join(" "),
      );
    }
    expect(
      normalizeAddress({
        ...synthetic,
        line_1: "123 123 MAIN MAIN ROAD",
        line_2: "CLINIC",
      }).request,
    ).toMatchObject({ line_1: "123 123 MAIN RD", line_2: "CLINIC" });
    for (const line_1 of [
      "PO BOX 4",
      "P.O. BOX 4",
      "P O BOX 4",
      "POST OFFICE BOX 4",
    ])
      expect(normalizeAddress({ ...synthetic, line_1 }).geocodable).toBe(false);
  });
});

async function harness(line = "901 BAGBY STREET SUITE 1", database?: Database) {
  const h = await setup(database);
  await h.db.query("DELETE FROM npi_address WHERE npi<>'1000000000'");
  await h.db.query(
    "UPDATE npi_address SET line_1=$1,line_2=NULL WHERE npi='1000000000'",
    [line],
  );
  await h.db.query(
    "INSERT INTO geocode_tx_county SELECT * FROM json_populate_record(NULL::geocode_tx_county,$1::json)",
    [JSON.stringify(county)],
  );
  await stageStatewide(h.db, { runId: "source" });
  await geocodeStatewide(h.db, [county], {
    runId: "source",
    acquire: async () => ({
      file: await h.file('"1","synthetic","No_Match"\n'),
      requests: 1,
    }),
  });
  return h;
}
describe("cleanup retries and publication", () => {
  it("retries only changed unresolved addresses, retains original evidence and publishes a normalized label", async () => {
    const h = await harness();
    try {
      const calls: string[] = [];
      const first = (
        await readFile(
          new URL("../../fixtures/geocode/tx-census.csv", import.meta.url),
          "utf8",
        )
      ).split("\n")[0]!;
      const report = await cleanupGeocodes(h.db, [county], {
        runId: "clean",
        sourceRunId: "source",
        acquire: async (csv) => {
          calls.push(csv);
          expect(csv).toContain("901 BAGBY ST");
          expect(csv).not.toContain("SUITE");
          return { file: await h.file(first + "\n"), requests: 1 };
        },
      });
      expect(report).toMatchObject({
        matched_before: 0,
        matched_after: 1,
        recovered: 1,
        pending: 0,
        operator: { enabled: false },
      });
      expect(report.rules).toContainEqual({
        rule: "secondary_unit",
        addresses: 1,
        eligible: 1,
        recovered: 1,
      });
      const point = (await h.db.query("SELECT * FROM address_point")).rows[0]!;
      expect(point.method).toBe("census_geocoder");
      expect(point.normalization).toMatchObject({
        rules: ["secondary_unit", "street_suffix"],
      });
      expect(
        (await h.db.query("SELECT line_1 FROM npi_address")).rows[0]!.line_1,
      ).toBe("901 BAGBY STREET SUITE 1");
      expect(
        (
          await h.db.query(
            "SELECT original_result FROM geocode_cleanup_address",
          )
        ).rows[0]!.original_result,
      ).toMatchObject({ match_status: "No_Match", method: "zcta_centroid" });
      const body = await (
        await createApp(h.db).request("/v1/providers?zip=77002&radius_miles=10")
      ).json();
      expect(body.providers[0].addresses[0]).toMatchObject({
        geocode_label: "census_match_after_normalisation",
        method: "census_geocoder",
      });
      expect(
        (
          await cleanupGeocodes(h.db, [county], {
            runId: "clean",
            sourceRunId: "source",
            acquire: async () => {
              throw new Error("Network forbidden");
            },
          })
        ).recovered,
      ).toBe(1);
      expect(calls).toHaveLength(1);
      // A reused cleaned match may predate another source's original no-match observation.
      await h.db
        .query(`INSERT INTO geocode_attempt(address_hash,source_table,source_row,normalized_address,source_snapshot_id,
        snapshot_id,match_status,match_quality,outcome,geocoded_at)
        SELECT address_hash,source_table,'synthetic-other-source',normalized_address,source_snapshot_id,
          snapshot_id,'No_Match',NULL,'no_point',geocoded_at+interval '1 day' FROM geocode_attempt LIMIT 1`);
      const current = (
        await h.db.query<Address>(
          "SELECT * FROM npi_address WHERE npi='1000000000'",
        )
      ).rows[0]!;
      expect(
        await reused(h.db, {
          ...current,
          source_row: "synthetic-other-source",
        }),
      ).toBe(true);
      expect(
        (
          await h.db.query(
            "SELECT method,normalization FROM address_point WHERE source_row='synthetic-other-source'",
          )
        ).rows[0],
      ).toMatchObject({
        method: "census_geocoder",
        normalization: { rules: ["secondary_unit", "street_suffix"] },
      });
      await expect(
        cleanupGeocodes(h.db, [county], {
          runId: "source",
          sourceRunId: "clean",
        }),
      ).rejects.toThrow("own run ID");
      await expect(
        cleanupGeocodes(h.db, [county], {
          runId: "clean",
          sourceRunId: "clean",
        }),
      ).rejects.toThrow("separate run ID");
    } finally {
      await h.cleanup();
    }
  });
  it("leaves PO boxes and unchanged inputs on their labelled fallback without requests", async () => {
    for (const line of ["PO BOX 123", "901 BAGBY ST"]) {
      const h = await harness(line);
      try {
        const result = await cleanupGeocodes(h.db, [county], {
          runId: "clean",
          sourceRunId: "source",
          acquire: async () => {
            throw new Error("Network forbidden");
          },
        });
        expect(result.recovered).toBe(0);
        expect(result.census.requests).toBe(0);
        expect(
          (await h.db.query("SELECT method FROM address_point")).rows,
        ).toEqual([{ method: "zcta_centroid" }]);
      } finally {
        await h.cleanup();
      }
    }
  });
});

describe("optional operator geocoder", () => {
  it.skipIf(!process.env.GEOCODE_CLEANUP_POSTGIS_URL)(
    "PostGIS radius search overlays private points and keeps them out of SQL tables",
    async () => {
      const url = new URL(process.env.GEOCODE_CLEANUP_POSTGIS_URL!);
      if (!/^\/openplans_p3m_controls_\d+$/.test(url.pathname))
        throw new Error("Cleanup PostGIS checks require a disposable database");
      const h = await harness("901 BAGBY ST", createDatabase(url.href)),
        root = await mkdtemp(join(tmpdir(), "private-postgis-geocode-"));
      const previous = {
        root: process.env.OPENPLANS_DATA_DIR,
        store: process.env.OPENPLANS_GEOCODER_STORE,
        cache: process.env.OPENPLANS_API_CACHE,
      };
      try {
        process.env.OPENPLANS_DATA_DIR = root;
        process.env.OPENPLANS_GEOCODER_STORE = "1";
        process.env.OPENPLANS_API_CACHE = "off";
        const point = {
          latitude: 29.7654321,
          longitude: -95.37654321,
          county_fips: "48201",
          source: "operator_geocoder" as const,
          as_of: "2026-11-08",
        };
        expect(
          (
            await cleanupGeocodes(h.db, [county], {
              sourceRunId: "source",
              runId: "clean",
              dataDir: root,
              operator: { geocode: async () => point },
            })
          ).operator.stored,
        ).toBe(1);
        const app = createApp(h.db),
          near = await app.request("/v1/providers?zip=77002&radius_miles=10");
        expect(near.status).toBe(200);
        const body = await near.json();
        expect(body.providers[0].addresses[0]).toMatchObject({
          method: "operator_geocoder",
          latitude: point.latitude,
          precision: "operator_reported",
        });
        expect(near.headers.get("X-Cache")).toBe("bypass");
        const far = await (
          await app.request("/v1/providers?zip=77356&radius_miles=1")
        ).json();
        expect(far.total).toBe(0);
        expect(
          (await h.db.query("SELECT method FROM address_point")).rows,
        ).toEqual([{ method: "zcta_centroid" }]);
        expect(
          (await h.db.query("SELECT method FROM geocode_tx_result")).rows,
        ).toEqual([{ method: "zcta_centroid" }]);
      } finally {
        for (const [name, value] of Object.entries({
          OPENPLANS_DATA_DIR: previous.root,
          OPENPLANS_GEOCODER_STORE: previous.store,
          OPENPLANS_API_CACHE: previous.cache,
        })) {
          if (value === undefined) delete process.env[name];
          else process.env[name] = value;
        }
        await h.cleanup();
        await rm(root, { recursive: true, force: true });
      }
    },
  );
  it("is env-only, paced, never logs its key, and handles invalid replies and failures", async () => {
    const key = "synthetic-key+/secret",
      logs: string[] = [],
      sleeps: number[] = [];
    let count = 0;
    const server = createServer((req, res) => {
      expect(
        new URL(req.url!, "http://127.0.0.1").searchParams.get("key"),
      ).toBe(key);
      count++;
      res.setHeader("content-type", "application/json");
      if (count === 1)
        res.end(
          JSON.stringify({
            results: [{ lat: 29.76, lon: -95.37, county: "48201" }],
          }),
        );
      else if (count === 2)
        res.end(
          JSON.stringify({ results: [{ lat: 0, lon: 0, county: "48201" }] }),
        );
      else {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: key }));
      }
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const socket = server.address();
    if (!socket || typeof socket === "string")
      throw new Error("No fake listener");
    try {
      expect(operatorGeocoder({})).toBeNull();
      const adapter = operatorGeocoder(
        {
          OPENPLANS_GEOCODER_URL: `http://127.0.0.1:${socket.port}/?q={address}&key={key}`,
          OPENPLANS_GEOCODER_KEY: key,
          OPENPLANS_GEOCODER_LAT_PATH: "results.0.lat",
          OPENPLANS_GEOCODER_LON_PATH: "results.0.lon",
          OPENPLANS_GEOCODER_COUNTY_PATH: "results.0.county",
        },
        {
          sleep: async (ms) => {
            sleeps.push(ms);
          },
          log: (message) => logs.push(message),
        },
      )!;
      const point = await adapter.geocode(synthetic);
      expect(validateOperatorPoint(point!, [county])).toBe(true);
      const outside = await adapter.geocode(synthetic);
      expect(validateOperatorPoint(outside!, [county])).toBe(false);
      expect(await adapter.geocode(synthetic)).toBeNull();
      expect(sleeps).toHaveLength(2);
      expect(logs).toEqual([
        "Operator geocoder request failed; fallback retained",
      ]);
      assertNoGeocoderKey(logs.join("\n"), key);
      expect(() =>
        assertNoGeocoderKey(logs.join("\n") + " " + key, key),
      ).toThrow("key found");
      expect(() => assertNoGeocoderKey(encodeURIComponent(key), key)).toThrow(
        "key found",
      );
      expect(
        validateOperatorPoint({ ...point!, county_fips: "48113" }, [county]),
      ).toBe(false);
      const otherCounty = {
        ...county,
        county_fips: "48113",
        south: 32,
        north: 33,
        west: -97,
        east: -96,
      };
      expect(
        validateOperatorPoint({ ...point!, county_fips: "48113" }, [
          county,
          otherCounty,
        ]),
      ).toBe(false);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
  it("stores nothing without consent, rejects a store mutant, and overlays consented points without SQL persistence", async () => {
    const root = await mkdtemp(join(tmpdir(), "openplans-private-geocode-")),
      h = await harness("901 BAGBY ST");
    const priorRoot = process.env.OPENPLANS_DATA_DIR,
      priorStore = process.env.OPENPLANS_GEOCODER_STORE,
      priorCache = process.env.OPENPLANS_API_CACHE;
    const point = {
      latitude: 29.76,
      longitude: -95.37,
      county_fips: "48201",
      source: "operator_geocoder" as const,
      as_of: "2026-11-08",
    };
    try {
      const operator = { geocode: async () => point };
      const publicBefore = (await h.db.query("SELECT * FROM address_point"))
        .rows;
      const report = await cleanupGeocodes(h.db, [county], {
        runId: "clean",
        sourceRunId: "source",
        operator,
        dataDir: root,
        env: {},
      });
      expect(report.operator).toMatchObject({ matched: 1, stored: 0 });
      expect(await readdir(root)).toEqual([]);
      const assertNoStored = async () =>
        expect(await readdir(root)).toEqual([]);
      await assertNoStored();
      // Execute a consent-bypassing writer in the disposable store. The independent disk audit catches it.
      await writeFile(
        join(root, "mutant-points.json"),
        JSON.stringify([point]),
      );
      await expect(assertNoStored()).rejects.toThrow();
      await rm(join(root, "mutant-points.json"));
      const stored = await cleanupGeocodes(h.db, [county], {
        runId: "clean",
        sourceRunId: "source",
        operator,
        dataDir: root,
        env: { OPENPLANS_GEOCODER_STORE: "1" },
      });
      expect(stored.operator.stored).toBe(1);
      expect(
        (await readOperatorPoints(root, { OPENPLANS_GEOCODER_STORE: "1" }))[0],
      ).toMatchObject(point);
      expect((await h.db.query("SELECT * FROM address_point")).rows).toEqual(
        publicBefore,
      );
      process.env.OPENPLANS_API_CACHE = "on";
      const cached = await (
        await createApp(h.db).request("/v1/providers?zip=77002&radius_miles=10")
      ).json();
      expect(cached.providers[0].addresses[0].method).toBe("zcta_centroid");
      process.env.OPENPLANS_API_CACHE = "off";
      expect(
        (
          await h.db.query(
            "SELECT * FROM geocode_tx_result WHERE method='operator_geocoder'",
          )
        ).rows,
      ).toEqual([]);
      process.env.OPENPLANS_DATA_DIR = root;
      process.env.OPENPLANS_GEOCODER_STORE = "1";
      process.env.OPENPLANS_API_CACHE = "off";
      const body = await (
        await createApp(h.db).request("/v1/providers?zip=77002&radius_miles=10")
      ).json();
      expect(body.providers[0].addresses[0]).toMatchObject({
        latitude: point.latitude,
        method: "operator_geocoder",
        geocode_label: "operator_geocoder",
        precision: "operator_reported",
      });
      // A whole SQL dump cannot contain these private coordinates: no table was changed by the operator stage.
      expect((await h.db.query("SELECT * FROM address_point")).rows).toEqual(
        publicBefore,
      );
      const hash = (await h.db.query("SELECT address_hash FROM address_point"))
        .rows[0]!.address_hash as string;
      await expect(
        storeOperatorPoints(
          [
            {
              ...point,
              latitude: 39.96,
              longitude: -82.99,
              address_hash: hash,
              bounds_snapshot_id: county.snapshot_id,
            },
          ],
          [county],
          root,
          { OPENPLANS_GEOCODER_STORE: "1" },
        ),
      ).rejects.toThrow("county validation");
      const rejected = await cleanupGeocodes(h.db, [county], {
        runId: "clean",
        sourceRunId: "source",
        operator: {
          geocode: async () => ({
            ...point,
            latitude: 39.96,
            longitude: -82.99,
          }),
        },
        dataDir: root,
        env: { OPENPLANS_GEOCODER_STORE: "1" },
      });
      expect(rejected.operator).toMatchObject({
        matched: 0,
        rejected: 1,
        stored: 0,
      });
      process.env.OPENPLANS_GEOCODER_STORE = "0";
      const fallback = await (
        await createApp(h.db).request("/v1/providers?zip=77002&radius_miles=10")
      ).json();
      expect(fallback.providers[0].addresses[0]).toMatchObject({
        method: "zcta_centroid",
        geocode_label: "zcta_fallback",
      });
    } finally {
      if (priorRoot === undefined) delete process.env.OPENPLANS_DATA_DIR;
      else process.env.OPENPLANS_DATA_DIR = priorRoot;
      if (priorStore === undefined) delete process.env.OPENPLANS_GEOCODER_STORE;
      else process.env.OPENPLANS_GEOCODER_STORE = priorStore;
      if (priorCache === undefined) delete process.env.OPENPLANS_API_CACHE;
      else process.env.OPENPLANS_API_CACHE = priorCache;
      await h.cleanup();
      await rm(root, { recursive: true, force: true });
    }
  });
});
