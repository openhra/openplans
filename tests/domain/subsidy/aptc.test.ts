import { replaceSyntax, rebaseImports } from "../../source-mutation.js";
import { tmpdir } from "node:os";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  applicablePercentageForFpl,
  estimateAptc,
  fplAnnualDollars,
  netPremium,
} from "../../../src/domain/subsidy/index.js";
import type { AptcInput } from "../../../src/domain/subsidy/index.js";
import {
  alaskaExample,
  assertAlaskaExample,
  parameters2026,
  parameters2027,
} from "./helpers.js";

/** All households/incomes/benchmark premiums in this file are SYNTHETIC arithmetic scenarios. */
const example: AptcInput = {
  householdIncome: 31_300,
  householdSize: 1,
  state: "TX",
  year: 2026,
  slcspMonthlyCents: 60_000,
};

describe("hand calculations from HHS tables and IRS Revenue Procedures", () => {
  it("2026: $31,300/$15,650 = 200%; ×6.60% = $2,065.80 → $2,066 /12 → $172; $600−$172 = $428", () => {
    expect(estimateAptc(example)).toEqual({
      fplPercent: 200,
      applicablePercentage: 0.066,
      expectedContributionCents: 17_200,
      annualExpectedContributionCents: 206_600,
      estimatedMonthlyCreditCents: 42_800,
      status: "estimated",
      reason: "conditional_estimate",
      quote_method: "puf_calculation",
      bindable_quote: false,
    });
  });
  it("2027: $31,920/$15,960 = 200%; ×6.78% = $2,164.176 → $2,164 /12 → $180; credit $420", () => {
    expect(
      estimateAptc({ ...example, householdIncome: 31_920, year: 2027 }),
    ).toMatchObject({
      fplPercent: 200,
      applicablePercentage: 0.0678,
      annualExpectedContributionCents: 216_400,
      expectedContributionCents: 18_000,
      estimatedMonthlyCreditCents: 42_000,
      status: "estimated",
    });
  });
  it("225% interpolates 6.60%+(25/50)×(8.44−6.60)% = 7.52%; $35,212.50×.0752 → $2,648 /12 → $221", () => {
    expect(
      estimateAptc({ ...example, householdIncome: 35_212.5 }),
    ).toMatchObject({
      fplPercent: 225,
      applicablePercentage: 0.0752,
      annualExpectedContributionCents: 264_800,
      expectedContributionCents: 22_100,
      estimatedMonthlyCreditCents: 37_900,
    });
  });
  it("Alaska uses $19,550, not the contiguous-state poverty guideline", () => {
    assertAlaskaExample(estimateAptc(alaskaExample));
  });
  it.each([
    ["HI", 2026, 35_980, 0.066, 237_500, 19_800, 40_200],
    ["AK", 2027, 39_900, 0.0678, 270_500, 22_500, 37_500],
    // HI: 36,720/18,360=200%; ×.0678=2,489.616→2,490; /12=207.50→208 (half up).
    ["HI", 2027, 36_720, 0.0678, 249_000, 20_800, 39_200],
    // TX size four: 64,300/32,150=200%; ×.066=4,243.80→4,244; /12→354.
    ["TX", 2026, 64_300, 0.066, 424_400, 35_400, 24_600],
    ["TX", 2027, 66_000, 0.0678, 447_500, 37_300, 22_700],
  ] as const)(
    "%s %i uses its cited FPL; income %i",
    (
      state,
      year,
      householdIncome,
      applicablePercentage,
      annual,
      monthly,
      credit,
    ) => {
      const householdSize = state === "TX" ? 4 : 1;
      expect(
        estimateAptc({
          ...example,
          state,
          year,
          householdIncome,
          householdSize,
        }),
      ).toMatchObject({
        status: "estimated",
        fplPercent: 200,
        applicablePercentage,
        annualExpectedContributionCents: annual,
        expectedContributionCents: monthly,
        estimatedMonthlyCreditCents: credit,
      });
    },
  );
});

describe("77002 P5b real benchmark with a synthetic single age-40 household", () => {
  const input = { ...example, slcspMonthlyCents: 59176 };
  function assertTrace(result: ReturnType<typeof estimateAptc>) {
    expect(result).toMatchObject({
      fplPercent: 200,
      applicablePercentage: 0.066,
      annualExpectedContributionCents: 206600,
      expectedContributionCents: 17200,
      estimatedMonthlyCreditCents: 41976,
    });
  }
  it("retains Form 8962 line 8a/8b rounding: $2,065.80 → $2,066 → $172; credit $419.76", () => {
    assertTrace(estimateAptc(input));
  });
  it("negative control: compile an unrounded monthly-cent source mutant; the 77002 trace fails", async () => {
    const directory = mkdtempSync(join(tmpdir(), "openplans-rounding-"));
    try {
      // Mutate a disposable copy of compiled code; neither real sources nor dist are edited.
      const source = readFileSync(
        new URL("../../../dist/domain/subsidy/aptc.js", import.meta.url),
        "utf8",
      );
      const mutant = replaceSyntax(
        source,
        "const expectedContributionCents = checkedCents(Number(monthlyDollars * 100n));",
        "const expectedContributionCents = checkedCents(Number(halfUp(incomeCents * basisPoints, 120000n)));",
      );
      expect(mutant).not.toBe(source);
      const rewritten = rebaseImports(
        mutant,
        new URL("../../../dist/domain/subsidy/aptc.js", import.meta.url),
      );
      const path = join(directory, "aptc.mjs");
      writeFileSync(path, rewritten);
      const output = execFileSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `import {estimateAptc} from ${JSON.stringify(new URL("file://" + path).href)}; console.log(JSON.stringify(estimateAptc(${JSON.stringify(input)})))`,
        ],
        { encoding: "utf8" },
      );
      const result = JSON.parse(output);
      expect(result.estimatedMonthlyCreditCents).toBe(41961);
      expect(() => assertTrace(result)).toThrow();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

it.each([
  [150, 23475, 0.0419, 98400, 8200, 50976],
  [200, 31300, 0.066, 206600, 17200, 41976],
  [400, 62600, 0.0996, 623500, 52000, 7176],
])(
  "2026 exact %i%% FPL edge retains every monetary intermediate",
  (fpl, income, percentage, annual, monthly, credit) => {
    expect(
      estimateAptc({
        ...example,
        householdIncome: income!,
        slcspMonthlyCents: 59176,
      }),
    ).toMatchObject({
      status: "estimated",
      fplPercent: fpl,
      applicablePercentage: percentage,
      annualExpectedContributionCents: annual,
      expectedContributionCents: monthly,
      estimatedMonthlyCreditCents: credit,
    });
  },
);

describe("IRS rounding, not floating-point rounding", () => {
  it("175%: 4.19%+(25/50)×2.41%=5.395% → 5.40% (nearest basis point, half up)", () => {
    expect(
      estimateAptc({ ...example, householdIncome: 27_387.5 }),
    ).toMatchObject({
      fplPercent: 175,
      applicablePercentage: 0.054,
      annualExpectedContributionCents: 147_900,
      expectedContributionCents: 12_300,
    });
  });
  it("185.987% truncates to 185%; interpolated 5.877% → 5.88%, NOT 186% or employer 9.96%", () => {
    expect(estimateAptc({ ...example, householdIncome: 29_107 })).toMatchObject(
      {
        fplPercent: 185,
        applicablePercentage: 0.0588,
        annualExpectedContributionCents: 171_100,
        expectedContributionCents: 14_300,
      },
    );
  });
  it("$51,250 ×9.96% = $5,104.50 → $5,105 annual before dividing by 12 → $425 monthly", () => {
    expect(estimateAptc({ ...example, householdIncome: 51_250 })).toMatchObject(
      {
        annualExpectedContributionCents: 510_500,
        expectedContributionCents: 42_500,
      },
    );
  });
  it("a benchmark with cents retains its cents; only IRS contribution amounts round to dollars", () => {
    expect(
      estimateAptc({ ...example, slcspMonthlyCents: 60_049 })
        .estimatedMonthlyCreditCents,
    ).toBe(42_849);
  });
});

// Boundary expectations are hand interpolated from each Revenue Procedure. One cent below an
// integer FPL band edge truncates to the preceding whole FPL percent (e.g. 149.999… → 149).
for (const [year, parameters, boundaries] of [
  [
    2026,
    parameters2026,
    [
      [100, null, 0.021],
      [133, 0.021, 0.0314],
      [150, 0.0413, 0.0419],
      [200, 0.0655, 0.066],
      [250, 0.084, 0.0844],
      [300, 0.0993, 0.0996],
      [400, 0.0996, 0.0996],
    ],
  ],
  [
    2027,
    parameters2027,
    [
      [100, null, 0.0215],
      [133, 0.0215, 0.0323],
      [150, 0.0424, 0.043],
      [200, 0.0673, 0.0678],
      [250, 0.0862, 0.0866],
      [300, 0.1019, 0.1022],
      [400, 0.1022, 0.1022],
    ],
  ],
] as const) {
  describe(`${year} every applicable-percentage band edge`, () => {
    for (const [edge, below, at] of boundaries) {
      it(`${edge}%: one cent below, exactly at, and one cent above`, () => {
        const incomeAt =
          (parameters.fpl.contiguous.annualDollarsBySize.value[0]! * edge) /
          100;
        const inputs = [-0.01, 0, 0.01].map((offset) => ({
          ...example,
          year,
          householdIncome: Number((incomeAt + offset).toFixed(2)),
        }));
        expect(applicablePercentageForFpl(edge - 1, parameters)).toBe(below);
        expect(applicablePercentageForFpl(edge, parameters)).toBe(at);
        inputs.forEach((input, index) => {
          const estimate = estimateAptc(input);
          function fplBoundaryIncome() {
            if (edge === 400 && index === 2) {
              return 401;
            } else if (index === 0) {
              return edge - 1;
            } else {
              return edge;
            }
          }
          expect(estimate.fplPercent).toBe(fplBoundaryIncome());
          if (edge <= 133) {
            expect(estimate.status).toBe("requires_state_rules");
            expect(estimate.estimatedMonthlyCreditCents).toBeNull();
          } else if (edge === 400 && index === 2) {
            // Exact >400 must not become eligible by truncating down to 400.
            expect(estimate.status).toBe("above_income_cliff");
            expect(estimate.estimatedMonthlyCreditCents).toBe(0);
          } else {
            expect(estimate.status).toBe("estimated");
            expect(estimate.applicablePercentage).toBe(
              index === 0 ? below : at,
            );
          }
        });
      });
    }
  });
}

describe("eligibility gaps and invalid inputs", () => {
  it.each([0, 15_649.99, 15_650, 20_814.5, 21_597])(
    "income %i needs state rules; below 100 is distinguished by reason",
    (householdIncome) => {
      const result = estimateAptc({ ...example, householdIncome });
      expect(result.status).toBe("requires_state_rules");
      expect(result.reason).toBe(
        householdIncome < 15_650
          ? "below_100_fpl"
          : "medicaid_expansion_review",
      );
      expect(result.applicablePercentage).toBeNull();
      expect(result.expectedContributionCents).toBeNull();
      expect(result.estimatedMonthlyCreditCents).toBeNull();
    },
  );
  it("138% + one cent passes the conservative screen; no Medicaid eligibility is claimed", () => {
    expect(
      estimateAptc({ ...example, householdIncome: 21_597.01 }).status,
    ).toBe("estimated");
  });
  it("unknown year has no numerical result", () => {
    expect(estimateAptc({ ...example, year: 2028 })).toMatchObject({
      status: "parameters_unconfirmed",
      fplPercent: null,
      applicablePercentage: null,
      expectedContributionCents: null,
      estimatedMonthlyCreditCents: null,
      annualExpectedContributionCents: null,
    });
  });
  it("parameters for a different year fail closed", () => {
    expect(estimateAptc(example, parameters2027).status).toBe(
      "parameters_unconfirmed",
    );
  });
  it("an income far above the cliff also uses Worksheet 2 figure 401, not its raw ratio", () => {
    expect(
      estimateAptc({ ...example, householdIncome: 156_500 }),
    ).toMatchObject({
      status: "above_income_cliff",
      fplPercent: 401,
      estimatedMonthlyCreditCents: 0,
    });
  });
  it("parameter helpers also refuse an unconfirmed year", () => {
    const unconfirmed = { ...parameters2026, status: "unconfirmed" as const };
    expect(applicablePercentageForFpl(200, unconfirmed)).toBeNull();
    expect(() => fplAnnualDollars(unconfirmed, 1, "AK")).toThrow(
      /Confirmed cited/,
    );
  });
  it("Puerto Rico and unknown states never silently use the contiguous table", () => {
    for (const state of ["PR", "ZZ", "tx", ""])
      expect(estimateAptc({ ...example, state })).toMatchObject({
        status: "requires_state_rules",
        reason: "unsupported_state",
        fplPercent: null,
        estimatedMonthlyCreditCents: null,
      });
  });
  it("contribution above benchmark produces zero credit", () => {
    expect(
      estimateAptc({ ...example, slcspMonthlyCents: 100 })
        .estimatedMonthlyCreditCents,
    ).toBe(0);
  });
  it.each([
    { householdIncome: -1 },
    { householdIncome: NaN },
    { householdIncome: Infinity },
    { householdIncome: 31_300.001 },
    { householdSize: 0 },
    { householdSize: 1.5 },
    { slcspMonthlyCents: -1 },
    { slcspMonthlyCents: 0.5 },
  ])("rejects invalid income, tax family size and cents: %j", (overrides) => {
    expect(() => estimateAptc({ ...example, ...overrides })).toThrow();
  });
});

describe("complete FPL tables including families larger than eight", () => {
  it.each([
    [
      parameters2026,
      "TX",
      [15650, 21150, 26650, 32150, 37650, 43150, 48650, 54150],
      5500,
    ],
    [
      parameters2026,
      "AK",
      [19550, 26430, 33310, 40190, 47070, 53950, 60830, 67710],
      6880,
    ],
    [
      parameters2026,
      "HI",
      [17990, 24320, 30650, 36980, 43310, 49640, 55970, 62300],
      6330,
    ],
    [
      parameters2027,
      "DC",
      [15960, 21640, 27320, 33000, 38680, 44360, 50040, 55720],
      5680,
    ],
    [
      parameters2027,
      "AK",
      [19950, 27050, 34150, 41250, 48350, 55450, 62550, 69650],
      7100,
    ],
    [
      parameters2027,
      "HI",
      [18360, 24890, 31420, 37950, 44480, 51010, 57540, 64070],
      6530,
    ],
  ] as const)(
    "HHS regional table %# matches all published sizes",
    (parameters, state, amounts, additional) => {
      amounts.forEach((dollars, index) =>
        expect(fplAnnualDollars(parameters, index + 1, state)).toBe(dollars),
      );
      expect(fplAnnualDollars(parameters, 9, state)).toBe(
        amounts[7] + additional,
      );
      expect(fplAnnualDollars(parameters, 12, state)).toBe(
        amounts[7] + 4 * additional,
      );
    },
  );
});

describe("gross, credit and net remain separate", () => {
  it("caps $500 credit at $400.99 gross and includes the mandated estimate metadata", () => {
    expect(netPremium(40_099, 50_000)).toEqual({
      grossMonthlyPremiumCents: 40_099,
      estimatedMonthlyCreditCents: 40_099,
      estimatedNetMonthlyPremiumCents: 0,
      quote_method: "puf_calculation",
      bindable_quote: false,
    });
    expect(netPremium(60_000, 42_800).estimatedNetMonthlyPremiumCents).toBe(
      17_200,
    );
    expect(netPremium(40000, 50000, 36000)).toMatchObject({
      estimatedMonthlyCreditCents: 36000,
      estimatedNetMonthlyPremiumCents: 4000,
    });
    expect(() => netPremium(40000, 50000, 40001)).toThrow();
    expect(netPremium(0, 0).estimatedNetMonthlyPremiumCents).toBe(0);
    expect(() => netPremium(-1, 0)).toThrow();
    expect(() => netPremium(10, 0.5)).toThrow();
  });
});
