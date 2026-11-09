import { canonicalEstimateOutput } from "../mcp/canonical-estimate.js";
import { assertHonest } from "../../src/mcp/schemas.js";
import { estimatePremiums } from "../../src/services/catalog.js";
import { PGlite } from "@electric-sql/pglite";
import { beforeAll, afterAll, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../src/api/app.js";
import type { SqlSession } from "../../src/db/database.js";
import { migrate } from "../../src/db/migrate.js";
import { ingestGeo } from "../../src/ingest/geo/index.js";
import { importPufs } from "../../src/ingest/puf/import.js";
import { coreMigrations, testDatabase } from "../pglite.js";
import { fixtureFiles as geoFiles } from "../ingest/geo/helpers.js";
import { fixtureFiles } from "./helpers.js";

const db = testDatabase(new PGlite()),
  token = "synthetic-dental-test-token",
  plan = "12846TX0270005";
let directory: string, core: Awaited<ReturnType<typeof coreMigrations>>;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "openplans-dental-"));
  core = await coreMigrations();
  await migrate(db, core.directory);
  await ingestGeo(db, { files: await geoFiles() });
  expect(
    (
      await importPufs(db, {
        year: 2026,
        state: "TX",
        files: await fixtureFiles(directory),
        dataDir: directory,
      })
    ).status,
  ).toBe("ACTIVE");
  // The small real dental cut has Area 1 only. Synthetic geographic re-scope for HTTP plumbing;
  // the cache-only oracle uses the unmodified full Harris Area 10 rows.
  await db.query(
    `UPDATE rate SET rating_area_id='Rating Area 10',raw=raw || '{"RatingAreaId":"Rating Area 10"}'::jsonb WHERE base_plan_id=$1`,
    [plan],
  );
  // No medical rule is installed: it cannot authorize or price dental coverage.
});
afterAll(async () => {
  await db.close();
  await core.cleanup();
  await rm(directory, { recursive: true, force: true });
});
const member = (age: number, relationship = "subscriber", tobacco = false) => ({
  age,
  relationship,
  tobacco,
});
async function quote(
  tx: SqlSession,
  members = [member(35)],
  id = plan,
  county = "48201",
) {
  const response = await createApp(tx, { premiumToken: token }).request(
    "/v1/premium-quotes",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        plan_ids: [id],
        county,
        coverage_start: "2026-01-01",
        members,
      }),
    },
  );
  expect(response.status).toBe(200);
  return ((await response.json()) as ReturnType<typeof JSON.parse>).quotes[0];
}
async function rollback(run: (tx: SqlSession) => Promise<void>) {
  const marker = new Error("synthetic dental rollback");
  try {
    await db.transaction(async (tx) => {
      await run(tx);
      throw marker;
    });
  } catch (error) {
    if (error !== marker) throw error;
  }
}

it("accepts a SADP ID, honors statewide service areas, and keeps gross dental separate from EHB", async () => {
  const result = await quote(db, [member(35), member(10, "child")]);
  const raw = (
    await db.query<{ age_band: string; individual_rate_cents: number }>(
      `SELECT age_band,individual_rate_cents FROM rate
    WHERE base_plan_id=$1 AND rating_area_id='Rating Area 10' AND age_band IN ('35','0-14')`,
      [plan],
    )
  ).rows;
  const child = Number(
    raw.find((r) => r.age_band === "0-14")!.individual_rate_cents,
  );
  expect(result).toMatchObject({
    status: "rated",
    coverage: "dental",
    bindable_quote: false,
    total_cents: raw.reduce(
      (sum, r) => sum + Number(r.individual_rate_cents),
      0,
    ),
    pediatric_ehb: {
      status: "available",
      fraction: "1",
      pediatric_gross_cents: child,
      monthly_cents: child,
    },
  });
  expect(result.provenance.rating_rule.version).toBe("sadp-filed-v1");
  expect(result.dental_business_rules[0].source_row).toBeGreaterThan(1);
  expect(result.pediatric_ehb.attribute_rows.length).toBeGreaterThan(0);
  expect(await quote(db, [member(35, "subscriber", true)])).toMatchObject({
    status: "rated",
    total_cents: Number(
      raw.find((r) => r.age_band === "35")!.individual_rate_cents,
    ),
  });
});
it("missing or conflicting pediatric fractions stay unknown without losing the filed gross rate", async () =>
  rollback(async (tx) => {
    await tx.query(
      `UPDATE plan_attribute SET raw=raw-'EHBPediatricDentalApportionmentQuantity' WHERE base_plan_id=$1`,
      [plan],
    );
    expect(await quote(tx, [member(35), member(10, "child")])).toMatchObject({
      status: "rated",
      pediatric_ehb: { status: "unknown", monthly_cents: null },
    });
    expect(await quote(tx)).toMatchObject({
      status: "rated",
      pediatric_ehb: { status: "available", monthly_cents: 0 },
    });
  }));
it("uses the named Family Option column without inventing member premiums or pediatric allocations", async () =>
  rollback(async (tx) => {
    // Labelled synthetic filed tier conversion; the imported raw record and stored columns both change.
    await tx.query(
      `DELETE FROM rate WHERE base_plan_id=$1 AND age_band<>'35'`,
      [plan],
    );
    await tx.query(
      `UPDATE rate SET age_band='Family Option',rating_method='family_tier',individual_rate_cents=1000,
    primary_subscriber_and_two_dependents_cents=4000,primary_subscriber_and_three_or_more_dependents_cents=5000,
    raw=raw || '{"Age":"Family Option","IndividualRate":"10","PrimarySubscriberAndTwoDependents":"40","PrimarySubscriberAndThreeOrMoreDependents":"50"}'::jsonb WHERE base_plan_id=$1`,
      [plan],
    );
    const canonical = await estimatePremiums(tx, {
      plan_ids: [plan],
      county: "48201",
      coverage_start: "2026-01-01",
      members: [member(35), member(10, "child"), member(12, "child")],
    });
    assertHonest(
      "quote_premiums",
      await canonicalEstimateOutput(tx, canonical.estimates),
      canonical,
    );
    expect(
      await quote(tx, [member(35), member(10, "child"), member(12, "child")]),
    ).toMatchObject({
      status: "rated",
      total_cents: 4000,
      coverage: "dental",
      quote_method: "filed_dental_family_option",
      filed_column: "PrimarySubscriberAndTwoDependents",
      members: [],
      pediatric_ehb: { status: "unknown", monthly_cents: null, fraction: "1" },
    });
  }));
it("missing membership/rule evidence and out-of-area plans never produce a price", async () =>
  rollback(async (tx) => {
    await tx.query("DELETE FROM business_rule WHERE base_plan_id=$1", [plan]);
    expect(await quote(tx)).toMatchObject({
      status: "unsupported_rating_method",
      reason: "DENTAL_AGE_DETERMINATION_UNPROVED",
    });
    expect(await quote(tx, [member(35)], plan, "36061")).toMatchObject({
      status: "missing",
      reason: "PLAN_NOT_OFFERED_IN_LOCATION",
    });
  }));
it("negative control: NY/VT SADPs reject even a federal PUF catalog mislabelled as that state", async () => {
  for (const state of ["NY", "VT"])
    await rollback(async (tx) => {
      const id = plan.replace("TX", state);
      await tx.query(`UPDATE puf_active_catalog SET state=$1;`, [state]);
      await tx.query(
        `UPDATE plan SET state=$1,base_plan_id=replace(base_plan_id,'TX',$1)`,
        [state],
      );
      const result = await quote(
        tx,
        [member(35)],
        id,
        state === "NY" ? "36061" : "50007",
      );
      expect(result).toMatchObject({
        coverage: "dental",
        status: "unsupported_rating_method",
        bindable_quote: false,
      });
      expect(result).not.toHaveProperty("total_cents");
      expect(result.rate_rows_used).toEqual([]);
    });
});

it("MCP contract retains dental business rules, pediatric allocation and noncharged dependents", async () => {
  const canonical = await estimatePremiums(db, {
    plan_ids: [plan],
    county: "48201",
    coverage_start: "2026-01-01",
    members: [
      member(35),
      ...[10, 11, 12, 13].map((age) => member(age, "child")),
    ],
  });
  const output = await canonicalEstimateOutput(db, canonical.estimates);
  assertHonest("quote_premiums", output, canonical);
  expect(output.data!.quotes[0]).toMatchObject({
    coverage: "dental",
    quote_method: "filed_dental_per_member",
    dental_business_rules: [{ fields: expect.any(Array) }],
    pediatric_ehb: { field: "EHBPediatricDentalApportionmentQuantity" },
  });
});
