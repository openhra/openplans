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
