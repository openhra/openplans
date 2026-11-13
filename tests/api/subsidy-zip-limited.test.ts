import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/api/app.js";
import { resolveLocation } from "../../src/api/repository.js";
import { premiumRequest } from "../../src/api/validation.js";
import type { SqlSession } from "../../src/db/database.js";
import { benchmark as benchmarkService } from "../../src/services/subsidies.js";
import { estimatePremiums } from "../../src/services/catalog.js";
import { assertHonest } from "../../src/mcp/schemas.js";
import { canonicalEstimateOutput } from "../mcp/canonical-estimate.js";
import { setup, TOKEN, headers, searchBody } from "../compat/v1/helpers.js";
import { replaceSyntax, rebaseImports } from "../source-mutation.js";

// SYNTHETIC household and a SYNTHETIC service-area edit (rolled back) over real CMS Harris
// source cuts: service area TXS003 (which holds the county's second-lowest silver plan) is
// narrowed to part of the county, ZIP 77002 only. The requested plan sits in TXS001.
type Json = ReturnType<typeof JSON.parse>;
let h: Awaited<ReturnType<typeof setup>>;
beforeAll(async () => {
  h = await setup();
});
afterAll(async () => {
  await h?.close();
});
const PLAN = "20069TX0100006";
const PART_COUNTY = `UPDATE service_area_county SET partial_county=true, zip_codes='77002' WHERE service_area_id='TXS003' AND county_fips='48201'`;
const body = (location: Record<string, string>) => ({
  plan_ids: [PLAN],
  ...location,
  coverage_start: "2026-01-01",
  members: [{ age: 40, tobacco: false, relationship: "subscriber" }],
  household_income_annual: 31_300,
  household_size: 1,
  tax_filing: "single",
});
const county = { county: "48201" },
  zip = { zip: "77002" };
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
async function native(db: SqlSession, location: Record<string, string>) {
  const response = await createApp(db, { premiumToken: TOKEN }).request(
    "/v1/premium-quotes",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify(body(location)),
    },
  );
  expect(response.status).toBe(200);
  return ((await response.json()) as Json).quotes[0];
}
async function route(db: SqlSession, query: string) {
  const response = await createApp(db, { premiumToken: TOKEN }).request(
    `/v1/benchmark?${query}&year=2026&ages=40`,
    { headers: { authorization: `Bearer ${TOKEN}` } },
  );
  return (await response.json()) as Json;
}
async function silverUnderTest(db: SqlSession) {
  // The edit must reach an on-exchange silver plan, or the tests below prove nothing.
  const { rows } = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM service_area_county WHERE service_area_id='TXS003' AND county_fips='48201' AND partial_county`,
  );
  return rows[0]!.n;
}

describe("county-only quotes where a silver plan serves part of the county", () => {
  it("leaves benchmark, credit and net unknown with location_requires_zip; gross unchanged", async () => {
    const before = await native(h.db, county);
    expect(before.subsidy_status).toBe("estimated");
    const { countyOnly, withZip, benchmarkCounty, benchmarkZip, marked } =
      await partCounty(async (tx) => ({
        marked: await silverUnderTest(tx),
        countyOnly: await native(tx, county),
        withZip: await native(tx, zip),
        benchmarkCounty: await route(tx, "county=48201"),
        benchmarkZip: await route(tx, "zip=77002"),
      }));
    expect(marked).toBe(1);
    expect(countyOnly).toMatchObject({
      status: "rated",
      total_cents: before.total_cents,
      subsidy_status: "location_requires_zip",
      slcsp_monthly_cents: null,
      estimated_monthly_tax_credit_cents: null,
      estimated_net_monthly_cents: null,
      subsidy: {
        status: "location_requires_zip",
        reason: "zip_limited_service_area",
        benchmark: {
          status: "location_requires_zip",
          issues: ["zip_limited_service_area"],
        },
      },
    });
    expect(benchmarkCounty).toMatchObject({
      status: "location_requires_zip",
      slcsp_monthly_cents: null,
      lowest_silver_plans: [],
    });
    // With the ZIP inside the narrowed area every plan is offered: the answer does not move.
    expect(withZip).toEqual(await native(h.db, zip));
    expect(withZip).toMatchObject({
      subsidy_status: "estimated",
      slcsp_monthly_cents: 59_205,
    });
    expect(benchmarkZip).toEqual(await route(h.db, "zip=77002"));
    expect(benchmarkZip.status).toBe("calculated");
  });

  it("the compatibility search reports no credit and the gap", async () => {
    const before = await native(h.db, county);
    const result = await partCounty(async (tx) => {
      const response = await createApp(tx, { premiumToken: TOKEN }).request(
        "/compat/v1/plans/medical/search",
        {
          method: "POST",
          headers,
          body: JSON.stringify(
            searchBody({
              applicants: [{ age: 40 }],
              household_income: 31_300,
              household_size: 1,
              tax_filing: "single",
            }),
          ),
        },
      );
      return {
        status: response.status,
        gaps: response.headers.get("x-openplans-gaps") ?? "",
        data: (await response.json()) as Json,
      };
    });
    expect(result.status).toBe(200);
    expect(result.data.meta.premium_tax_credit).toBeNull();
    const plan = result.data.plans.find((p: Json) => p.id === PLAN);
    expect(plan.premium).toBe(before.total_cents / 100);
    expect(plan.premium_subsidized).toBeNull();
    expect(result.gaps.split(", ")).toContain("subsidy_location_requires_zip");
  });

  it("the MCP quote passes its honesty contract with the new status", async () => {
    const before = await native(h.db, county);
    const { output, canonical } = await partCounty(async (tx) => {
      const canonical = await estimatePremiums(tx, body(county));
      return {
        canonical,
        output: await canonicalEstimateOutput(tx, canonical.estimates),
      };
    });
    assertHonest("quote_premiums", output, canonical);
    expect(output.data!.quotes[0]).toMatchObject({
      gross_monthly_cents: before.total_cents,
      estimated_credit_cents: null,
      estimated_net_cents: null,
      benchmark_cents: null,
      subsidy_status: "location_requires_zip",
    });
  });

  it("a planted benchmark that ignores the part-county plan fails these checks", async () => {
    const original = new URL(
      "../../dist/services/subsidies.js",
      import.meta.url,
    );
    const directory = await mkdtemp(join(tmpdir(), "openplans-zip-mutant-"));
    try {
      const path = join(directory, "subsidies.mjs");
      await writeFile(
        path,
        rebaseImports(
          replaceSyntax(
            await readFile(original, "utf8"),
            "!location.zip && (",
            "false && (",
          ),
          original,
        ),
      );
      const mutant = (await import(pathToFileURL(path).href)) as {
        benchmark: typeof benchmarkService;
      };
      const answers = await partCounty(async (tx) => {
        const request = premiumRequest(body(county));
        const location = await resolveLocation(tx, request.location);
        return {
          real: await benchmarkService(tx, request, location),
          planted: await mutant.benchmark(tx, request, location),
        };
      });
      expect(answers.real.status).toBe("location_requires_zip");
      // The mutant drops the ZIP-limited plan and still claims a calculated benchmark.
      expect(answers.planted.status).toBe("calculated");
      expect(answers.planted.slcsp_monthly_cents).not.toBe(59_205);
      expect(() =>
        expect(answers.planted.status).toBe("location_requires_zip"),
      ).toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
