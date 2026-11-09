import { describe, expect, it } from "vitest";
import {
  allocatePremium,
  pediatricDentalBenchmark,
  slcsp,
} from "../../../src/domain/subsidy/index.js";
import type {
  DentalCandidate,
  SlcspHousehold,
} from "../../../src/domain/subsidy/index.js";
import { checkedCents } from "../../../src/domain/rating/rate-row.js";
import { householdPremium } from "../../../src/domain/rating/index.js";
import { syntheticRow, AREA, DATE } from "../rating/helpers.js";

// SYNTHETIC PUF-shaped dental rows. Values mirror the arithmetic in 26 CFR
// 1.36B-3(f)(9) Example 3; these are not real insurer offers or filed premiums.
const family: SlcspHousehold = {
  coverageStartDate: DATE,
  ratingMethod: "per_member",
  benchmarkScope: "single_location_single_policy",
  members: [
    { id: "adult", age: 35, relationship: "subscriber", tobaccoUse: false },
    { id: "child", age: 10, relationship: "child", tobaccoUse: false },
  ],
};
const ids = ["12345TX0100001", "12345TX0100002", "12345TX0100003"];
const dental: DentalCandidate[] = [
  { planId: "12345TX0200001", pediatricEhbFraction: "0.4", rows: [] },
  { planId: "12345TX0200002", pediatricEhbFraction: "0.375", rows: [] },
].map((p, i) => ({
  ...p,
  rows: [
    syntheticRow({
      PlanId: p.planId,
      Age: "0-14",
      IndividualRate: i ? "40.00" : "50.00",
    }),
  ],
}));
function adjusted(adjustment: number) {
  const medicalEhb = [65000, 62000, 59000];
  return slcsp(
    ids.map((planId, i) => {
      const premium = householdPremium(
        [
          syntheticRow({ PlanId: planId, Age: "35", IndividualRate: "400.00" }),
          syntheticRow({
            PlanId: planId,
            Age: "0-14",
            IndividualRate: ((medicalEhb[i]! - 40000) / 100).toFixed(2),
          }),
        ],
        planId,
        AREA,
        family,
      );
      if (premium.status !== "rated")
        throw new Error("Synthetic rating failed");
      return {
        planId,
        metalLevel: "Silver",
        onExchange: true,
        availableToHousehold: true,
        benchmarkBasis: "ehb_only_no_dental_adjustment_required" as const,
        premium: {
          ...premium,
          totalCents: checkedCents(premium.totalCents + (i ? adjustment : 0)),
        },
      };
    }),
    family,
  );
}

describe("pediatric dental EHB benchmark, 26 CFR 1.36B-3(f)(3)", () => {
  it("ranks allocated pediatric premiums ($15, $20), then adjusts silver BEFORE ranking ($610, $640, $650)", () => {
    const result = pediatricDentalBenchmark(dental, family, AREA);
    expect(result).toMatchObject({
      monthlyCents: 2000,
      planIds: ["12345TX0200001"],
      offers: [
        { planId: "12345TX0200002", pediatricGrossCents: 4000, ehbCents: 1500 },
        { planId: "12345TX0200001", pediatricGrossCents: 5000, ehbCents: 2000 },
      ],
    });
    expect(adjusted(result.monthlyCents!).slcspMonthlyCents).toBe(64000);
    expect(adjusted(result.monthlyCents!).planIds).toEqual([ids[1]]);
  });
  it("negative control: omitting dental produces $620; the same hand-computed $640 assertion fails", () => {
    expect(() => expect(adjusted(0).slcspMonthlyCents).toBe(64000)).toThrow();
  });
  it("ranks allocations independently of gross price, ties count, repeated plan rows do not", () => {
    const swapped = dental.map((d, i) => ({
      ...d,
      pediatricEhbFraction: i ? "0.75" : "0.2",
    }));
    expect(pediatricDentalBenchmark(swapped, family, AREA).monthlyCents).toBe(
      3000,
    );
    expect(
      pediatricDentalBenchmark([dental[0]!, dental[0]!], family, AREA)
        .monthlyCents,
    ).toBe(2000);
  });
  it("returns explicit missing evidence for allocation, rates, conflicting duplicates and absent offer sets", () => {
    for (const candidates of [
      [],
      [{ ...dental[0]!, pediatricEhbFraction: undefined }],
      [{ ...dental[0]!, rows: [] }],
      [dental[0]!, { ...dental[0]!, pediatricEhbFraction: "0.5" }],
    ]) {
      const result = pediatricDentalBenchmark(candidates, family, AREA);
      expect(result.monthlyCents).toBeNull();
      expect(result.issues.length).toBeGreaterThan(0);
    }
  });
  it("age 18 needs dental, age 19 does not; DOB is evaluated on coverage start", () => {
    const member = {
      id: "child",
      relationship: "child" as const,
      tobaccoUse: false,
    };
    expect(
      pediatricDentalBenchmark(
        dental,
        { ...family, members: [{ ...member, age: 19 }] },
        AREA,
      ).monthlyCents,
    ).toBe(0);
    expect(
      pediatricDentalBenchmark(
        [],
        { ...family, members: [{ ...member, age: 18 }] },
        AREA,
      ).monthlyCents,
    ).toBeNull();
    expect(
      pediatricDentalBenchmark(
        dental,
        {
          ...family,
          members: [
            {
              id: "child",
              relationship: "child",
              dateOfBirth: "2015-02-01",
              tobaccoUse: false,
            },
          ],
        },
        AREA,
      ).monthlyCents,
    ).toBe(2000);
  });
  it("keeps nine-place filed fractions exact, accepts zero, and rejects absent/out-of-range allocation", () => {
    expect(allocatePremium(2000, "0.939058323")).toBe(1878);
    expect(allocatePremium(2000, "0")).toBe(0);
    for (const value of ["", undefined, "1.1", "93%", "-0.1"])
      expect(allocatePremium(2000, value)).toBeNull();
  });
});
