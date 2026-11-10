import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SqlSession } from "../../src/db/database.js";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  ichraAffordability,
  w2PartialYearContext,
} from "../../src/services/ichra.js";
import type { IchraRequest } from "../../src/services/ichra.js";
import { setup } from "../compat/v1/helpers.js";
import { rebaseImports, replaceSyntax } from "../source-mutation.js";

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

describe("W-2 safe harbor for a partial-year offer, 26 CFR 54.4980H-5(e)(2)(ii)(B)", () => {
  // SYNTHETIC employee: Form W-2 wages $30,000, employed in 10 calendar months, HRA offered in 6
  // of them in a calendar plan year. Adjusted wages 30,000 x 6 / 10 = $18,000; 9.96% of that is
  // $1,792.80 for the six offered months, $298.80 a month. The employer LCSP of the cut is
  // $592.05, so an HRA of $1,759.50 over 6 months ($293.25 a month) leaves exactly $298.80.
  const partial = (hraAnnualCents: number, extra: Partial<IchraRequest> = {}) =>
    run({
      monthsAvailable: 6,
      hraAnnualCents,
      income: [{ measure: "w2", annualCents: 3_000_000 }],
      w2PartialYear: { monthsOffered: 6, monthsEmployed: 10 },
      ...extra,
    });
  it("is affordable at exactly $298.80 and not one sixth of a cent above it", async () => {
    const at = await partial(175_950);
    expect(at.employer_lcsp.monthly_cents).toBe(59_205);
    expect(at.verdicts[0]).toMatchObject({
      measure: "w2",
      purpose: "employer_4980H",
      status: "calculated",
      reason: null,
      // (59,205 x 6 - 175,950) / 6 = 29,880 cents.
      required_hra_contribution_cents: { numerator: 29_880, denominator: 1 },
      // 3,000,000 x 996 / (10,000 x 10) = 29,880 cents.
      threshold_cents: { numerator: 29_880, denominator: 1, display: 29_880 },
      affordable: true,
    });
    expect(at.verdicts[0].rule_ids).toContain("w2_safe_harbor");
    const rule = at.rules.find(
      (r: { id: string }) => r.id === "w2_safe_harbor",
    );
    expect(rule.status).toBe("proposed_reliance_permitted");
    expect(
      rule.citations.map((c: { section: string }) => c.section).join(" "),
    ).toContain("(e)(2)(ii)");
    // One cent less HRA over the six months: (355,230 - 175,949) / 6 = 29,880 1/6 cents.
    const above = await partial(175_949);
    expect(above.verdicts[0]).toMatchObject({
      required_hra_contribution_cents: { numerator: 179_281, denominator: 6 },
      affordable: false,
    });
  });
  it("without the month counts a partial year stays unknown, as before", async () => {
    const result = await partial(175_950, { w2PartialYear: null });
    expect(result.verdicts[0]).toMatchObject({
      status: "unknown",
      reason: "w2_partial_year_not_supported",
      threshold_cents: null,
      affordable: null,
    });
    expect(result.verdicts[0].rule_ids).toContain("w2_safe_harbor");
  });
  it("offered months that differ from the months available stay unknown", async () => {
    const result = await partial(175_950, {
      w2PartialYear: { monthsOffered: 5, monthsEmployed: 10 },
    });
    expect(result.verdicts[0]).toMatchObject({
      status: "unknown",
      reason: "w2_months_offered_differs_from_months_available",
      affordable: null,
    });
  });
  it("a non-calendar plan year stays unknown with or without the counts", async () => {
    const nonCalendar = {
      planStart: "2026-07-01",
      monthsAvailable: 12,
      safeHarbors: { location: false, lookBack: true },
    };
    const withCounts = await partial(175_950, {
      ...nonCalendar,
      w2PartialYear: { monthsOffered: 12, monthsEmployed: 12 },
    });
    expect(withCounts.status).toBe("calculated");
    expect(withCounts.verdicts[0]).toMatchObject({
      status: "unknown",
      reason: "w2_non_calendar_plan_year_not_supported",
      affordable: null,
    });
    const without = await partial(175_950, {
      ...nonCalendar,
      w2PartialYear: null,
    });
    expect(without.verdicts[0]).toMatchObject({
      status: "unknown",
      reason: "w2_partial_year_not_supported",
    });
  });
  it("a full calendar year answers the same with 12 of 12 months as without counts", async () => {
    const full = { monthsAvailable: 12, hraAnnualCents: 300_000 };
    const counted = await partial(300_000, {
      ...full,
      w2PartialYear: { monthsOffered: 12, monthsEmployed: 12 },
    });
    const bare = await partial(300_000, { ...full, w2PartialYear: null });
    // 30,000 x 9.96% / 12 = $249.00 against a contribution of $342.05.
    expect(counted.verdicts[0]).toMatchObject({
      threshold_cents: { numerator: 24_900, denominator: 1 },
      affordable: false,
    });
    expect(counted).toEqual(bare);
  });
  it("planted defect: using counts that differ from the months available answers anyway", () => {
    const request = {
      planStart: "2026-01-01",
      monthsAvailable: 6,
      w2PartialYear: { monthsOffered: 5, monthsEmployed: 10 },
    };
    expect(w2PartialYearContext(request)).toEqual({
      w2Unavailable: "w2_months_offered_differs_from_months_available",
    });
    const original = new URL("../../dist/services/ichra.js", import.meta.url);
    const directory = mkdtempSync(join(tmpdir(), "openplans-w2-wiring-"));
    try {
      const source = replaceSyntax(
        readFileSync(original, "utf8"),
        "counts.monthsOffered !== request.monthsAvailable",
        "false",
      );
      const path = join(directory, "ichra.mjs");
      writeFileSync(path, rebaseImports(source, original));
      const output = execFileSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `import { w2PartialYearContext } from ${JSON.stringify(pathToFileURL(path).href)};
import { readFileSync } from "node:fs";
console.log(JSON.stringify(w2PartialYearContext(JSON.parse(readFileSync(0, "utf8")))));`,
        ],
        { input: JSON.stringify(request), encoding: "utf8" },
      );
      expect(JSON.parse(output)).toEqual({
        w2PartialYear: request.w2PartialYear,
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("rate of pay safe harbor inputs, 26 CFR 54.4980H-5(e)(2)(iii)", () => {
  // SYNTHETIC employee: $20.00 an hour on the first day of the plan year, cut to $18.00 during
  // the month. 130 x $18.00 x 9.96% = $233.064. Against the $592.05 LCSP, an HRA of $4,307.88 a
  // year ($358.99 a month) leaves $233.06; $4,307.76 ($358.98) leaves $233.07.
  const hourly = (hraAnnualCents: number, lowestInMonthCents?: number) =>
    run({
      hraAnnualCents,
      income: [
        {
          measure: "rate_of_pay_hourly",
          hourlyCents: 2_000,
          ...(lowestInMonthCents === undefined ? {} : { lowestInMonthCents }),
        },
      ],
    });
  it("uses the lower hourly rate: $233.06 affordable, $233.07 not", async () => {
    const at = await hourly(430_788, 1_800);
    expect(at.verdicts[0]).toMatchObject({
      status: "calculated",
      required_hra_contribution_cents: { numerator: 23_306, denominator: 1 },
      // 130 x 1,800 x 996 / 10,000 = 23,306.4 cents = 116,532 / 5.
      threshold_cents: { numerator: 116_532, denominator: 5, display: 23_306 },
      affordable: true,
    });
    expect(at.verdicts[0].rule_ids).toContain("rate_of_pay_safe_harbor");
    const above = await hourly(430_776, 1_800);
    expect(above.verdicts[0]).toMatchObject({
      required_hra_contribution_cents: { numerator: 23_307, denominator: 1 },
      affordable: false,
    });
    // The same $233.07 is affordable at the first-day rate alone: 130 x $20.00 x 9.96% = $258.96.
    const firstDayOnly = await hourly(430_776);
    expect(firstDayOnly.verdicts[0]).toMatchObject({
      threshold_cents: { display: 25_896 },
      affordable: true,
    });
  });
  it("a reduced monthly salary gives an unknown verdict that still cites the rule", async () => {
    const salary = (reduced?: boolean) =>
      run({
        income: [
          {
            measure: "rate_of_pay_salary",
            monthlyCents: 400_000,
            ...(reduced === undefined ? {} : { reduced }),
          },
        ],
      });
    const reduced = await salary(true);
    expect(reduced.status).toBe("calculated");
    expect(reduced.verdicts[0]).toMatchObject({
      measure: "rate_of_pay_salary",
      status: "unknown",
      reason: "rate_of_pay_salary_reduced",
      threshold_cents: null,
      affordable: null,
      affordable_by_basis: { gross: null, ehb_portion: null },
    });
    expect(reduced.verdicts[0].rule_ids).toContain("rate_of_pay_safe_harbor");
    expect(
      reduced.rules.some(
        (r: { id: string }) => r.id === "rate_of_pay_safe_harbor",
      ),
    ).toBe(true);
    // $4,000.00 x 9.96% = $398.40 against a contribution of $342.05.
    const unreduced = await salary(false);
    expect(unreduced.verdicts[0]).toMatchObject({
      threshold_cents: { numerator: 39_840, denominator: 1 },
      affordable: true,
    });
    expect(unreduced).toEqual(await salary());
  });
});
