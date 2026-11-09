import { describe, expect, it } from "vitest";
import { householdPremium } from "../../../src/domain/rating/index.js";
import { slcsp } from "../../../src/domain/subsidy/index.js";
import type {
  SlcspCandidate,
  SlcspHousehold,
} from "../../../src/domain/subsidy/index.js";
import {
  AREA,
  DATE,
  PLAN,
  fixture,
  fourChildren,
  rows,
  syntheticRow,
} from "../rating/helpers.js";

/** SYNTHETIC coverage family; all invented-price tie/duplicate fixtures below are labelled synthetic. */
const household: SlcspHousehold = {
  coverageStartDate: DATE,
  ratingMethod: "per_member",
  benchmarkScope: "single_location_single_policy",
  members: [
    { id: "adult", age: 35, relationship: "subscriber", tobaccoUse: false },
  ],
};
const secondPlan = "29418TX0140049";
const thirdPlan = "87226TX0100013";
function candidate(planId = PLAN, cents = 40_000): SlcspCandidate {
  // SYNTHETIC premiums for controlled ordering tests, computed by our real rating engine.
  const rate = syntheticRow({
    PlanId: planId,
    IndividualRate: (cents / 100).toFixed(2),
  });
  return {
    planId,
    metalLevel: "Silver",
    onExchange: true,
    availableToHousehold: true,
    benchmarkBasis: "ehb_only_no_dental_adjustment_required",
    premium: householdPremium([rate], planId, AREA, household),
  };
}

describe("SLCSP over our own household ratings", () => {
  it("uses real TX rate fixture household totals; second cost is independent of input order", () => {
    const family: SlcspHousehold = {
      ...fourChildren,
      benchmarkScope: "single_location_single_policy",
    };
    const plans: SlcspCandidate[] = fixture.planIds.map((planId) => ({
      planId,
      metalLevel: "Silver",
      onExchange: true,
      availableToHousehold: true,
      // This test asserts arithmetic on rate data, not actual market availability or EHB evidence.
      benchmarkBasis: "ehb_only_no_dental_adjustment_required",
      premium: householdPremium(rows, planId, AREA, family),
    }));
    plans.forEach((plan) => expect(plan.premium.status).toBe("rated"));
    const result = slcsp(plans.reverse(), family);
    expect(result.status).toBe("calculated");
    // Published per-member fixture totals: 225,918; 309,670; 322,505; 327,157 cents.
    // 20069TX0100006 is second: 72,549 + 75,874 + 57,588 + 54,204 + 49,455.
    expect(result.slcspMonthlyCents).toBe(309_670);
    expect(result.planIds).toEqual([PLAN]);
    expect(result.uniquePlanCount).toBe(4);
    expect(result.quote_method).toBe("puf_calculation");
    expect(result.bindable_quote).toBe(false);
  });
  it("two distinct $400 plans tie: SLCSP is $400, not the second distinct price $500 (IRS Q25)", () => {
    const plans = [
      candidate(thirdPlan, 50_000),
      candidate(secondPlan),
      candidate(),
    ];
    expect(slcsp(plans, household)).toMatchObject({
      status: "calculated",
      slcspMonthlyCents: 40_000,
      uniquePlanCount: 3,
      planIds: [PLAN, secondPlan],
    });
    expect(slcsp([...plans].reverse(), household)).toEqual(
      slcsp(plans, household),
    );
  });
  it("repeated base plan and CSR variants are one plan; SLCSP is the different $500 plan", () => {
    const base = candidate();
    expect(
      slcsp(
        [
          base,
          base,
          { ...base, planId: `${PLAN}-01` },
          { ...base, planId: `${PLAN}-06` },
          candidate(secondPlan, 50_000),
        ],
        household,
      ),
    ).toMatchObject({
      status: "calculated",
      slcspMonthlyCents: 50_000,
      uniquePlanCount: 2,
      planIds: [secondPlan],
    });
  });
  it("only one actual silver plan is its own SLCSP (IRS Q25, 26 CFR 1.36B-3(f)(8))", () => {
    expect(slcsp([candidate(), candidate()], household)).toMatchObject({
      status: "calculated",
      slcspMonthlyCents: 40_000,
      uniquePlanCount: 1,
    });
  });
  it("zero-dollar premiums are valid and duplicates with zero price still conflict", () => {
    expect(slcsp([candidate(PLAN, 0)], household).slcspMonthlyCents).toBe(0);
    expect(
      slcsp([candidate(PLAN, 0), candidate(PLAN, 1)], household).status,
    ).toBe("ambiguous_benchmark");
  });
  it("ignores non-silver, off-exchange and unavailable plans", () => {
    expect(
      slcsp(
        [
          { ...candidate(), metalLevel: "Gold" },
          { ...candidate(), onExchange: false },
          { ...candidate(), availableToHousehold: false },
          candidate(secondPlan, 50_000),
          candidate(thirdPlan, 60_000),
        ],
        household,
      ).slcspMonthlyCents,
    ).toBe(60_000);
    expect(slcsp([], household)).toMatchObject({
      status: "no_silver_plans",
      slcspMonthlyCents: null,
    });
  });
  it("conflicting prices for one base HIOS ID do not silently choose a cheaper value", () => {
    expect(
      slcsp([candidate(), candidate(PLAN, 40_001)], household),
    ).toMatchObject({
      status: "ambiguous_benchmark",
      slcspMonthlyCents: null,
    });
  });
  it("a failed rating blocks a number instead of disappearing from the silver candidate set", () => {
    const missing = {
      ...candidate(),
      premium: householdPremium([], PLAN, AREA, household),
    };
    expect(
      slcsp([candidate(secondPlan), candidate(thirdPlan), missing], household),
    ).toMatchObject({
      status: "incomplete_benchmark",
      slcspMonthlyCents: null,
      issues: [`${PLAN}: missing`],
    });
  });
  it("unsupported state/family-tier rating result is preserved as an incomplete benchmark", () => {
    const unsupported = {
      ...candidate(),
      premium: householdPremium([], PLAN, AREA, {
        ...household,
        ratingMethod: "family_tier",
      }),
    };
    expect(
      slcsp([unsupported], { ...household, ratingMethod: "family_tier" }),
    ).toMatchObject({
      status: "incomplete_benchmark",
      slcspMonthlyCents: null,
      issues: [`${PLAN}: unsupported_rating_method`],
    });
  });
  it("the benchmark for a smoker must be rated without the tobacco surcharge (IRS Q26)", () => {
    const smoker: SlcspHousehold = {
      ...household,
      members: [{ ...household.members[0]!, tobaccoUse: true }],
    };
    expect(slcsp([candidate()], smoker).slcspMonthlyCents).toBe(40_000);
    const tobaccoRow = syntheticRow({
      Tobacco: "Tobacco User/Non-Tobacco User",
      IndividualRate: "400.00",
      IndividualTobaccoRate: "500.00",
    });
    const smoking = {
      ...candidate(),
      premium: householdPremium([tobaccoRow], PLAN, AREA, smoker),
    };
    expect(smoking.premium.status).toBe("rated");
    expect(slcsp([smoking], smoker)).toMatchObject({
      status: "incomplete_benchmark",
      slcspMonthlyCents: null,
    });
  });
  it.each([{ benchmarkBasis: "requires_adjustment" }] as const)(
    "missing EHB/dental allocation never produces an unadjusted benchmark",
    (override) => {
      expect(slcsp([{ ...candidate(), ...override }], household)).toMatchObject(
        {
          status: "requires_benchmark_adjustments",
          slcspMonthlyCents: null,
        },
      );
    },
  );
  it("multiple-location/policy families require an adapter", () => {
    expect(
      slcsp([candidate()], {
        ...household,
        benchmarkScope: "requires_adapter",
      }),
    ).toMatchObject({
      status: "requires_benchmark_adjustments",
      slcspMonthlyCents: null,
    });
  });
  it("rejects wrong member age, relationship, ID, date, rating area and plan identity", () => {
    const base = candidate();
    const wrongAge = {
      ...base.premium,
      members: base.premium.members.map((m) => ({ ...m, age: 40 })),
    };
    const wrongRelation = {
      ...base.premium,
      members: base.premium.members.map((m) => ({
        ...m,
        relationship: "child" as const,
      })),
    };
    const wrongId = {
      ...base.premium,
      members: base.premium.members.map((m) => ({
        ...m,
        memberId: "different",
      })),
    };
    for (const premium of [
      wrongAge,
      wrongRelation,
      wrongId,
      { ...base.premium, coverageStartDate: "2027-01-01" },
      { ...base.premium, planId: secondPlan },
    ]) {
      expect(slcsp([{ ...base, premium }], household).status).toBe(
        "incomplete_benchmark",
      );
    }
    const otherArea = {
      ...candidate(secondPlan),
      premium: {
        ...candidate(secondPlan).premium,
        ratingAreaId: "Rating Area 1",
      },
    };
    expect(slcsp([base, otherArea], household)).toMatchObject({
      status: "incomplete_benchmark",
      issues: ["mixed_rating_areas"],
    });
  });
  it("birth-date input matches the completed age used in rating", () => {
    const byBirth: SlcspHousehold = {
      ...household,
      members: [
        {
          id: "adult",
          relationship: "subscriber",
          dateOfBirth: "1990-02-01",
          tobaccoUse: false,
        },
      ],
    };
    expect(slcsp([candidate()], byBirth).status).toBe("calculated");
  });
  it("same-named rating areas in different states are not combined, and wrong source years fail closed", () => {
    const base = candidate();
    if (base.premium.status !== "rated")
      throw new Error("SYNTHETIC rating setup failed");
    const caPlan = "12345CA0100001";
    const ca = {
      ...base,
      planId: caPlan,
      premium: {
        ...base.premium,
        planId: caPlan,
        rowsUsed: base.premium.rowsUsed.map((row) => ({
          ...row,
          stateCode: "CA",
          planId: caPlan,
        })),
      },
    };
    expect(slcsp([base, ca], household)).toMatchObject({
      status: "incomplete_benchmark",
      issues: ["mixed_rating_areas"],
    });
    const wrongYear = {
      ...base,
      premium: {
        ...base.premium,
        rowsUsed: base.premium.rowsUsed.map((row) => ({
          ...row,
          businessYear: 2027,
        })),
      },
    };
    expect(slcsp([wrongYear], household).status).toBe("incomplete_benchmark");
  });
});
