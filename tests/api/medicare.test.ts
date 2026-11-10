import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/api/app.js";
import { callTool } from "../../src/mcp/tools.js";
import { outputSchemas } from "../../src/mcp/schemas.js";
import { loadedDatabase } from "../ingest/medicare/helpers.js";
import type { Loaded } from "../ingest/medicare/helpers.js";

type Json = ReturnType<typeof JSON.parse>;

describe("/v1/medicare (CY2026 fixtures cut from real CMS files)", () => {
  let loaded: Loaded;
  let get: (path: string) => Promise<{ status: number; body: Json }>;
  beforeAll(async () => {
    loaded = await loadedDatabase();
    const app = createApp(loaded.db, { premiumToken: undefined });
    get = async (path) => {
      const response = await app.request(path);
      return { status: response.status, body: await response.json() };
    };
  }, 120_000);
  afterAll(async () => loaded?.cleanup());

  it("lists plans in a county with the published Harris County values (golden)", async () => {
    const { status, body } = await get(
      "/v1/medicare/plans?county_fips=48201&year=2026&type=ma_pd",
    );
    expect(status).toBe(200);
    expect(body).toMatchObject({
      status: "available",
      contract_year: 2026,
      as_of: "202609",
      quote_method: "filed_public",
    });
    const plan = body.plans.find((p: Json) => p.plan_key === "H0028-042-0");
    expect(plan).toMatchObject({
      name: "Humana Gold Plus H0028-042 (HMO)",
      plan_type: "HMO",
      contract_category: "MA-PD",
      organization: {
        contract_id: "H0028",
        contract_name: "CHA HMO, INC.",
        marketing_name: "Humana",
        parent: "Humana Inc.",
      },
      premiums_monthly: {
        consolidated: { status: "value", cents: 0 },
        part_d_total: { status: "value", cents: 0 },
      },
      part_d: {
        deductible: { status: "value", cents: 34000 },
        oop_threshold: { status: "value", cents: 210000 },
        low_income_premium_subsidy: { status: "value", cents: 482 },
        benefit_type: "Enhanced Alternative",
      },
      moop_in_network: { status: "value", cents: 345000 },
      stars: {
        overall: { status: "rated", stars: 3.5 },
        part_d_summary: { status: "rated", stars: 3 },
      },
      snp: null,
      sanctioned: false,
      provider_network: {
        status: "unknown",
        reason: "published_only_by_each_organization",
      },
      availability: { county: "available", partial_county: false },
    });
    expect(plan.plan_benefit_package.websites.formulary).toMatch(
      /^https:\/\/www\.humana\.com\//,
    );
    expect(body.part_d_drug_data).toEqual({
      status: "unknown",
      reason: "pending_terms_review",
    });
  });

  it("includes PDPs filed for All Counties of the state and filters by type and SNP type", async () => {
    const pdp = await get(
      "/v1/medicare/plans?county_fips=48201&year=2026&type=pdp",
    );
    expect(pdp.body.plans.map((p: Json) => p.plan_key).sort()).toEqual([
      "S4802-013-0",
      "S4802-155-0",
    ]);
    const negative = pdp.body.plans.find(
      (p: Json) => p.plan_key === "S4802-155-0",
    );
    expect(negative.premiums_monthly.part_d_basic.cents).toBeLessThan(0);
    const snp = await get(
      "/v1/medicare/plans?county_fips=48201&year=2026&snp_type=Dual-Eligible",
    );
    expect(snp.body.plans.map((p: Json) => p.plan_key)).toEqual([
      "H0028-032-0",
    ]);
    expect(snp.body.plans[0].snp.type).toBe("Dual-Eligible");
    const la = await get("/v1/medicare/plans?county_fips=06037&year=2026");
    expect(la.body.plans.map((p: Json) => p.plan_key)).toContain("H0504-015-0");
    expect(la.body.plans.map((p: Json) => p.plan_key)).not.toContain(
      "S4802-013-0",
    );
  });

  it("serves unknown, never an empty catalog, for a year that is not loaded", async () => {
    const { status, body } = await get(
      "/v1/medicare/plans?county_fips=48201&year=2027",
    );
    expect(status).toBe(200);
    expect(body).toMatchObject({
      status: "unknown",
      reason: "catalog_not_loaded",
      total: 0,
    });
    expect((await get("/v1/medicare/plans/H0028-042-0?year=2027")).status).toBe(
      404,
    );
  });

  it("validates input", async () => {
    expect((await get("/v1/medicare/plans?year=2026")).body.error.code).toBe(
      "ZIP_OR_COUNTY_REQUIRED",
    );
    expect(
      (await get("/v1/medicare/plans?county_fips=48201&year=2026&type=gold"))
        .status,
    ).toBe(400);
    expect(
      (await get("/v1/medicare/plans/H28-042-0?year=2026")).body.error.code,
    ).toBe("INVALID_PLAN_KEY");
    expect(
      (await get("/v1/medicare/plans/H0028-999-0?year=2026")).body.error.code,
    ).toBe("PLAN_NOT_FOUND");
    expect(
      (
        await get(
          "/v1/medicare/plans/H0028-042-0/benefits?year=2026&table=x;drop",
        )
      ).status,
    ).toBe(400);
  });

  it("plan detail adds contract star ratings and a service-area summary", async () => {
    const { body } = await get("/v1/medicare/plans/H0028_042_0?year=2026");
    expect(body.plan_key).toBe("H0028-042-0");
    expect(body.contract_star_ratings.measures.overall).toEqual({
      status: "rated",
      stars: 3.5,
      published: "3.5",
    });
    expect(body.service_area_summary.states).toEqual(["TX"]);
    expect(body.part_d.low_income_premium_subsidy.status).toBe(
      "varies_by_region",
    );
  });

  it("benefits are served as filed with dictionary titles and code labels", async () => {
    const { body } = await get(
      "/v1/medicare/plans/H0028-042-0/benefits?year=2026&table=pbp_section_d",
    );
    expect(body.status).toBe("available");
    const fields = body.tables[0].fields;
    expect(
      fields.find((f: Json) => f.field === "pbp_d_out_pocket_amt"),
    ).toMatchObject({ value: "3450.00", title: "In Network MOOP Amount" });
    expect(
      fields.find((f: Json) => f.field === "pbp_d_out_pocket_amt_yn"),
    ).toMatchObject({ value: "1", value_label: "Yes" });
    expect(body.notes.join(" ")).toMatch(
      /not a statement that a service is not covered/,
    );
  });

  it("service area maps PlanArea SSA codes to FIPS", async () => {
    const { body } = await get(
      "/v1/medicare/plans/H0504-015-0/service-area?year=2026",
    );
    const la = body.plan_benefit_package.areas.filter(
      (a: Json) => a.county_name === "Los Angeles",
    );
    expect(la.length).toBeGreaterThan(0);
    for (const area of la) expect(area.county_fips).toEqual(["06037"]);
    expect(body.plan_benefit_package.zip_level_area.reason).toBe(
      "partial_county_zip_list_not_published",
    );
  });

  it("lineage reads the crosswalk and reports the next year as not loaded", async () => {
    const { body } = await get(
      "/v1/medicare/plans/H0028-042-0/lineage?year=2026",
    );
    expect(body.from_prior_year.rows[0]).toMatchObject({
      previous_contract_id: "H0028",
      previous_plan_id: "042",
      status: "Renewal Plan",
    });
    expect(body.to_next_year).toMatchObject({
      status: "unknown",
      reason: "crosswalk_not_loaded",
    });
  });

  it("data availability lists families and keeps Part D pending by default", async () => {
    const { body } = await get("/v1/medicare/data-availability");
    expect(body.years).toHaveLength(1);
    expect(body.years[0]).toMatchObject({
      contract_year: 2026,
      plans_premiums_stars: { status: "available", as_of: "202609" },
      plan_benefit_package: { status: "available" },
      part_d_drug_data: { status: "unknown", reason: "pending_terms_review" },
      provider_network: { status: "unknown" },
    });
    expect(body.county_codes).toHaveLength(2);
  });

  it("MCP search_medicare_plans pages the county listing with evidence refs", async () => {
    const result = await callTool(
      {
        db: loaded.db,
        cursorSecret: "medicare-test-secret-0123456789abcdef",
        policy: { canEstimate: () => false },
      },
      "search_medicare_plans",
      { location: { county: "48201" }, year: 2026, limit: 2 },
    );
    const output = outputSchemas.search_medicare_plans.parse(
      result.structuredContent,
    );
    expect(output.status).toBe("ok");
    expect(output.data!.plans).toHaveLength(2);
    const plan =
      output.data!.plans.find((p) => p.plan_key === "H0028-042-0") ??
      output.data!.plans[0]!;
    expect(plan.evidence_refs[0]).toMatch(
      /^cms-medicare-landscape-202609-[a-f0-9]{64}#row:\d+$/,
    );
    expect(output.data!.part_d_drug_data).toBe("pending_terms_review");
    expect(output.page?.next_cursor).toBeTruthy();
  });
});
