import { describe, expect, it } from "vitest";
import { estimateAptc } from "../../../src/domain/subsidy/index.js";
import { parameterErrors } from "../../../src/domain/subsidy/parameters.js";
import type { SubsidyParameters } from "../../../src/domain/subsidy/index.js";
import { parameters2026 } from "./helpers.js";

/**
 * SYNTHETIC expansion table: these tests exercise the engine's handling of a cited
 * table. The statuses are test inputs, not shipped policy data.
 */
const withTable: SubsidyParameters = {
  ...parameters2026,
  medicaidAdultExpansion: {
    value: { TX: "not_expanded", AZ: "expanded", CA: "expanded" },
    citations: [
      {
        url: "https://www.healthcare.gov/medicaid-chip/medicaid-expansion-and-you/",
        title: "SYNTHETIC test table",
        section: "Synthetic statuses for engine tests only",
        retrievedOn: "2026-11-09",
      },
    ],
  },
};
// 2026 one-person contiguous FPL is $15,650 (HHS 2025 guidelines).
const at = (percent: number, state: string) =>
  estimateAptc(
    {
      householdIncome: (15_650 * percent) / 100,
      householdSize: 1,
      state,
      year: 2026,
      slcspMonthlyCents: 60_000,
    },
    withTable,
  );

describe("cited adult Medicaid expansion status", () => {
  it("a non-expansion state at 115% FPL gets an APTC estimate", () => {
    const result = at(115, "TX");
    expect(result).toMatchObject({
      status: "estimated",
      reason: "conditional_estimate",
      fplPercent: 115,
      applicablePercentage: 0.021,
    });
    // $17,997.50 × 2.10% = $377.95 → $378/year → $31.50 → $32/month (half up).
    expect(result.expectedContributionCents).toBe(3_200);
    expect(result.estimatedMonthlyCreditCents).toBe(56_800);
  });

  it("expansion states and states missing from the table keep the review screen", () => {
    for (const state of ["AZ", "CA", "NY"])
      expect(at(115, state)).toMatchObject({
        status: "requires_state_rules",
        reason: "medicaid_expansion_review",
        estimatedMonthlyCreditCents: null,
      });
  });

  it("below 100% FPL stays below_100_fpl in a non-expansion state", () => {
    expect(at(99, "TX")).toMatchObject({
      status: "requires_state_rules",
      reason: "below_100_fpl",
      estimatedMonthlyCreditCents: null,
    });
  });

  it("negative control: without a table TX at 115% keeps the review screen", () => {
    expect(
      estimateAptc(
        {
          householdIncome: 17_997.5,
          householdSize: 1,
          state: "TX",
          year: 2026,
          slcspMonthlyCents: 60_000,
        },
        parameters2026,
      ),
    ).toMatchObject({ reason: "medicaid_expansion_review" });
  });

  it("rejects an uncited or malformed table", () => {
    expect(parameterErrors(withTable)).toEqual([]);
    const uncited = {
      ...withTable,
      medicaidAdultExpansion: {
        value: withTable.medicaidAdultExpansion!.value,
        citations: [],
      },
    };
    expect(parameterErrors(uncited).join()).toContain("medicaidAdultExpansion");
    const malformed = {
      ...withTable,
      medicaidAdultExpansion: {
        ...withTable.medicaidAdultExpansion!,
        value: { TX: "partial" },
      },
    };
    expect(parameterErrors(malformed).join()).toContain(
      "medicaidAdultExpansion",
    );
    // A malformed table makes the whole year unconfirmed, never a silent estimate.
    expect(
      estimateAptc(
        {
          householdIncome: 17_997.5,
          householdSize: 1,
          state: "TX",
          year: 2026,
          slcspMonthlyCents: 60_000,
        },
        malformed,
      ).status,
    ).toBe("parameters_unconfirmed");
  });
});
