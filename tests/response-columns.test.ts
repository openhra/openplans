import { PGlite } from "@electric-sql/pglite";
import { Hono } from "hono";
import { expect, it } from "vitest";
import { createApp } from "../src/api/app.js";
import {
  ROW_PROVENANCE_COLUMNS,
  rowJson,
  withoutRowProvenance,
} from "../src/db/row-provenance.js";
import { testDatabase } from "./pglite.js";
import { checkResponses, rowProvenanceLeaks } from "./response-columns.js";

// Every name, address and identifier below is synthetic.
const row = {
  npi: "1000000000",
  city: "HOUSTON",
  created_at: "2026-11-09T00:00:00Z",
  updated_at: "2026-11-09T00:00:00Z",
  sourced_by: "cms-nppes",
  sourced_at: null,
  sourced_slug: "synthetic-snapshot",
};

it("finds a row provenance column at any depth of a response", () => {
  expect(rowProvenanceLeaks({ providers: [{ npi: "1000000000" }] })).toEqual(
    [],
  );
  expect(
    rowProvenanceLeaks({
      identity: row,
      providers: [{ addresses: [{ city: "HOUSTON", sourced_slug: "s" }] }],
    }),
  ).toEqual([
    "identity/created_at",
    "identity/sourced_at",
    "identity/sourced_by",
    "identity/sourced_slug",
    "identity/updated_at",
    "providers/*/addresses/*/sourced_slug",
  ]);
});

it("accepts the two documented fields that share a column name, and nothing near them", () => {
  const fallback = { cms_api: { sourced_by: "cms-marketplace-api" } };
  expect(rowProvenanceLeaks(fallback)).toEqual([]);
  expect(rowProvenanceLeaks({ sourced_by: "cms-marketplace-api" })).toEqual([
    "sourced_by",
  ]);
  const plans = { plans: [{ id: "00000TX0000001", updated_at: null }] };
  expect(rowProvenanceLeaks(plans, "/compat/v1/plans/search")).toEqual([]);
  expect(rowProvenanceLeaks(plans, "/v1/plans")).toEqual([
    "plans/*/updated_at",
  ]);
  expect(
    rowProvenanceLeaks(
      { plans: [{ created_at: null, networks: [{ updated_at: null }] }] },
      "/compat/v1/plans/search",
    ),
  ).toEqual(["plans/*/created_at", "plans/*/networks/*/updated_at"]);
});

it("planted mutant: a route that returns a whole table row fails its request", async () => {
  const app = checkResponses(new Hono());
  app.get("/clean", (c) => c.json(withoutRowProvenance(row)));
  app.get("/whole-row", (c) => c.json({ providers: [row] }));
  app.get("/text", (c) => c.text("created_at"));
  expect(await (await app.request("/clean")).json()).toEqual({
    npi: "1000000000",
    city: "HOUSTON",
  });
  expect((await app.request("/text")).status).toBe(200);
  await expect(app.request("/whole-row")).rejects.toThrow(
    "Response of /whole-row carries database row columns: providers/*/created_at",
  );
});

it("checks every app the tests build through createApp", async () => {
  const pg = new PGlite();
  const app = createApp(testDatabase(pg));
  app.get("/whole-row", (c) => c.json(row));
  await expect(app.request("/whole-row")).rejects.toThrow(
    "carries database row columns",
  );
  await pg.close();
});

it("rowJson drops exactly the five columns from a table row", async () => {
  const pg = new PGlite();
  await pg.exec(`CREATE TABLE synthetic_row(npi text, city text,
    created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(),
    sourced_by text DEFAULT 'unknown', sourced_at timestamptz, sourced_slug text DEFAULT 'unknown');
    INSERT INTO synthetic_row(npi,city) VALUES ('1000000000','HOUSTON')`);
  const { rows } = await pg.query<{ whole: object; published: object }>(
    `SELECT to_jsonb(a) AS whole, ${rowJson("a")} AS published FROM synthetic_row a`,
  );
  expect(Object.keys(rows[0]!.whole).sort()).toEqual(
    ["city", "npi", ...ROW_PROVENANCE_COLUMNS].sort(),
  );
  expect(rows[0]!.published).toEqual({ npi: "1000000000", city: "HOUSTON" });
  await pg.close();
});
