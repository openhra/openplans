import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SqlSession } from "../../src/db/database.js";
import { ichraAffordability } from "../../src/services/ichra.js";
import type { IchraRequest } from "../../src/services/ichra.js";
import { setup } from "../compat/v1/helpers.js";

// SYNTHETIC employees over real, unmodified CMS TX PY2026 rows. The fixture is a partial cut:
// it holds 20 of the Harris Rating Area 10 silver plans (tests/compat/v1/regenerate.py), so
// the LCSP here is the lowest of those 20, not of the whole county. Whole-county values are
// checked against the full PUFs by scripts/oracle/ichra.mjs.
let h: Awaited<ReturnType<typeof setup>>;
beforeAll(async () => {
  h = await setup();
});
afterAll(async () => {
  await h?.close();
});

const GROSS_PLAN = "87226TX0100011";
const EHB_PLAN = "87226TX0140004";
function request(extra: Partial<IchraRequest> = {}): IchraRequest {
  return {
    planStart: "2026-01-01",
    monthsAvailable: 12,
    dateOfBirth: "1985-10-01",
    eligibleFrom: null,
    residence: { zip: "77002" },
    worksite: null,
    hraAnnualCents: 300_000,
    income: [{ measure: "household", annualCents: 4_118_000 }],
    safeHarbors: { location: false, lookBack: false },
    lcspPremiumBasis: null,
    ...extra,
  };
}
/** Loose view of the JSON response for assertions. */
type Result = ReturnType<typeof JSON.parse>;
async function run(extra: Partial<IchraRequest> = {}, db: SqlSession = h.db) {
  return (await ichraAffordability(db, request(extra))) as Result;
}
async function rollback(change: (tx: SqlSession) => Promise<void>) {
  const marker = new Error("synthetic ICHRA mutation rollback");
  let result: Result | undefined;
  await expect(
    h.db.transaction(async (tx) => {
      await change(tx);
      result = (await ichraAffordability(tx, request())) as Result;
      throw marker;
    }),
  ).rejects.toBe(marker);
  return result!;
}

describe("ICHRA affordability over the real Harris PY2026 cut", () => {
  it("gross default: LCSP $592.05; the EHB-portion plan differs, so the answer is basis sensitive", async () => {
    const result = await run();
    expect(result.status).toBe("calculated");
    expect(result.applicable_age).toBe(40);
    // Gross: 87226TX0100011 $592.05 (EHB fraction 1). EHB portion: 87226TX0140004
    // $614.43 x 0.9631 = $591.757533 -> $591.76, the lowest EHB figure.
    expect(result.lcsp).toMatchObject({
      status: "calculated",
      basis_used: "gross",
      plan_ids: [GROSS_PLAN],
      monthly_cents: 59_205,
      by_basis: {
        gross: { plan_ids: [GROSS_PLAN], monthly_cents: 59_205 },
        ehb_portion: { plan_ids: [EHB_PLAN], monthly_cents: 59_176 },
      },
      location: {
        source: "residence",
        county_fips: "48201",
        rating_area_id: "Rating Area 10",
      },
      coverage_month: "2026-01-01",
      identified_at_age: 40,
      priced_at_age: 40,
      silver_plan_count: 20,
    });
    expect(result.basis_sensitive).toBe(true);
    // HRA $3,000/12 = $250.00. Gross contribution $342.05; EHB-portion contribution $341.76.
    // Threshold $41,180 x 9.96% / 12 = $341.794: unaffordable on gross, affordable on EHB.
    const [verdict] = result.verdicts;
    expect(verdict).toMatchObject({
      measure: "household",
      purpose: "premium_tax_credit",
      lcsp: "premium_tax_credit",
      status: "calculated",
      required_hra_contribution_cents: { numerator: 34_205, denominator: 1 },
      threshold_cents: { numerator: 170_897, denominator: 5, display: 34_179 },
      affordable: false,
      affordable_by_basis: { gross: false, ehb_portion: true },
    });
    expect(result.required_contribution_percentage_bp).toBe(996);
    expect(result.required_contribution_percentage_citations[0].url).toBe(
      "https://www.irs.gov/pub/irs-drop/rp-25-25.pdf",
    );
    expect(result.quote_method).toBe("puf_calculation");
    expect(result.bindable_quote).toBe(false);
    const rate = result.lcsp.provenance.rate_rows_by_plan[0];
    expect(rate).toMatchObject({
      plan_id: GROSS_PLAN,
      gross_monthly_cents: 59_205,
    });
    expect(rate.rate_rows_used.length).toBeGreaterThan(0);
    expect(rate.rate_snapshot_id).toMatch(/^puf-2026-TX-.*:rate$/);
  });
  it("lcsp_premium_basis ehb_portion selects the EHB-portion plan and its verdict", async () => {
    const result = await run({ lcspPremiumBasis: "ehb_portion" });
    expect(result.lcsp).toMatchObject({
      basis_used: "ehb_portion",
      plan_ids: [EHB_PLAN],
      monthly_cents: 59_176,
    });
    expect(result.verdicts[0]).toMatchObject({
      affordable: true,
      required_hra_contribution_cents: { numerator: 34_176, denominator: 1 },
    });
  });
  it("employer measures use the lowest-age-band LCSP and carry proposed-rule labels", async () => {
    const result = await run({
      income: [
        { measure: "rate_of_pay_hourly", hourlyCents: 2_000 },
        { measure: "fpl" },
        { measure: "w2", annualCents: 4_118_000 },
      ],
    });
    expect(result.status).toBe("calculated");
    expect(result.lcsp).toBeNull();
    expect(result.employer_lcsp).toMatchObject({
      identified_at_age: 14,
      priced_at_age: 40,
      plan_ids: [GROSS_PLAN],
      monthly_cents: 59_205,
    });
    const [rate, fpl, w2] = result.verdicts;
    // 130 x $20.00 x 9.96% = $258.96 < $342.05.
    expect(rate).toMatchObject({
      purpose: "employer_4980H",
      threshold_cents: { display: 25_896 },
      affordable: false,
    });
    // 2025 guideline, $15,650 x 9.96% / 12 = $129.895.
    expect(fpl).toMatchObject({ fpl_guideline_year: 2025, affordable: false });
    expect(result.poverty_line).toMatchObject({
      state: "TX",
      annual_dollars: 15_650,
    });
    expect(w2.affordable).toBe(false);
    expect(result.safe_harbors_applied).toEqual([
      "age_safe_harbor",
      "lowest_age_band",
    ]);
    const statuses = Object.fromEntries(
      result.rules.map((r: { id: string; status: string }) => [r.id, r.status]),
    );
    expect(statuses).toMatchObject({
      employer_safe_harbors: "proposed_reliance_permitted",
      lowest_age_band: "proposed_reliance_permitted",
      rate_of_pay_safe_harbor: "proposed_reliance_permitted",
      required_contribution_percentage: "final",
    });
  });
  it("a non-calendar plan year with the look-back month uses January of the current year", async () => {
    const result = await run({
      planStart: "2026-07-01",
      safeHarbors: { location: false, lookBack: true },
    });
    expect(result.status).toBe("calculated");
    expect(result.employer_lcsp.coverage_month).toBe("2026-01-01");
    expect(result.verdicts[0]).toMatchObject({
      purpose: "employer_4980H",
      lcsp: "employer",
    });
    expect(result.safe_harbors_applied).toContain("look_back_month");
  });
});

describe("refusals: never affordable or unaffordable without the evidence", () => {
  it.each([
    [
      "look-back to 2025 with no PY2025 catalog",
      { safeHarbors: { location: false, lookBack: true } },
      "unknown",
      "lookback_catalog_not_loaded",
    ],
    [
      "a plan year with no loaded catalog",
      { planStart: "2027-01-01" },
      "unknown",
      "catalog_not_loaded",
    ],
    [
      "a plan year without cited parameters",
      { planStart: "2025-01-01" },
      "parameters_unconfirmed",
      "invalid_or_missing",
    ],
    [
      "a mid-year month without its rate rows",
      { planStart: "2026-07-01" },
      "unknown",
      "month_rate_rows_missing",
    ],
    [
      "New York before its filed-tier rules",
      { residence: { county: "36061" } },
      "requires_state_rules",
      "state_filed_tier_pending",
    ],
  ] as const)("%s", async (_name, extra, status, reason) => {
    const result = await run(extra as Partial<IchraRequest>);
    expect(result.status).toBe(status);
    expect(result.reason).toBe(reason);
    expect(result.verdicts).toEqual([]);
  });
  it("an unrated silver plan makes the LCSP incomplete", async () => {
    const result = await rollback(async (tx) => {
      await tx.query(`DELETE FROM rate WHERE base_plan_id='${EHB_PLAN}'`);
    });
    expect(result.status).toBe("incomplete_lcsp");
    expect(result.verdicts).toEqual([]);
  });
  it("a child-only plan is excluded; unknown coverage eligibility fails closed", async () => {
    const childOnly = await rollback(async (tx) => {
      await tx.query(
        `UPDATE plan_attribute SET raw=jsonb_set(raw,'{ChildOnlyOffering}','"Allows Child-Only"') WHERE base_plan_id='${GROSS_PLAN}'`,
      );
    });
    expect(childOnly.status).toBe("calculated");
    expect(childOnly.lcsp.plan_ids).not.toContain(GROSS_PLAN);
    expect(childOnly.lcsp.silver_plan_count).toBe(19);
    const unknown = await rollback(async (tx) => {
      await tx.query(
        `UPDATE plan_attribute SET raw=raw-'ChildOnlyOffering' WHERE base_plan_id='${GROSS_PLAN}'`,
      );
    });
    expect(unknown.status).toBe("incomplete_lcsp");
  });
  it("a missing EHB fraction keeps the gross answer and leaves basis sensitivity unknown", async () => {
    const result = await rollback(async (tx) => {
      await tx.query(
        `UPDATE plan_attribute SET raw=raw-'EHBPercentTotalPremium' WHERE base_plan_id='${EHB_PLAN}'`,
      );
    });
    expect(result.status).toBe("calculated");
    expect(result.lcsp.by_basis.ehb_portion.status).toBe(
      "requires_premium_adjustments",
    );
    expect(result.basis_sensitive).toBeNull();
    expect(result.verdicts[0].affordable_by_basis.ehb_portion).toBeNull();
  });
  it("a ZIP-limited silver plan needs the residence ZIP", async () => {
    const marker = new Error("synthetic ZIP rollback");
    let countyOnly: Result | undefined, withZip: Result | undefined;
    await expect(
      h.db.transaction(async (tx) => {
        await tx.query(
          `UPDATE service_area_county SET partial_county=true, zip_codes='77002' WHERE service_area_id='TXS003' AND county_fips='48201'`,
        );
        countyOnly = (await ichraAffordability(
          tx,
          request({ residence: { county: "48201" } }),
        )) as Result;
        withZip = (await ichraAffordability(tx, request())) as Result;
        throw marker;
      }),
    ).rejects.toBe(marker);
    expect(countyOnly!.status).toBe("location_requires_zip");
    expect(withZip!.status).toBe("calculated");
  });
});
