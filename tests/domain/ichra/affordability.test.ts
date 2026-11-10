import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import * as ichra from "../../../src/domain/ichra/index.js";
import { parameterRegistry } from "../../../src/domain/subsidy/generated.js";
import { rebaseImports, replaceSyntax } from "../../source-mutation.js";
import { CASES, evaluateCase, matches } from "./cases.mjs";

type Case = (typeof CASES)[number];

describe("ICHRA affordability hand cases (SYNTHETIC LCSP inputs)", () => {
  it.each(CASES.map((c) => [c.id, c] as const))("%s", (_id, c: Case) => {
    const result = evaluateCase(c.input, ichra);
    expect(result.status, c.hand).toBe("calculated");
    expect(result, c.hand).toMatchObject(c.expect);
  });
});

describe("exact comparison", () => {
  it("compares rational cents without rounding: $286.35 against $286.349917", () => {
    const contribution = ichra.requiredHraContribution(58_621, 359_832, 12);
    expect(contribution).toEqual({
      // 58,621 x 12 - 359,832 = 343,620 cents over 12 months, exactly $286.35.
      numerator: 28_635,
      denominator: 1,
      display: 28_635,
    });
    const context = {
      requiredContributionBasisPoints: 996,
      rateOfPayHours: 130,
      purpose: "premium_tax_credit" as const,
      povertyLine: null,
      fullCalendarYear: true,
    };
    const verdict = ichra.affordabilityVerdict(
      { measure: "household", annualCents: 3_449_999 },
      contribution,
      context,
    );
    // 3,449,999 x 996 / 120,000 = 3,436,199,004 / 120,000 cents, just under 28,635.
    expect(verdict.thresholdCents).toEqual({
      numerator: 286_349_917,
      denominator: 10_000,
      display: 28_635,
    });
    expect(verdict.affordable).toBe(false);
  });
  it("rejects fractional cents, negative amounts and months outside 1-12", () => {
    expect(() => ichra.requiredHraContribution(1.5, 0, 12)).toThrow(RangeError);
    expect(() => ichra.requiredHraContribution(100, -1, 12)).toThrow(
      RangeError,
    );
    expect(() => ichra.monthlyHraAmount(100, 0)).toThrow(RangeError);
    expect(() => ichra.monthlyHraAmount(100, 13)).toThrow(RangeError);
  });
});

describe("safe-harbor dates and locations", () => {
  it("look-back month: prior January for calendar plans, current January otherwise", () => {
    expect(ichra.lookBackMonth("2027-01-01")).toBe("2026-01-01");
    expect(ichra.lookBackMonth("2027-07-01")).toBe("2027-01-01");
  });
  it("applicable age uses the later of plan start and the date the HRA can first take effect", () => {
    expect(ichra.applicableAge("1985-06-30", "2026-01-01")).toBe(40);
    expect(ichra.applicableAge("1985-06-30", "2026-01-01", "2026-07-01")).toBe(
      41,
    );
    expect(ichra.applicableAge("1985-06-30", "2026-01-01", "2025-12-01")).toBe(
      40,
    );
  });
  it("poverty guideline: in effect on plan start, six-month allowance when a successor may exist", () => {
    const guidelines = [
      { guidelineYear: 2025, effectiveDate: "2025-01-15" },
      { guidelineYear: 2026, effectiveDate: "2026-01-13" },
    ];
    expect(
      ichra.guidelineInEffect("2026-01-01", guidelines)?.guidelineYear,
    ).toBe(2025);
    expect(
      ichra.guidelineInEffect("2026-01-13", guidelines)?.guidelineYear,
    ).toBe(2026);
    expect(
      ichra.guidelineInEffect("2027-06-30", guidelines)?.guidelineYear,
    ).toBe(2026);
    // Six months before 2027-07-01 is 2027-01-01, when a 2027 guideline may already apply.
    expect(ichra.guidelineInEffect("2027-07-01", guidelines)).toBeNull();
    expect(ichra.guidelineInEffect("2025-01-01", guidelines)).toBeNull();
  });
  it("poverty line follows the state of employment, including Alaska and Hawaii tables", () => {
    expect(ichra.onePersonPovertyLine(2025, "TX")?.annualDollars).toBe(15_650);
    expect(ichra.onePersonPovertyLine(2025, "AK")?.annualDollars).toBe(19_550);
    expect(ichra.onePersonPovertyLine(2026, "HI")?.annualDollars).toBe(18_360);
    expect(ichra.onePersonPovertyLine(2024, "TX")).toBeNull();
  });
});

describe("cited ICHRA parameters", () => {
  it("2026 and 2027 are confirmed and read the percentage from the subsidy tables", () => {
    for (const [year, bp, procedure] of [
      [2026, 996, "rp-25-25.pdf"],
      [2027, 1022, "rp-26-26.pdf"],
    ] as const) {
      const lookup = ichra.ichraParameters(year);
      expect(lookup.status).toBe("confirmed");
      if (lookup.status !== "confirmed") continue;
      expect(lookup.parameters.requiredContributionBasisPoints).toBe(bp);
      expect(lookup.parameters.requiredContributionCitations[0]!.url).toContain(
        procedure,
      );
      expect(lookup.parameters.lcspPremiumBasisDefault).toBe("gross");
      expect(lookup.parameters.rules.location_safe_harbor.status).toBe(
        "proposed_reliance_permitted",
      );
      expect(lookup.parameters.rules.affordability.status).toBe("final");
    }
  });
  it("every safe-harbor rule from the 2019 proposal is labelled proposed", () => {
    const lookup = ichra.ichraParameters(2026);
    if (lookup.status !== "confirmed") throw new Error("expected confirmed");
    for (const rule of Object.values(lookup.parameters.rules)) {
      const proposed = rule.citations.some((c) =>
        c.title.includes("Proposed rule"),
      );
      const finalOnly = rule.citations.every(
        (c) => !c.title.includes("Proposed rule"),
      );
      if (proposed)
        expect(rule.status, rule.id).toBe("proposed_reliance_permitted");
      if (finalOnly) expect(rule.status, rule.id).toBe("final");
    }
  });
  it("an unknown year, an unconfirmed file or a bad citation host gives parameters_unconfirmed", () => {
    expect(ichra.ichraParameters(2025).status).toBe("parameters_unconfirmed");
    const file = JSON.parse(
      readFileSync(
        new URL("../../../data/ichra/2026.json", import.meta.url),
        "utf8",
      ),
    );
    expect(ichra.ichraParameterErrors(file)).toEqual([]);
    const unconfirmed = { ...file, status: "unconfirmed" };
    expect(ichra.ichraParameters(2026, { 2026: unconfirmed })).toEqual({
      status: "parameters_unconfirmed",
      reason: "unconfirmed",
    });
    const badHost = structuredClone(file);
    badHost.rules.affordability.citations[0].url =
      "https://example.com/1.36B-2";
    expect(ichra.ichraParameterErrors(badHost).join()).toContain(
      "rules.affordability",
    );
    expect(ichra.ichraParameters(2026, { 2026: badHost }).status).toBe(
      "parameters_unconfirmed",
    );
    const badStatus = structuredClone(file);
    badStatus.rules.look_back_month.value.status = "final_maybe";
    expect(ichra.ichraParameterErrors(badStatus)).toContain(
      "rules.look_back_month: status and summary required",
    );
    expect(
      ichra.ichraParameters(
        2026,
        { 2026: file },
        { ...parameterRegistry, 2026: {} },
      ),
    ).toEqual({
      status: "parameters_unconfirmed",
      reason: "required_contribution_percentage_unconfirmed",
    });
  });
  it("the generated registry matches data/ichra/*.json", async () => {
    const { readParameterFiles, registrySource } =
      await import("../../../scripts/ichra/registry.mjs");
    const generated = readFileSync(
      new URL("../../../src/domain/ichra/generated.ts", import.meta.url),
      "utf8",
    );
    expect(generated).toBe(registrySource(await readParameterFiles()));
  });
});

const dist = new URL("../../../dist/domain/ichra/", import.meta.url);
const MUTANTS = [
  {
    name: "age_on_last_day_of_plan_year",
    file: "safe-harbors.js",
    before: "return ageOnDate(dateOfBirth, reference);",
    after: 'return ageOnDate(dateOfBirth, planStart.slice(0, 4) + "-12-31");',
  },
  {
    name: "prior_year_percentage",
    file: "parameters.js",
    before: "const subsidy = confirmedSubsidy(year, subsidyRegistry);",
    after: "const subsidy = confirmedSubsidy(year - 1, subsidyRegistry);",
  },
  {
    name: "strict_less_than",
    file: "affordability.js",
    before:
      "BigInt(contribution.numerator) * thresholdDenominator <= thresholdNumerator * BigInt(contribution.denominator)",
    after:
      "BigInt(contribution.numerator) * thresholdDenominator < thresholdNumerator * BigInt(contribution.denominator)",
  },
];

describe("negative controls: source mutants of the built domain must fail named cases", () => {
  it.each(MUTANTS.map((m) => [m.name, m] as const))("%s", (_name, mutant) => {
    const directory = mkdtempSync(join(tmpdir(), "openplans-ichra-mutant-"));
    try {
      const original = new URL(mutant.file, dist);
      const source = replaceSyntax(
        readFileSync(original, "utf8"),
        mutant.before,
        mutant.after,
      );
      const mutated = join(directory, mutant.file);
      writeFileSync(mutated, rebaseImports(source, original));
      const cases = new URL("./cases.mjs", import.meta.url).href;
      const index = new URL("index.js", dist).href;
      const script = `
import * as built from ${JSON.stringify(index)};
import * as mutant from ${JSON.stringify(pathToFileURL(mutated).href)};
import { CASES, evaluateCase, matches } from ${JSON.stringify(cases)};
const m = { ...built, ...mutant };
const out = {};
for (const c of CASES) {
  let ok;
  try { const r = evaluateCase(c.input, m); ok = r.status === "calculated" && matches(r, c.expect); }
  catch { ok = false; }
  out[c.id] = ok;
}
console.log(JSON.stringify(out));`;
      const output = JSON.parse(
        execFileSync(process.execPath, ["--input-type=module", "-e", script], {
          encoding: "utf8",
        }),
      ) as Record<string, boolean>;
      const targets = CASES.filter((c) =>
        (c as { kills?: string[] }).kills?.includes(mutant.name),
      );
      expect(targets.length).toBeGreaterThan(0);
      for (const target of targets)
        expect(output[target.id], target.id).toBe(false);
      // The same harness with the unmutated build passes every case.
      expect(
        matches(evaluateCase(CASES[0]!.input, ichra), CASES[0]!.expect),
      ).toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("W-2 safe harbor, partial-year offer (SYNTHETIC wages and contributions)", () => {
  // Hand case from 26 CFR 54.4980H-5(e)(2)(ii)(B): wages $30,000, employed in 10 calendar months,
  // HRA offered in 6. Adjusted wages are 30,000 x 6 / 10 = $18,000; 9.96% of that is $1,792.80
  // for the six offered months, which is $298.80 a month.
  const context = {
    requiredContributionBasisPoints: 996,
    rateOfPayHours: 130,
    purpose: "employer_4980H" as const,
    povertyLine: null,
    fullCalendarYear: false,
    w2PartialYear: { monthsOffered: 6, monthsEmployed: 10 },
  };
  const wages = { measure: "w2" as const, annualCents: 3_000_000 };
  const monthly = (cents: number) => ({
    numerator: cents,
    denominator: 1,
    display: cents,
  });
  it("is affordable at $298.80 a month and not at $298.81", () => {
    const at = ichra.affordabilityVerdict(wages, monthly(29_880), context);
    expect(at).toMatchObject({ status: "calculated", affordable: true });
    expect(at.thresholdCents?.display).toBe(29_880);
    expect(
      ichra.affordabilityVerdict(wages, monthly(29_881), context).affordable,
    ).toBe(false);
  });
  it("stays unknown without the month counts, and a full year ignores them", () => {
    const { w2PartialYear: _counts, ...bare } = context;
    expect(
      ichra.affordabilityVerdict(wages, monthly(29_880), bare),
    ).toMatchObject({
      status: "unknown",
      affordable: null,
      reason: "w2_partial_year_not_supported",
    });
    // Full year: 30,000 x 9.96% / 12 = $249.00.
    expect(
      ichra.affordabilityVerdict(wages, monthly(24_901), {
        ...context,
        fullCalendarYear: true,
      }).affordable,
    ).toBe(false);
  });
  it("rejects month counts the rule cannot produce", () => {
    for (const counts of [
      { monthsOffered: 0, monthsEmployed: 10 },
      { monthsOffered: 7, monthsEmployed: 6 },
      { monthsOffered: 6, monthsEmployed: 13 },
      { monthsOffered: 1.5, monthsEmployed: 10 },
    ])
      expect(() =>
        ichra.affordabilityVerdict(wages, monthly(1), {
          ...context,
          w2PartialYear: counts,
        }),
      ).toThrow(RangeError);
  });
  it("planted defect: dividing by the months offered passes $298.81", () => {
    const original = new URL(
      "../../../dist/domain/ichra/affordability.js",
      import.meta.url,
    );
    const directory = mkdtempSync(join(tmpdir(), "openplans-w2-mutant-"));
    try {
      const source = replaceSyntax(
        readFileSync(original, "utf8"),
        "return BigInt(monthsEmployed);",
        "return BigInt(monthsOffered);",
      );
      const path = join(directory, "affordability.mjs");
      writeFileSync(path, rebaseImports(source, original));
      const output = execFileSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `import { affordabilityVerdict } from ${JSON.stringify(pathToFileURL(path).href)};
import { readFileSync } from "node:fs";
const { wages, contribution, context } = JSON.parse(readFileSync(0, "utf8"));
console.log(JSON.stringify(affordabilityVerdict(wages, contribution, context)));`,
        ],
        {
          input: JSON.stringify({
            wages,
            contribution: monthly(29_881),
            context,
          }),
          encoding: "utf8",
        },
      );
      expect(JSON.parse(output).affordable).toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("rate of pay safe harbor, hourly rate that changes (SYNTHETIC rates)", () => {
  // Hand case from 26 CFR 54.4980H-5(e)(2)(iii): $20.00 on the first day of the coverage period,
  // cut to $18.00 during the month. 130 x 18.00 x 9.96% = $233.06 (233.064 exactly).
  const context = {
    requiredContributionBasisPoints: 996,
    rateOfPayHours: 130,
    purpose: "employer_4980H" as const,
    povertyLine: null,
    fullCalendarYear: true,
  };
  const monthly = (cents: number) => ({
    numerator: cents,
    denominator: 1,
    display: cents,
  });
  const cut = {
    measure: "rate_of_pay_hourly" as const,
    hourlyCents: 2_000,
    lowestInMonthCents: 1_800,
  };
  it("uses the lower rate after a cut: $233.06 affordable, $233.07 not", () => {
    expect(
      ichra.affordabilityVerdict(cut, monthly(23_306), context).affordable,
    ).toBe(true);
    expect(
      ichra.affordabilityVerdict(cut, monthly(23_307), context).affordable,
    ).toBe(false);
  });
  it("a raise during the month does not lift the threshold above the first-day rate", () => {
    // 130 x 20.00 x 9.96% = $258.96.
    const raised = { ...cut, lowestInMonthCents: 2_200 };
    expect(
      ichra.affordabilityVerdict(raised, monthly(25_896), context).affordable,
    ).toBe(true);
    expect(
      ichra.affordabilityVerdict(raised, monthly(25_897), context).affordable,
    ).toBe(false);
  });
  it("planted defect: taking the higher rate passes $233.07", () => {
    const original = new URL(
      "../../../dist/domain/ichra/affordability.js",
      import.meta.url,
    );
    const directory = mkdtempSync(join(tmpdir(), "openplans-rate-mutant-"));
    try {
      const source = replaceSyntax(
        readFileSync(original, "utf8"),
        "return lowest < first ? lowest : first;",
        "return lowest > first ? lowest : first;",
      );
      const path = join(directory, "affordability.mjs");
      writeFileSync(path, rebaseImports(source, original));
      const output = execFileSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `import { affordabilityVerdict } from ${JSON.stringify(pathToFileURL(path).href)};
import { readFileSync } from "node:fs";
const { income, contribution, context } = JSON.parse(readFileSync(0, "utf8"));
console.log(JSON.stringify(affordabilityVerdict(income, contribution, context)));`,
        ],
        {
          input: JSON.stringify({
            income: cut,
            contribution: monthly(23_307),
            context,
          }),
          encoding: "utf8",
        },
      );
      expect(JSON.parse(output).affordable).toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("rate of pay safe harbor, reduced salary (SYNTHETIC salary)", () => {
  // 26 CFR 54.4980H-5(e)(2)(iii): "if the monthly salary is reduced, including due to a
  // reduction in work hours, the safe harbor is not available". Without a reduction:
  // $3,000.00 x 9.96% = $298.80.
  const context = {
    requiredContributionBasisPoints: 996,
    rateOfPayHours: 130,
    purpose: "employer_4980H" as const,
    povertyLine: null,
    fullCalendarYear: true,
  };
  const monthly = (cents: number) => ({
    numerator: cents,
    denominator: 1,
    display: cents,
  });
  const salary = {
    measure: "rate_of_pay_salary" as const,
    monthlyCents: 300_000,
  };
  it("a reduced salary gives no verdict; an unreduced one is affordable at $298.80, not at $298.81", () => {
    expect(
      ichra.affordabilityVerdict(
        { ...salary, reduced: true },
        monthly(1),
        context,
      ),
    ).toMatchObject({
      status: "unknown",
      reason: "rate_of_pay_salary_reduced",
      affordable: null,
      thresholdCents: null,
      ruleIds: expect.arrayContaining(["rate_of_pay_safe_harbor"]),
    });
    for (const unreduced of [salary, { ...salary, reduced: false }]) {
      expect(
        ichra.affordabilityVerdict(unreduced, monthly(29_880), context)
          .affordable,
      ).toBe(true);
      expect(
        ichra.affordabilityVerdict(unreduced, monthly(29_881), context)
          .affordable,
      ).toBe(false);
    }
  });
  it("a stated reason keeps the W-2 verdict unknown even with month counts", () => {
    expect(
      ichra.affordabilityVerdict(
        { measure: "w2", annualCents: 3_000_000 },
        monthly(1),
        {
          ...context,
          fullCalendarYear: false,
          w2PartialYear: { monthsOffered: 6, monthsEmployed: 10 },
          w2Unavailable: "w2_non_calendar_plan_year_not_supported",
        },
      ),
    ).toMatchObject({
      status: "unknown",
      reason: "w2_non_calendar_plan_year_not_supported",
      affordable: null,
    });
  });
  it("planted defect: ignoring the reduction answers affordable", () => {
    const original = new URL(
      "../../../dist/domain/ichra/affordability.js",
      import.meta.url,
    );
    const directory = mkdtempSync(join(tmpdir(), "openplans-salary-mutant-"));
    try {
      const source = replaceSyntax(
        readFileSync(original, "utf8"),
        "if (income.reduced)",
        "if (false)",
      );
      const path = join(directory, "affordability.mjs");
      writeFileSync(path, rebaseImports(source, original));
      const output = execFileSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `import { affordabilityVerdict } from ${JSON.stringify(pathToFileURL(path).href)};
import { readFileSync } from "node:fs";
const { income, contribution, context } = JSON.parse(readFileSync(0, "utf8"));
console.log(JSON.stringify(affordabilityVerdict(income, contribution, context)));`,
        ],
        {
          input: JSON.stringify({
            income: { ...salary, reduced: true },
            contribution: monthly(29_880),
            context,
          }),
          encoding: "utf8",
        },
      );
      expect(JSON.parse(output)).toMatchObject({
        status: "calculated",
        affordable: true,
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
