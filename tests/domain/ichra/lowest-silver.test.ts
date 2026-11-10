import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { lowestAgeBandLcsp } from "../../../src/domain/ichra/index.js";
import { householdPremium } from "../../../src/domain/rating/index.js";
import type { RateRow } from "../../../src/domain/rating/index.js";
import {
  allocatePremium,
  lowestCostSilver,
  rankSilverPlans,
  slcsp,
} from "../../../src/domain/subsidy/index.js";
import type {
  SilverPremiumBasis,
  SlcspCandidate,
  SlcspHousehold,
} from "../../../src/domain/subsidy/index.js";
import { AREA, DATE, syntheticRow } from "../rating/helpers.js";
import { rebaseImports, replaceSyntax } from "../../source-mutation.js";

/** SYNTHETIC self-only employee and SYNTHETIC prices, rated by the real engine. */
function employee(age: number): SlcspHousehold {
  return {
    coverageStartDate: DATE,
    ratingMethod: "per_member",
    benchmarkScope: "single_location_single_policy",
    members: [{ id: "0", age, relationship: "subscriber", tobaccoUse: false }],
  };
}
const A = "20069TX0100006",
  B = "29418TX0140049",
  C = "87226TX0100013";
function candidate(
  planId: string,
  cents: number,
  age = 40,
  basis: SilverPremiumBasis = "lcsp_self_only_premium",
  area = AREA,
): SlcspCandidate {
  const band: RateRow["age"] = age < 15 ? "0-14" : age;
  const row = syntheticRow(
    {
      PlanId: planId,
      IndividualRate: (cents / 100).toFixed(2),
      RatingAreaId: area,
    },
    band,
  );
  return {
    planId,
    metalLevel: "Silver",
    onExchange: true,
    availableToHousehold: true,
    benchmarkBasis: basis,
    premium: householdPremium([row], planId, area, employee(age)),
  };
}

describe("one silver ranking, two picks", () => {
  const plans = [
    candidate(C, 50_000),
    candidate(A, 40_000),
    candidate(B, 45_000),
  ];
  it("the LCSP is index 0 and the benchmark index 1 of the same ranking", () => {
    expect(lowestCostSilver(plans, employee(40))).toMatchObject({
      status: "calculated",
      lcspMonthlyCents: 40_000,
      planIds: [A],
      uniquePlanCount: 3,
      ratingAreaId: AREA,
    });
    const ptc = [C, A, B].map((id, i) =>
      candidate(
        id,
        [50_000, 40_000, 45_000][i]!,
        40,
        "ehb_only_no_dental_adjustment_required",
      ),
    );
    expect(slcsp(ptc, employee(40))).toMatchObject({
      status: "calculated",
      slcspMonthlyCents: 45_000,
      planIds: [B],
    });
  });
  it("distinct tied plans are all listed", () => {
    expect(
      lowestCostSilver(
        [candidate(B, 40_000), candidate(A, 40_000)],
        employee(40),
      ).planIds,
    ).toEqual([A, B]);
  });
  it("CSR variants of one base plan are one plan; conflicting duplicate prices fail closed", () => {
    const variant = { ...candidate(A, 40_000), planId: `${A}-01` };
    expect(
      lowestCostSilver(
        [candidate(A, 40_000), variant, candidate(B, 41_000)],
        employee(40),
      ),
    ).toMatchObject({ status: "calculated", uniquePlanCount: 2 });
    const conflicting = { ...candidate(A, 39_000), planId: `${A}-02` };
    expect(
      lowestCostSilver([candidate(A, 40_000), conflicting], employee(40)),
    ).toMatchObject({
      status: "ambiguous_lcsp",
      issues: [`${A}: conflicting_duplicate_prices`],
    });
  });
  it("mixed rating areas and unrated plans make the LCSP incomplete", () => {
    expect(
      lowestCostSilver(
        [
          candidate(A, 40_000),
          candidate(B, 41_000, 40, "lcsp_self_only_premium", "Rating Area 3"),
        ],
        employee(40),
      ).status,
    ).toBe("incomplete_lcsp");
    const unrated = {
      ...candidate(A, 40_000),
      premium: householdPremium([], A, AREA, employee(40)),
    };
    expect(
      lowestCostSilver([unrated, candidate(B, 41_000)], employee(40)).status,
    ).toBe("incomplete_lcsp");
  });
  it("each pick accepts only its own premium attestation", () => {
    const ptc = candidate(
      A,
      40_000,
      40,
      "ehb_only_no_dental_adjustment_required",
    );
    expect(lowestCostSilver([ptc], employee(40)).status).toBe(
      "requires_premium_adjustments",
    );
    expect(slcsp([candidate(A, 40_000)], employee(40)).status).toBe(
      "requires_benchmark_adjustments",
    );
    expect(rankSilverPlans([candidate(A, 40_000)], employee(40)).status).toBe(
      "requires_adjustments",
    );
  });
  it("gross and EHB-portion rankings can pick different plans", () => {
    // SYNTHETIC: A $600.00 with EHB fraction 1; B $610.00 with EHB fraction 0.95 = $579.50.
    const gross = [candidate(A, 60_000), candidate(B, 61_000)];
    const ehb = [
      candidate(A, allocatePremium(60_000, "1")!),
      candidate(B, allocatePremium(61_000, "0.95")!),
    ];
    expect(lowestCostSilver(gross, employee(40))).toMatchObject({
      planIds: [A],
      lcspMonthlyCents: 60_000,
    });
    expect(lowestCostSilver(ehb, employee(40))).toMatchObject({
      planIds: [B],
      lcspMonthlyCents: 57_950,
    });
  });
});

describe("lowest-age-band identification (prop. 54.4980H-5(f)(7)(iii)(C))", () => {
  it("identifies at the 0-14 band and prices that plan at the applicable age", () => {
    // SYNTHETIC: A is cheapest at 0-14 ($290 vs $300) but dearer at 40 ($520 vs $500).
    const result = lowestAgeBandLcsp(
      [candidate(A, 29_000, 14), candidate(B, 30_000, 14)],
      employee(14),
      [candidate(A, 52_000), candidate(B, 50_000)],
      employee(40),
    );
    expect(result).toMatchObject({
      status: "calculated",
      planIds: [A],
      lcspMonthlyCents: 52_000,
      pricesAtAge: [52_000],
    });
  });
  it("a tie at the band whose prices differ at the applicable age is reported, not resolved", () => {
    const result = lowestAgeBandLcsp(
      [candidate(A, 30_000, 14), candidate(B, 30_000, 14)],
      employee(14),
      [candidate(A, 52_000), candidate(B, 50_000)],
      employee(40),
    );
    expect(result).toMatchObject({
      status: "calculated",
      planIds: [A, B],
      lcspMonthlyCents: null,
      pricesAtAge: [50_000, 52_000],
      issues: ["lowest_age_band_tie_prices_differ"],
    });
  });
  it("different plan sets at the two ages fail closed", () => {
    expect(
      lowestAgeBandLcsp(
        [candidate(A, 30_000, 14)],
        employee(14),
        [candidate(A, 52_000), candidate(B, 50_000)],
        employee(40),
      ).status,
    ).toBe("incomplete_lcsp");
  });
});

describe("negative control: an LCSP that picks the second plan must fail", () => {
  it("compiled mutant lowestCostSilver selecting index 1 returns the wrong premium", () => {
    const original = new URL(
      "../../../dist/domain/subsidy/slcsp.js",
      import.meta.url,
    );
    const directory = mkdtempSync(join(tmpdir(), "openplans-lcsp-mutant-"));
    try {
      const source = replaceSyntax(
        readFileSync(original, "utf8"),
        "const lowest = ranking.ranked[0].monthlyCents;",
        "const lowest = ranking.ranked[Math.min(1, ranking.ranked.length - 1)].monthlyCents;",
      );
      const path = join(directory, "slcsp.mjs");
      writeFileSync(path, rebaseImports(source, original));
      const input = JSON.stringify({
        plans: [
          candidate(C, 50_000),
          candidate(A, 40_000),
          candidate(B, 45_000),
        ],
        household: employee(40),
      });
      const output = execFileSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `import { lowestCostSilver } from ${JSON.stringify(pathToFileURL(path).href)};
import { readFileSync } from "node:fs";
const { plans, household } = JSON.parse(readFileSync(0, "utf8"));
console.log(JSON.stringify(lowestCostSilver(plans, household)));`,
        ],
        { input, encoding: "utf8" },
      );
      const mutant = JSON.parse(output);
      expect(mutant.lcspMonthlyCents).toBe(45_000);
      expect(mutant.lcspMonthlyCents).not.toBe(40_000);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
