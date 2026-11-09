import { describe, it, expect } from "vitest";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { setup } from "./helpers.js";
import {
  stageStatewide,
  geocodeStatewide,
} from "../../../src/ingest/geocode/statewide.js";
import { cleanupGeocodes } from "../../../src/ingest/geocode/cleanup.js";
import {
  openGeocoder,
  openAttribution,
  openLicence,
  assertOpenAttribution,
  assertOpenServerDate,
  validateOpenIndexDate,
  openImportProfile,
} from "../../../src/ingest/geocode/open.js";
import type {
  OpenPoint,
  OpenDataset,
} from "../../../src/ingest/geocode/open.js";
import { retryOpenGeocoder } from "../../../src/ingest/geocode/open-retry.js";
import type { Address } from "../../../src/ingest/geocode/address.js";
import type { County } from "../../../src/ingest/geocode/counties.js";

const dataset: OpenDataset = {
  sha256: "a".repeat(64),
  index_sha256: "c".repeat(64),
  import_profile: openImportProfile,
  data_date: "2026-11-07",
  state: "TX",
};
const address: Address = {
  npi: null,
  kind: "practice",
  ordinal: 0,
  line_1: "901 BAGBY ST",
  line_2: null,
  city: "HOUSTON",
  state: "TX",
  zip5: "77002",
  snapshot_id: "synthetic",
};
const county: County = {
  county_fips: "48201",
  name: "Harris",
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
// Synthetic Nominatim replies, never recorded from a hosted service.
const reply = () => ({
  lat: "29.76",
  lon: "-95.37",
  place_rank: 30,
  osm_type: "way",
  osm_id: 123,
  address: {
    house_number: "901",
    road: "Bagby Street",
    postcode: "77002",
    county: "Harris County",
    country_code: "us",
    "ISO3166-2-lvl4": "US-TX",
  },
});
async function serverHarness() {
  let response: unknown = [reply()],
    status = 200,
    redirect = false;
  const requests: URL[] = [];
  const server = createServer((req, res) => {
    requests.push(new URL(req.url!, "http://127.0.0.1"));
    res.statusCode = status;
    res.setHeader("content-type", "application/json");
    if (redirect) {
      res.statusCode = 302;
      res.setHeader("location", "http://127.0.0.1:1/");
    }
    res.end(JSON.stringify(response));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const socket = server.address();
  if (!socket || typeof socket === "string")
    throw new Error("No test listener");
  return {
    env: { OPENPLANS_OPEN_GEOCODER_URL: `http://127.0.0.1:${socket.port}` },
    requests,
    set: (body: unknown, code = 200, location = false) => {
      response = body;
      status = code;
      redirect = location;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
async function ledgerHarness() {
  const h = await setup();
  await h.db.query("DELETE FROM npi_address WHERE npi<>'1000000000'");
  await h.db.query(
    "UPDATE npi_address SET line_1='901 BAGBY ST',line_2=NULL WHERE npi='1000000000'",
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
  await cleanupGeocodes(h.db, [county], {
    sourceRunId: "source",
    runId: "cleanup",
    acquire: async () => {
      throw new Error("Unexpected Census request");
    },
  });
  return h;
}

describe("self-hosted open geocoder", () => {
  it("is disabled by default, restricts endpoints to loopback, and requires an identified dataset", () => {
    expect(openGeocoder([county], dataset, {})).toBeNull();
    for (const url of [
      "https://nominatim.openstreetmap.org",
      "http://localhost",
      "http://127.0.0.1/?key=secret",
      "http://user:secret@127.0.0.1/",
      "file:///tmp/test",
    ])
      expect(() =>
        openGeocoder([county], dataset, { OPENPLANS_OPEN_GEOCODER_URL: url }),
      ).toThrow("loopback");
    expect(() =>
      openGeocoder(
        [county],
        { ...dataset, data_date: "2026-02-30" },
        { OPENPLANS_OPEN_GEOCODER_URL: "http://127.0.0.1" },
      ),
    ).toThrow("dataset");
  });
  it("uses structured address search and retains source, licence, date and extract identity", async () => {
    const s = await serverHarness();
    try {
      const adapter = openGeocoder([county], dataset, s.env)!;
      expect(await adapter.geocode(address)).toEqual({
        ...dataset,
        latitude: 29.76,
        longitude: -95.37,
        county_fips: "48201",
        bounds_snapshot_id: county.snapshot_id,
        source: "open_geocoder",
        licence: openLicence,
        attribution: openAttribution,
        as_of: new Date().toISOString().slice(0, 10),
        osm_type: "way",
        osm_id: "123",
        precision: "osm_address",
        matched_address: {
          house_number: "901",
          road: "Bagby Street",
          postcode: "77002",
        },
      });
      expect(Object.fromEntries(s.requests[0]!.searchParams)).toMatchObject({
        street: "901 BAGBY ST",
        city: "HOUSTON",
        postalcode: "77002",
        countrycodes: "us",
        limit: "2",
      });
      expect(
        await adapter.geocode({ ...address, line_1: "PO BOX 12" }),
      ).toBeNull();
      expect(await adapter.geocode({ ...address, state: "FL" })).toBeNull();
      expect(s.requests).toHaveLength(1);
    } finally {
      await s.close();
    }
  });
  it("rejects a server with a different indexed-object timestamp or an unhealthy status", async () => {
    const s = await serverHarness(),
      timestamp = "2026-11-07T21:21:36+00:00";
    try {
      s.set({ status: 0, data_updated: timestamp });
      await assertOpenServerDate(s.env.OPENPLANS_OPEN_GEOCODER_URL, timestamp);
      expect(s.requests[0]!.pathname).toBe("/status");
      s.set({ status: 0, data_updated: "2026-11-06T21:21:36+00:00" });
      await expect(
        assertOpenServerDate(s.env.OPENPLANS_OPEN_GEOCODER_URL, timestamp),
      ).rejects.toThrow("dataset date");
      s.set({ status: 700, data_updated: timestamp });
      await expect(
        assertOpenServerDate(s.env.OPENPLANS_OPEN_GEOCODER_URL, timestamp),
      ).rejects.toThrow("dataset date");
    } finally {
      await s.close();
    }
  });
  it("compares the server with the newest indexed object, while retaining the replication snapshot date", async () => {
    const s = await serverHarness(),
      object = "2026-11-07T21:20:56Z",
      replication = "2026-11-07T21:21:36+00:00";
    try {
      validateOpenIndexDate(object, replication, dataset.data_date);
      validateOpenIndexDate(
        "2026-11-06T12:00:00Z",
        replication,
        dataset.data_date,
      );
      s.set({ status: 0, data_updated: object });
      await assertOpenServerDate(s.env.OPENPLANS_OPEN_GEOCODER_URL, object);
      await expect(
        assertOpenServerDate(s.env.OPENPLANS_OPEN_GEOCODER_URL, replication),
      ).rejects.toThrow("dataset date");
      expect(() =>
        validateOpenIndexDate(
          "2026-11-08T00:00:00Z",
          replication,
          dataset.data_date,
        ),
      ).toThrow("index date");
      expect(() =>
        validateOpenIndexDate(object, replication, "2026-11-06"),
      ).toThrow("index date");
      expect(() =>
        validateOpenIndexDate("invalid", replication, dataset.data_date),
      ).toThrow("index date");
    } finally {
      await s.close();
    }
  });
  it("rejects out-of-county, wrong county claims, broad matches, wrong house/ZIP/state and ties", async () => {
    const s = await serverHarness();
    try {
      const adapter = openGeocoder([county], dataset, s.env)!;
      const bad = [
        { ...reply(), lat: "40", lon: "-83" },
        { ...reply(), lat: " " },
        { ...reply(), place_rank: 26 },
        {
          ...reply(),
          address: { ...reply().address, county: "Dallas County" },
        },
        { ...reply(), address: { ...reply().address, house_number: "900" } },
        { ...reply(), address: { ...reply().address, road: "Another Street" } },
        { ...reply(), address: { ...reply().address, postcode: "77003" } },
        {
          ...reply(),
          address: { ...reply().address, "ISO3166-2-lvl4": "US-NC" },
        },
      ];
      for (const item of bad) {
        s.set([item]);
        expect(await adapter.geocode(address)).toBeNull();
      }
      s.set([reply(), { ...reply(), osm_id: 456 }]);
      expect(await adapter.geocode(address)).toBeNull();
      s.set([]);
      expect(await adapter.geocode(address)).toBeNull();
      s.set([reply()]);
      const withHole = {
        ...county,
        rings: [
          ...county.rings,
          [
            [-95.4, 29.7],
            [-95.3, 29.7],
            [-95.3, 29.8],
            [-95.4, 29.8],
            [-95.4, 29.7],
          ],
        ],
      };
      expect(
        await openGeocoder([withHole], dataset, s.env)!.geocode(address),
      ).toBeNull();
    } finally {
      await s.close();
    }
  });
  it("treats transport/schema errors as retriable, limits bytes and never follows redirects", async () => {
    const s = await serverHarness();
    try {
      const adapter = openGeocoder([county], dataset, s.env)!;
      for (const [body, status, redirect] of [
        [{}, 200, false],
        [[], 500, false],
        ["x".repeat(65536), 200, false],
        [[], 200, true],
      ] as const) {
        s.set(body, status, redirect);
        await expect(adapter.geocode(address)).rejects.toThrow();
      }
    } finally {
      await s.close();
    }
  });
  it("checks README attribution and rejects a disposable missing-attribution mutant", async () => {
    const readme = await readFile(
      new URL("../../../src/ingest/geocode/README.md", import.meta.url),
      "utf8",
    );
    assertOpenAttribution(readme);
    expect(() =>
      assertOpenAttribution(readme.replaceAll(openAttribution, "")),
    ).toThrow("attribution missing");
  });
  it("freezes a sample, persists open provenance, resumes without requests and preserves Census evidence", async () => {
    const h = await ledgerHarness(),
      s = await serverHarness();
    try {
      const adapter = openGeocoder([county], dataset, s.env)!,
        options = {
          runId: "open-sample",
          sourceRunId: "source",
          cleanupRunId: "cleanup",
          adapter,
          limit: 1,
        };
      const before = (await h.db.query("SELECT * FROM geocode_tx_result")).rows;
      expect(await retryOpenGeocoder(h.db, [county], options)).toMatchObject({
        selected: 1,
        pending: 0,
        recovered: 1,
        attempts: 1,
        matched_before: 0,
        matched_after: 1,
      });
      const result = (await h.db.query("SELECT point FROM geocode_open_result"))
        .rows[0]!.point as OpenPoint;
      expect(result).toMatchObject({
        source: "open_geocoder",
        licence: "ODbL-1.0",
        data_date: dataset.data_date,
        sha256: dataset.sha256,
      });
      expect(
        (await h.db.query("SELECT * FROM geocode_tx_result")).rows,
      ).toEqual(before);
      expect(
        (await h.db.query("SELECT method FROM address_point")).rows,
      ).toEqual([{ method: "zcta_centroid" }]);
      expect(await retryOpenGeocoder(h.db, [county], options)).toMatchObject({
        attempts: 0,
        recovered: 1,
      });
      await expect(
        retryOpenGeocoder(h.db, [county], { ...options, limit: 2 }),
      ).rejects.toThrow("scope differs");
      await expect(
        retryOpenGeocoder(h.db, [county], {
          ...options,
          adapter: {
            ...adapter,
            dataset: { ...dataset, index_sha256: "d".repeat(64) },
          },
        }),
      ).rejects.toThrow("scope differs");
      const mutant = { ...result };
      delete (mutant as Partial<OpenPoint>).attribution;
      await expect(
        h.db.query("UPDATE geocode_open_result SET point=$1::jsonb", [
          JSON.stringify(mutant),
        ]),
      ).rejects.toThrow();
      await expect(
        h.db.query("UPDATE geocode_open_result SET point=$1::jsonb", [
          JSON.stringify({ ...result, attribution: null }),
        ]),
      ).rejects.toThrow();
    } finally {
      await s.close();
      await h.cleanup();
    }
  });
  it("retains pending rows after a server failure and rejects an injected out-of-county adapter point", async () => {
    const h = await ledgerHarness(),
      s = await serverHarness();
    try {
      const adapter = openGeocoder([county], dataset, s.env)!,
        options = {
          runId: "open-errors",
          sourceRunId: "source",
          cleanupRunId: "cleanup",
          adapter,
        };
      s.set([], 503);
      expect(await retryOpenGeocoder(h.db, [county], options)).toMatchObject({
        pending: 1,
        recovered: 0,
        errors: 1,
      });
      expect(
        (
          await h.db.query(
            "SELECT source,licence,attribution FROM geocode_open_run",
          )
        ).rows,
      ).toEqual([
        {
          source: "open_geocoder",
          licence: openLicence,
          attribution: openAttribution,
        },
      ]);
      s.set([reply()]);
      const point = (await adapter.geocode(address))!;
      expect(
        await retryOpenGeocoder(h.db, [county], {
          ...options,
          adapter: {
            dataset,
            geocode: async () => ({ ...point, latitude: 40, longitude: -83 }),
          },
        }),
      ).toMatchObject({
        pending: 0,
        rejected: 1,
        recovered: 0,
        matched_after: 0,
      });
      expect(
        (await h.db.query("SELECT point FROM geocode_open_result")).rows,
      ).toEqual([{ point: null }]);
    } finally {
      await s.close();
      await h.cleanup();
    }
  });
  it("cannot run before Census cleanup completes or with mismatched county geometry", async () => {
    const h = await ledgerHarness(),
      s = await serverHarness();
    try {
      const adapter = openGeocoder([county], dataset, s.env)!,
        options = {
          runId: "open-blocked",
          sourceRunId: "source",
          cleanupRunId: "cleanup",
          adapter,
        };
      await h.db.query(
        "UPDATE geocode_cleanup_address SET changed=true,retry_hash=repeat('b',64)",
      );
      await expect(retryOpenGeocoder(h.db, [county], options)).rejects.toThrow(
        "still pending",
      );
      await expect(
        retryOpenGeocoder(h.db, [{ ...county, county_fips: "12001" }], options),
      ).rejects.toThrow("county state");
    } finally {
      await s.close();
      await h.cleanup();
    }
  });
});
