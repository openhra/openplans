import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/api/app.js";
import { resolveLocation } from "../../src/api/repository.js";
import { premiumRequest } from "../../src/api/validation.js";
import type { SqlSession } from "../../src/db/database.js";
import { ingestRatingRules } from "../../src/ingest/rating-rules/index.js";
import { householdSubsidy } from "../../src/services/subsidies.js";
import { callTool } from "../../src/mcp/tools.js";
import { setup, TOKEN, headers, searchBody } from "../compat/v1/helpers.js";

// SYNTHETIC households and a SYNTHETIC service-area edit (rolled back) over the TX fixture cut.
// The fixture loads no NY or VT state catalog and no ZCTA rows for ZIP 10001.
type Json = ReturnType<typeof JSON.parse>;
let h: Awaited<ReturnType<typeof setup>>;
beforeAll(async () => {
  h = await setup();
  await ingestRatingRules(
    h.db,
    fileURLToPath(
      new URL("../../data/rating-rules/2026.json", import.meta.url),
    ),
  );
}, 120_000);
afterAll(async () => {
  await h?.close();
});

const PLAN = "20069TX0100006";
const PART_COUNTY = `UPDATE service_area_county SET partial_county=true, zip_codes='77002' WHERE service_area_id='TXS003' AND county_fips='48201'`;
const income = {
  household_income: 31_300,
  household_size: 1,
  tax_filing: "single",
};
async function partCounty<T>(run: (tx: SqlSession) => Promise<T>) {
  const marker = new Error("synthetic part-county rollback");
  let result: T | undefined;
  await expect(
    h.db.transaction(async (tx) => {
      await tx.query(PART_COUNTY);
      result = await run(tx);
      throw marker;
    }),
  ).rejects.toBe(marker);
  return result!;
}
async function compatGaps(db: SqlSession, extra: Record<string, unknown>) {
  const response = await createApp(db, { premiumToken: TOKEN }).request(
    "/compat/v1/plans/medical/search",
    {
      method: "POST",
      headers,
      body: JSON.stringify(searchBody({ applicants: [{ age: 40 }], ...extra })),
    },
  );
  expect(response.status).toBe(200);
  return (response.headers.get("x-openplans-gaps") ?? "").split(", ");
}
async function subsidyFor(db: SqlSession, location: Record<string, string>) {
  const request = premiumRequest({
    plan_ids: [PLAN],
    ...location,
    coverage_start: "2026-01-01",
    members: [{ age: 40, tobacco: false, relationship: "subscriber" }],
    household_income_annual: 31_300,
    household_size: 1,
    tax_filing: "single",
  });
  return (await householdSubsidy(
    db,
    request,
    await resolveLocation(db, request.location),
  ))!;
}
async function nativeJson(db: SqlSession, path: string, body?: unknown) {
  const response = await createApp(db, { premiumToken: TOKEN }).request(
    path,
    body === undefined
      ? {}
      : {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
  );
  expect(response.status, path).toBe(200);
  return (await response.json()) as Json;
}
const mcp = async (
  db: SqlSession,
  tool: "search_plans" | "quote_plans",
  input: unknown,
) =>
  (await callTool({ db: db as never }, tool, input)).structuredContent as Json;

describe("county-only requests where a plan serves part of the county", () => {
  it("compatibility search names zip_limited_service_area, with and without income", async () => {
    const [withIncome, grossOnly] = await partCounty(async (tx) => [
      await compatGaps(tx, income),
      await compatGaps(tx, {}),
    ]);
    expect(withIncome).toContain("subsidy_location_requires_zip");
    expect(withIncome).toContain("zip_limited_service_area");
    // The part-county plan is left out of a county-only list; the gap says why.
    expect(grossOnly).toContain("zip_limited_service_area");
  });

  it("native plan search and public quotes list the issue instead of a silently shorter list", async () => {
    const { search, quotes, withZip } = await partCounty(async (tx) => ({
      search: await nativeJson(tx, "/v1/plans?county=48201&year=2026"),
      quotes: await nativeJson(tx, "/v1/quotes", {
        county: "48201",
        year: 2026,
        members: [{ age: 40 }],
      }),
      withZip: await nativeJson(tx, "/v1/plans?zip=77002&year=2026"),
    }));
    expect(search.issues).toEqual(["zip_limited_service_area"]);
    expect(quotes.issues).toEqual(["zip_limited_service_area"]);
    expect(withZip.issues).toEqual([]);
  });

  it("MCP search_plans and quote_plans carry the issue", async () => {
    const { search, quote } = await partCounty(async (tx) => ({
      search: await mcp(tx, "search_plans", {
        year: 2026,
        location: { county: "48201" },
      }),
      quote: await mcp(tx, "quote_plans", {
        year: 2026,
        location: { county: "48201" },
        members: [{ age: 40 }],
      }),
    }));
    expect(search.error).toBeNull();
    expect(search.data.location_issues).toEqual(["zip_limited_service_area"]);
    expect(quote.error).toBeNull();
    expect(quote.data.location_issues).toEqual(["zip_limited_service_area"]);
  });
});

describe("ZIPs and states that are not loaded", () => {
  it("the native subsidy reason names the missing geography or state catalog", async () => {
    const unloaded = await subsidyFor(h.db, { zip: "10001" });
    expect(unloaded.estimated_monthly_tax_credit_cents).toBeNull();
    expect(unloaded.reason).toBe("zip_not_in_loaded_geography");
    const ny = await subsidyFor(h.db, { county: "36061" });
    expect(ny.estimated_monthly_tax_credit_cents).toBeNull();
    expect(ny.status).toBe("unsupported_rating_method");
    expect(ny.reason).toBe("state_catalog_not_loaded");
  });

  it("compatibility search names zip_not_in_loaded_geography for an unloaded ZIP", async () => {
    const gaps = await compatGaps(h.db, {
      fips_code: "36061",
      zip_code: "10001",
      ...income,
    });
    expect(gaps).toContain("zip_not_in_loaded_geography");
  });

  it("compatibility search names state_catalog_not_loaded instead of a bare empty list", async () => {
    for (const extra of [{}, income]) {
      const gaps = await compatGaps(h.db, { fips_code: "36061", ...extra });
      expect(gaps).toContain("state_catalog_not_loaded");
    }
  });

  it("native plan search names state_catalog_not_loaded and zip_not_in_loaded_geography", async () => {
    expect(
      (await nativeJson(h.db, "/v1/plans?county=36061&year=2026")).issues,
    ).toEqual(["state_catalog_not_loaded"]);
    expect(
      (await nativeJson(h.db, "/v1/plans?zip=10001&year=2026")).issues,
    ).toEqual(["zip_not_in_loaded_geography"]);
  });
});
