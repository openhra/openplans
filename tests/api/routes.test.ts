import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApp } from "../../src/api/app.js";
import type { SqlSession } from "../../src/db/database.js";
import { migrate } from "../../src/db/migrate.js";
import { ingestGeo } from "../../src/ingest/geo/index.js";
import { importPufs } from "../../src/ingest/puf/import.js";
import {
  defaultRulesFile,
  ingestRatingRules,
} from "../../src/ingest/rating-rules/index.js";
import { coreMigrations, testDatabase } from "../pglite.js";
import { fixtureFiles as geoFiles } from "../ingest/geo/helpers.js";
import { fixtureFiles } from "./helpers.js";

const TOKEN = "synthetic-api-test-token",
  PLAN = "87226TX0100013";
const db = testDatabase(new PGlite()),
  app = createApp(db, { premiumToken: TOKEN });
let directory: string,
  core: Awaited<ReturnType<typeof coreMigrations>>,
  attributes: string,
  rate: string,
  service: string;
const body = (extra = {}) => ({
  plan_ids: [PLAN],
  county: "48201",
  coverage_start: "2026-01-01",
  members: [{ age: 35, tobacco: false, relationship: "subscriber" }],
  ...extra,
});
async function estimate(payload: unknown = body(), session: SqlSession = db) {
  const response = await createApp(session, { premiumToken: TOKEN }).request(
    "/v1/premium-estimates",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify(payload),
    },
  );
  return { response, json: (await response.json()) as any };
}
async function search(query = "zip=77002&year=2026", session: SqlSession = db) {
  const response = await createApp(session).request(`/v1/plans?${query}`);
  return { response, json: (await response.json()) as any };
}
async function rollback(run: (tx: SqlSession) => Promise<void>) {
  const marker = new Error("synthetic mutation rollback");
  await expect(
    db.transaction(async (tx) => {
      await run(tx);
      throw marker;
    }),
  ).rejects.toBe(marker);
}
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "openplans-api-"));
  core = await coreMigrations();
  await migrate(db, core.directory);
  await ingestGeo(db, { files: await geoFiles() });
  const report = await importPufs(db, {
    year: 2026,
    state: "TX",
    files: await fixtureFiles(directory),
    dataDir: directory,
  });
  expect(report.status, JSON.stringify(report)).toBe("ACTIVE");
  attributes = `${report.import_id}:plan-attributes`;
  rate = `${report.import_id}:rate`;
  service = `${report.import_id}:service-area`;
  await ingestRatingRules(db);
});
afterAll(async () => {
  await db.close();
  await core.cleanup();
  await rm(directory, { recursive: true, force: true });
});

describe("native v1 catalog, geography and provenance", () => {
  it("returns all ZCTA county shares and never guesses a PO-box ZIP", async () => {
    const multi = await app.request("/v1/zip-counties?zip=75034");
    expect(multi.status).toBe(200);
    const result = (await multi.json()) as any;
    expect(result.counties.map((c: any) => c.county_fips)).toEqual([
      "48085",
      "48121",
    ]);
    expect(
      result.counties.reduce(
        (sum: number, c: any) => sum + Number(c.zcta_land_share),
        0,
      ),
    ).toBeCloseTo(1, 12);
    const unknown = await app.request("/v1/zip-counties?zip=77001");
    expect(await unknown.json()).toMatchObject({
      status: "unknown",
      counties: [],
    });
    expect((await search("zip=77001&year=2026")).json).toMatchObject({
      status: "unknown",
      plans: [],
    });
  });

  it("requires a choice for a multi-county ZIP, and rejects ZIP/county conflicts", async () => {
    expect((await search("zip=75034&year=2026")).json).toMatchObject({
      status: "ambiguous",
      plans: [],
      location: { counties: expect.any(Array) },
    });
    expect(
      (await search("zip=75034&county=48085&year=2026")).response.status,
    ).toBe(200);
    expect(
      (await search("zip=77002&county=48085&year=2026")).response.status,
    ).toBe(400);
    expect(
      (await estimate(body({ zip: "75034", county: undefined }))).json
        .estimates[0],
    ).toMatchObject({ status: "ambiguous" });
    expect(
      (await estimate(body({ zip: "77001", county: undefined }))).json
        .estimates[0],
    ).toMatchObject({ status: "unknown" });
  });

  it("lists medical plans with base/variant IDs, issuer, network, exchange flags and snapshot IDs", async () => {
    const { response, json } = await search();
    expect(response.status).toBe(200);
    expect(json.status).toBe("available");
    const plan = json.plans.find((p: any) => p.base_plan_id === PLAN);
    expect(plan).toMatchObject({
      variant_ids: [expect.stringMatching(/^87226TX0100013-\d\d$/)],
      issuer: { issuer_id: "87226" },
      network: { network_id: expect.any(String), status: "available" },
      on_exchange: true,
      provenance: { snapshot_ids: { "plan-attributes": attributes, rate } },
    });
    expect(json.plans.some((p: any) => p.issuer.issuer_id === "12846")).toBe(
      false,
    );
    expect(
      (
        await search(
          `zip=77002&year=2026&metal=${plan.metal.toLowerCase()}&page=1`,
        )
      ).json.plans.every((p: any) => p.metal === plan.metal),
    ).toBe(true);
    expect((await search("zip=77002&year=2026&page=2")).json.plans).toEqual([]);
    expect((await search("county=36061&year=2026")).json.status).toBe(
      "unknown",
    );
    expect((await search("zip=77002&year=2027")).json.status).toBe("unknown");
  });

  it("D3: a synthetic statewide medical service area appears in every TX county", async () => {
    await rollback(async (tx) => {
      await tx.query(
        `UPDATE service_area_county SET cover_entire_state=true,county_fips=NULL,partial_county=false,zip_codes=''
        WHERE snapshot_id=$1 AND issuer_id='87226'`,
        [service],
      );
      expect(
        (await search("county=48001&year=2026", tx)).json.plans.some(
          (p: any) => p.base_plan_id === PLAN,
        ),
      ).toBe(true);
    });
  });

  it("negative control D4: ZIP restriction {77002} excludes 77003 and county-only requests", async () => {
    await rollback(async (tx) => {
      await tx.query(
        `UPDATE service_area_county SET cover_entire_state=false,partial_county=true,zip_codes='77002'
        WHERE snapshot_id=$1 AND issuer_id='87226' AND county_fips='48201'`,
        [service],
      );
      const listed = async (query: string) =>
        (await search(query, tx)).json.plans.some(
          (p: any) => p.base_plan_id === PLAN,
        );
      expect(await listed("zip=77002&year=2026")).toBe(true);
      expect(await listed("zip=77003&year=2026")).toBe(false);
      expect(await listed("county=48201&year=2026")).toBe(false);
      const premium = (await estimate(body({ zip: "77003" }), tx)).json
        .estimates[0];
      expect(premium).toMatchObject({
        status: "missing",
        reason: "PLAN_NOT_OFFERED_IN_LOCATION",
      });
      expect(premium).not.toHaveProperty("total_cents");
    });
  });

  it("returns selected standard evidence as unknown when only an off-exchange variant is loaded", async () => {
    const base = await app.request(`/v1/plans/${PLAN}?year=2026`),
      detail = (await base.json()) as any;
    expect(base.status).toBe(200);
    expect(detail.variant_cost_sharing_resolved).toBe(false);
    expect(detail.benefits).toEqual([]);
    expect(detail.cost_sharing).toMatchObject({
      status: "unknown",
      selected_variant_id: `${PLAN}-01`,
    });
    expect(detail.variants[0].benefits).toHaveLength(5);
    expect(detail.variants[0].benefits[0]).toMatchObject({
      cost_sharing_raw: expect.any(Object),
      cost_sharing_parsed: expect.any(Object),
      raw: expect.any(Object),
      snapshot_id: expect.any(String),
    });
    const variant = await app.request(
      `/v1/plans/${detail.variant_ids[0]}?year=2026`,
    );
    expect(await variant.json()).toMatchObject({
      requested_variant_id: detail.variant_ids[0],
      variant_cost_sharing_resolved: true,
    });
    expect((await app.request(`/v1/plans/${PLAN}-99?year=2026`)).status).toBe(
      404,
    );
    expect(
      (await app.request("/v1/plans/99999TX0100001?year=2026")).status,
    ).toBe(404);
  });

  it("lists only imported carriers, networks and manifest evidence, with optional year/state filters", async () => {
    const carriers = await app.request("/v1/carriers?state=TX"),
      networks = await app.request("/v1/networks?state=TX&year=2026");
    expect(((await carriers.json()) as any).carriers).toHaveLength(4);
    expect(((await networks.json()) as any).networks).toHaveLength(4);
    expect(await (await app.request("/v1/carriers?state=NY")).json()).toEqual({
      status: "unknown",
      carriers: [],
    });
    const manifest = (await (
      await app.request("/v1/data-availability?state=TX&year=2026")
    ).json()) as any[];
    expect(manifest.length).toBeGreaterThan(0);
    expect(
      manifest.every(
        (row) =>
          row.catalog_status === "available" &&
          row.provider_status === "unknown" &&
          row.formulary_status === "unknown",
      ),
    ).toBe(true);
    expect(
      manifest
        .filter((row) => row.issuer_id !== "12846")
        .every(
          (row) => row.premium_status === "available" && row.rate_rows > 0,
        ),
    ).toBe(true);
    expect(
      manifest.find((row) => row.issuer_id === "12846").premium_status,
    ).toBe("unsupported");
    expect(
      await (await app.request("/v1/data-availability?state=NY")).json(),
    ).toEqual([]);
  });
});

describe("native v1 household gross premiums", () => {
  it("matches 87226TX0100013 age 35, Rating Area 10 = 52928 cents, with rate-row evidence", async () => {
    const { response, json } = await estimate();
    expect(response.status).toBe(200);
    const result = json.estimates[0];
    expect(result).toMatchObject({
      status: "rated",
      total_cents: 52928,
      rating_area_id: "Rating Area 10",
      members: [{ age: 35, charged: true, premium_cents: 52928 }],
      rate_rows_used: [
        {
          age_band: 35,
          provenance: { snapshot_id: rate, source_row: expect.any(Number) },
        },
      ],
    });
    expect(result).not.toHaveProperty("subsidy");
    const dob = await estimate(
      body({
        members: [
          { dob: "1990-01-02", tobacco: false, relationship: "subscriber" },
        ],
      }),
    );
    expect(dob.json.estimates[0].total_cents).toBe(52928);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("negative control: +1 cent mutant fails the exact oracle assertion", async () => {
    const mutantDirectory = join(directory, "synthetic-plus-one-cent");
    await mkdir(mutantDirectory);
    const files = await fixtureFiles(mutantDirectory, (row) => {
      if (row.PlanId === PLAN && row.Age === "35")
        row.IndividualRate = "529.29";
    });
    await rollback(async (tx) => {
      const mutantDb = {
        ...db,
        ...tx,
        transaction: async <T>(run: (session: SqlSession) => Promise<T>) =>
          run(tx),
      };
      const imported = await importPufs(mutantDb, {
        state: "TX",
        year: 2026,
        files,
        dataDir: mutantDirectory,
      });
      expect(imported.status).toBe("ACTIVE");
      const result = (await estimate(body(), tx)).json.estimates[0];
      expect(result.total_cents).toBe(52929);
      expect(() =>
        assert.equal(result.total_cents, 52928, "CMS/oracle exact-cent check"),
      ).toThrow("CMS/oracle exact-cent check");
    });
  });

  it("uses the filed tobacco column, normalizes variant IDs and respects rate intervals", async () => {
    const variant = (
      (await (await app.request(`/v1/plans/${PLAN}?year=2026`)).json()) as any
    ).variant_ids[0];
    const tobacco = (
      await estimate(
        body({
          plan_ids: [variant],
          members: [{ age: 35, tobacco: true, relationship: "subscriber" }],
        }),
      )
    ).json.estimates[0];
    expect(tobacco).toMatchObject({
      plan_id: variant,
      base_plan_id: PLAN,
      status: "rated",
      total_cents: 60867,
    });
    await rollback(async (tx) => {
      // Synthetic shortened filing interval, leaving the source fixture untouched.
      await tx.query(
        `UPDATE rate SET effective_date='2026-02-01',expiration_date='2026-06-30' WHERE snapshot_id=$1 AND base_plan_id=$2`,
        [rate, PLAN],
      );
      expect((await estimate(body(), tx)).json.estimates[0]).toMatchObject({
        status: "missing",
      });
      expect(
        (await estimate(body({ coverage_start: "2026-02-01" }), tx)).json
          .estimates[0],
      ).toMatchObject({ status: "rated", total_cents: 52928 });
      const expired = (
        await estimate(body({ coverage_start: "2026-07-01" }), tx)
      ).json.estimates[0];
      expect(expired.status).toBe("missing");
      expect(expired).not.toHaveProperty("total_cents");
    });
  });

  it("rejects family-tier evidence even with a supported state rule", async () => {
    await rollback(async (tx) => {
      // Synthetic method mutation, with no invented family-tier price.
      await tx.query(
        `UPDATE rate SET rating_method='family_tier' WHERE snapshot_id=$1 AND base_plan_id=$2`,
        [rate, PLAN],
      );
      const result = (await estimate(body(), tx)).json.estimates[0];
      expect(result.status).toBe("unsupported_rating_method");
      expect(result).not.toHaveProperty("total_cents");
    });
  });

  it("negative control: removing TX from the file makes its premium unsupported with no total", async () => {
    const document = JSON.parse(await readFile(defaultRulesFile, "utf8"));
    document.rules = [];
    const path = join(directory, "synthetic-rules-without-tx.json");
    await writeFile(path, JSON.stringify(document));
    try {
      await ingestRatingRules(db, path);
      const result = (await estimate()).json.estimates[0];
      expect(result.status).toBe("unsupported_rating_method");
      expect(result).not.toHaveProperty("total_cents");
    } finally {
      await ingestRatingRules(db);
    }
  });

  it("negative control: NY household ages/tobacco never trigger per-member math", async () => {
    await rollback(async (tx) => {
      // Synthetic NY catalog shell only. No invented NY rate or benefit evidence.
      await tx.exec(`INSERT INTO source(source_id,publisher,source_kind) VALUES ('synthetic-ny','Synthetic test catalog','synthetic');
        INSERT INTO snapshot(snapshot_id,source_id) VALUES ('synthetic-ny-import','synthetic-ny'),('synthetic-ny-attributes','synthetic-ny');
        INSERT INTO puf_import(import_id,state,plan_year) VALUES ('synthetic-ny-import','NY',2026);
        INSERT INTO puf_import_file(import_id,kind,snapshot_id) VALUES ('synthetic-ny-import','plan-attributes','synthetic-ny-attributes');
        INSERT INTO puf_active_catalog(state,plan_year,import_id) VALUES ('NY',2026,'synthetic-ny-import')`);
      await tx.query(
        `INSERT INTO plan SELECT 'synthetic-ny-attributes',source_row,plan_year,'NY',issuer_id,replace(base_plan_id,'TX','NY'),
        market,metal,dental_only,network_id,service_area_id,'Synthetic NY catalog shell',exchange_status,on_exchange,off_exchange
        FROM plan WHERE snapshot_id=$1 AND base_plan_id=$2`,
        [attributes, PLAN],
      );
      for (const age of [20, 60])
        for (const tobacco of [false, true]) {
          const result = (
            await estimate(
              body({
                plan_ids: [PLAN.replace("TX", "NY")],
                county: "36061",
                members: [{ age, tobacco, relationship: "subscriber" }],
              }),
              tx,
            )
          ).json.estimates[0];
          expect(result.status).toBe("unsupported_rating_method");
          expect(result).not.toHaveProperty("total_cents");
          expect(result.members).toEqual([]);
        }
    });
  });

  it("rates four children using only the three oldest under 21", async () => {
    const result = (
      await estimate(
        body({
          members: [35, 10, 18, 20, 15].map((age, index) => ({
            age,
            tobacco: false,
            relationship: index ? "child" : "subscriber",
          })),
        }),
      )
    ).json.estimates[0];
    expect(result.status).toBe("rated");
    expect(result.members[1]).toMatchObject({
      age: 10,
      charged: false,
      premium_cents: 0,
    });
    expect(result.rate_rows_used).toHaveLength(4);
    expect(result.total_cents).toBe(
      result.members.reduce((sum: number, m: any) => sum + m.premium_cents, 0),
    );
  });

  it("returns missing, unknown and ambiguous without any numeric household total", async () => {
    await rollback(async (tx) => {
      await tx.query(
        `DELETE FROM rate WHERE snapshot_id=$1 AND base_plan_id=$2 AND age_band='35'`,
        [rate, PLAN],
      );
      const result = (await estimate(body(), tx)).json.estimates[0];
      expect(result.status).toBe("missing");
      expect(result).not.toHaveProperty("total_cents");
    });
    await rollback(async (tx) => {
      await tx.query(
        `UPDATE rate SET individual_rate_cents=NULL WHERE snapshot_id=$1 AND base_plan_id=$2 AND age_band='35'`,
        [rate, PLAN],
      );
      const result = (await estimate(body(), tx)).json.estimates[0];
      expect(result.status).toBe("unknown");
      expect(result).not.toHaveProperty("total_cents");
    });
    await rollback(async (tx) => {
      await tx.query(
        `UPDATE rate SET age_band='35',raw=jsonb_set(raw,'{Age}','"35"') WHERE snapshot_id=$1 AND base_plan_id=$2 AND age_band='36'`,
        [rate, PLAN],
      );
      const result = (await estimate(body(), tx)).json.estimates[0];
      expect(result.status).toBe("ambiguous");
      expect(result).not.toHaveProperty("total_cents");
    });
  });

  it("requires authentication and does not echo household details in errors", async () => {
    const response = await app.request("/v1/premium-estimates", {
      method: "POST",
      body: JSON.stringify(body()),
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: { code: "UNAUTHORIZED" } });
    expect(
      (
        await createApp(db, {}).request("/v1/premium-estimates", {
          method: "POST",
        })
      ).status,
    ).toBe(503);
  });

  it("rejects malformed query, body, date, member and IDs with machine-readable errors", async () => {
    for (const url of [
      "/v1/zip-counties?zip=1234",
      "/v1/plans?zip=77002",
      "/v1/plans?zip=77002&year=2026&page=0",
      "/v1/plans?zip=77002&year=2026&market=shop",
      "/v1/plans?zip=77002&year=2026&metal=plastic",
      "/v1/plans/bad?year=2026",
      `/v1/plans/${PLAN}`,
      "/v1/networks?state=XX",
      "/v1/data-availability?year=bad",
    ]) {
      const response = await app.request(url);
      expect(response.status, url).toBe(400);
      expect(await response.json()).toMatchObject({
        error: { code: expect.any(String), field: expect.any(String) },
      });
    }
    for (const invalid of [
      null,
      [],
      body({ plan_ids: [] }),
      body({ county: undefined }),
      body({ coverage_start: "2026-02-30" }),
      body({
        members: [
          {
            age: 35,
            dob: "1990-01-01",
            tobacco: false,
            relationship: "subscriber",
          },
        ],
      }),
      body({
        members: [{ age: -1, tobacco: false, relationship: "subscriber" }],
      }),
      body({
        members: [{ age: 35, tobacco: "false", relationship: "subscriber" }],
      }),
      body({
        members: [{ dob: "2027-01-01", tobacco: false, relationship: "child" }],
      }),
    ]) {
      const { response, json } = await estimate(invalid);
      expect(response.status).toBe(400);
      expect(json).toMatchObject({
        error: { code: expect.any(String), field: expect.any(String) },
      });
    }
    expect(
      (await estimate(body({ plan_ids: ["99999TX0100001"] }))).response.status,
    ).toBe(404);
    const malformed = await app.request("/v1/premium-estimates", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` },
      body: "{bad",
    });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({
      error: { code: "INVALID_JSON" },
    });
  });
});
