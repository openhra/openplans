import { afterAll, beforeAll, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { estimatePremiums } from "../../src/services/catalog.js";
import { assertHonest } from "../../src/mcp/schemas.js";
import { ingestStateRates } from "../../src/ingest/state/index.js";
import { entityId, parseEntityId } from "../../src/services/discovery.js";
import { setup } from "../compat/v1/helpers.js";
import { connect } from "./client.js";

// Shared regenerable real CMS/RxNorm cuts; every household and credential is synthetic.
let fixture: Awaited<ReturnType<typeof setup>>,
  h: Awaited<ReturnType<typeof connect>>;
beforeAll(async () => {
  fixture = await setup();
  h = await connect({
    db: fixture.db,
    principal: { id: "synthetic-estimate-test" },
    policy: { canEstimate: () => true },
  });
});
afterAll(async () => {
  await h?.close();
  await fixture?.close();
});

it("preserves the full-catalog subsidy benchmark and independent whole-dollar calculation", async () => {
  const members = [{ age: 40, tobacco: false, relationship: "subscriber" }];
  const input = {
    plan_refs: ["87226TX0100013"],
    location: { county: "48201" },
    coverage_start: "2026-01-01",
    members,
    household: { income_annual: 31_300, size: 1, tax_filing: "single" },
  };
  // Paging a plan search cannot change which silver plans the canonical benchmark considers.
  await h.call("search_plans", {
    location: input.location,
    year: 2026,
    limit: 1,
  });
  const result = await h.call("estimate_premiums", input);
  expect(result.data?.estimates[0]).toMatchObject({
    gross_monthly_cents: 55_354,
    estimated_credit_cents: 42_005,
    estimated_net_cents: 13_349,
    benchmark_cents: 59_205,
    subsidy_status: "estimated",
    bindable_quote: false,
    subsidy: { benchmark: { benchmark_plan_ids: ["87226TX0100011"] } },
  });
  const native = await estimatePremiums(fixture.db, {
    plan_ids: input.plan_refs,
    ...input.location,
    coverage_start: input.coverage_start,
    members,
    household_income_annual: 31_300,
    household_size: 1,
    tax_filing: "single",
  });
  assertHonest("estimate_premiums", result, native);
});

it("preserves filed state plan keys, HIOS absence, raw cells and resource percent-encoding", async () => {
  // Registration path is temporary; source publication bytes and metadata remain the real cut.
  const directory = await mkdtemp("/tmp/openplans-mcp-state-");
  try {
    for (const state of ["NY", "VT"] as const) {
      const path = join(directory, `${state}.json`);
      await writeFile(
        path,
        await readFile(
          new URL(
            `../fixtures/state/${state.toLowerCase()}-2026.json`,
            import.meta.url,
          ),
        ),
      );
      await ingestStateRates(fixture.db, path, state, { verifyRaw: false });
    }
    const id = entityId("plan", 2026, "BCBSVT:Gold Plan");
    expect(id).toBe("plan:2026:BCBSVT%3AGold%20Plan");
    expect(parseEntityId(id)).toEqual({
      kind: "plan",
      parts: ["2026", "BCBSVT:Gold Plan"],
    });
    const fetched = await h.call("fetch", { id });
    expect(fetched.data?.records[0]).toMatchObject({
      plan_ref: "BCBSVT:Gold Plan",
      plan_key: "BCBSVT:Gold Plan",
      hios_id: null,
    });
    const resource = await h.client.readResource({
      uri: "openplans://plan/2026/BCBSVT%3AGold%20Plan",
    });
    const content = resource.contents[0]!;
    if (!("text" in content)) throw new Error("Missing state resource");
    expect(JSON.parse(content.text).data.plan.plan_key).toBe(
      "BCBSVT:Gold Plan",
    );
    // $1,345.45 is the unmodified VT publication's single cell.
    for (const [plan, county, expected] of [
      ["11177NY0220001", "36061", 127_098],
      ["BCBSVT:Gold Plan", "50007", 134_545],
    ] as const) {
      const members = [{ age: 40, tobacco: false, relationship: "subscriber" }];
      const result = await h.call("estimate_premiums", {
        plan_refs: [plan],
        location: { county },
        coverage_start: "2026-01-01",
        members,
      });
      expect(result.data!.estimates[0]).toMatchObject({
        gross_monthly_cents: expected,
        quote_method: "state_filed_tier",
        bindable_quote: false,
      });
      const native = await estimatePremiums(fixture.db, {
        plan_ids: plan.includes(":") ? [] : [plan],
        plan_keys: plan.includes(":") ? [plan] : [],
        county,
        coverage_start: "2026-01-01",
        members,
      });
      assertHonest("estimate_premiums", result, native);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
