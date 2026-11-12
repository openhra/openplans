// Cost-sharing bounds on two real plans. Rows come from tests/fixtures/medicare-costs/
// bound-plans.json, cut from the CMS 2026 Q3 Part D files and the 2026 PBP archive. Prices are
// synthetic and labelled so.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { BoundDeps } from "../../src/domain/medicare/part-d-cost/bounds.js";
import {
  boundDeps,
  boundRules,
  classifyBounds,
} from "../../src/domain/medicare/part-d-cost/bounds.js";
import {
  div,
  mul,
  rational,
} from "../../src/domain/medicare/part-d-cost/decimal.js";
import type {
  BenefitType,
  EngineDeps,
  EstimateRequest,
  FillResult,
  OpeningState,
} from "../../src/domain/medicare/part-d-cost/engine.js";
import {
  createEstimator,
  engineDeps,
} from "../../src/domain/medicare/part-d-cost/engine.js";
import type {
  BenefitBundle,
  StoredRow,
} from "../../src/domain/medicare/part-d-cost/repository.js";
import {
  decodePlanRows,
  decodeTierCosts,
  yearRules,
} from "../../src/domain/medicare/part-d-cost/repository.js";
import type { SpufChannel } from "../../src/ingest/medicare/spuf.js";

interface Row {
  member: string;
  source_row: number;
  cells: Record<string, string>;
}
interface Fixture {
  spuf: { url: string; sha256: string; contract_year: number };
  pbp: { url: string; sha256: string; contract_year: number };
  plans: Record<
    string,
    {
      plan: Row[];
      beneficiary_cost: Row[];
      pbp_mrx: Row[];
      pbp_mrx_tier: Row[];
    }
  >;
}
const fixture = JSON.parse(
  readFileSync(
    new URL("../fixtures/medicare-costs/bound-plans.json", import.meta.url),
    "utf8",
  ),
) as Fixture;

/** PBP dictionary codes for mrx_benefit_type (C13 rows 25379-25382). */
const BENEFIT: Record<string, BenefitType> = {
  "1": "DS",
  "2": "AE",
  "3": "BA",
  "4": "EA",
};
const G = "H3664-017-000";
const LIS = "H0251-004-000";
const stored = (rows: Row[]): StoredRow[] =>
  rows.map((row) => ({ cells: row.cells, source_row: row.source_row }));

function planBundle(key: string, tier: number): BenefitBundle {
  const plan = fixture.plans[key]!;
  const rules = yearRules(2026);
  const planned = decodePlanRows(
    fixture.spuf.sha256,
    stored(plan.plan).map((row) => ({
      ...row,
      formulary_id: row.cells.FORMULARY_ID!,
      suppressed: row.cells.PLAN_SUPPRESSED_YN === "Y",
    })),
    rules,
  );
  const costs = decodeTierCosts(
    fixture.spuf.sha256,
    stored(plan.beneficiary_cost),
    rules,
  );
  return {
    status: "available",
    bundle_version: "1",
    plan_key: key,
    contract_year: 2026,
    release: {
      snapshot_id: fixture.spuf.sha256,
      kind: "quarterly",
      contract_year: 2026,
      as_of: "2026-10-07",
      sha256: fixture.spuf.sha256,
      url: fixture.spuf.url,
    },
    formulary_id: planned.formularies[0]!,
    deductible: planned.deductible,
    deductible_evidence: planned.evidence,
    special_needs_plan: planned.special_needs_plan,
    tiers: costs.tiers,
    insulin: [],
    drugs: [
      {
        rxcui: "1000",
        status: "listed",
        reason: null,
        product: "single",
        // SYNTHETIC formulary listing: only the tier matters to these tests.
        packages: [
          {
            proxy_ndc: "00000000001",
            tier,
            prior_authorization: false,
            step_therapy: false,
            quantity_limit: false,
            quantity_limit_amount: null,
            quantity_limit_days: null,
            selected_drug: false,
            formulary_version: "1",
            evidence: {
              snapshot_id: "synthetic",
              table: "formulary",
              source_row: 1,
              fields: [],
            },
          },
        ],
        supplemental: [],
        indications: [],
      },
    ],
    rules,
    conflicts: [...planned.conflicts, ...costs.conflicts],
    gaps: [],
  };
}
const benefitOf = (key: string) =>
  BENEFIT[fixture.plans[key]!.pbp_mrx[0]!.cells.mrx_benefit_type!]!;

interface Case {
  plan: string;
  tier: number;
  days: number;
  price: string;
  channel?: SpufChannel;
  opening?: OpeningState;
  benefit?: BenefitType;
}
function request(c: Case): EstimateRequest {
  return {
    contract_year: 2026,
    scenario: "non_lis_no_other_payer",
    benefit_type: c.benefit ?? benefitOf(c.plan),
    bundle: planBundle(c.plan, c.tier),
    // H0251-004 offers no preferred retail channel (cost type 0), so its cases use standard retail.
    channel:
      c.channel ?? (c.plan === LIS ? "standard_retail" : "preferred_retail"),
    opening: c.opening ?? { kind: "new_calendar_year" },
    fills: [
      {
        fill_id: "a",
        date: "2026-06-01",
        rxcui: "1000",
        days_supply: c.days,
        quantity: "30",
        unit: "tablet",
        classification: {
          insulin: false,
          acip_vaccine: false,
          program: "not_applicable",
        },
      },
    ],
    prices: {
      a: {
        status: "value",
        amount: c.price,
        basis: "synthetic",
        reference: "synthetic test price",
      },
    },
  };
}
const fillOf = (c: Case, deps: EngineDeps = engineDeps): FillResult => {
  const result = createEstimator(deps)(request(c));
  if (!("fills" in result)) throw new Error(JSON.stringify(result));
  return result.fills[0]!;
};
const pay = (f: FillResult) =>
  f.patient_pay.status === "value"
    ? f.patient_pay.cents
    : `unknown:${f.patient_pay.reason}`;
const deductibleMet: OpeningState = {
  kind: "provided",
  as_of: "2026-01-01",
  gross_cents: 61500,
  troop_cents: 61500,
  plan_deductible_met_cents: 61500,
};
const atThreshold: OpeningState = {
  kind: "provided",
  as_of: "2026-01-01",
  gross_cents: 900000,
  troop_cents: 210000,
  plan_deductible_met_cents: 61500,
};

describe("H3664-017 tier 3, 2026: greater of 20% and a 47/94/141 minimum", () => {
  it("is an enhanced alternative plan whose PBP tier files structure 3 with those copays", () => {
    const plan = fixture.plans[G]!;
    expect(benefitOf(G)).toBe("EA");
    expect(plan.pbp_mrx_tier[0]!.cells).toMatchObject({
      mrx_tier_cstshr_struct_type: "3",
      mrx_tier_rspfd_copay_1m: "47.00",
      mrx_tier_rspfd_coins_1m: "20",
      mrx_tier_rsstd_copay_2m: "94.00",
      mrx_tier_rsstd_copay_3m: "141.00",
    });
    // SPUF minimums by supply code: 1 = 30 days, 4 = 60 days, 2 = 90 days.
    const minimums = Object.fromEntries(
      plan.beneficiary_cost
        .filter((row) => row.cells.COVERAGE_LEVEL === "1")
        .map((row) => [row.cells.DAYS_SUPPLY, row.cells.COST_MIN_AMT_PREF]),
    );
    expect(minimums).toEqual({ "1": "47", "4": "94", "2": "141" });
  });
  it("charges the minimum when 20% is less, per fill and not prorated", () => {
    expect(pay(fillOf({ plan: G, tier: 3, days: 30, price: "100.00" }))).toBe(
      4700,
    );
    expect(pay(fillOf({ plan: G, tier: 3, days: 60, price: "400.00" }))).toBe(
      9400,
    );
    expect(pay(fillOf({ plan: G, tier: 3, days: 90, price: "500.00" }))).toBe(
      14100,
    );
  });
  it("charges 20% when it is more, and never more than the claim", () => {
    expect(pay(fillOf({ plan: G, tier: 3, days: 30, price: "300.00" }))).toBe(
      6000,
    );
    expect(pay(fillOf({ plan: G, tier: 3, days: 90, price: "1000.00" }))).toBe(
      20000,
    );
    expect(pay(fillOf({ plan: G, tier: 3, days: 30, price: "30.00" }))).toBe(
      3000,
    );
  });
  it("cites the dictionary row and the filed SPUF row", () => {
    const f = fillOf({ plan: G, tier: 3, days: 30, price: "100.00" });
    expect(f.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "rule",
          document: "C13",
          member: "PBP_Benefits_2026_dictionary.xlsx",
          row: 25630,
        }),
        expect.objectContaining({
          kind: "source_row",
          table: "beneficiary_cost",
          source_row: 64311,
        }),
      ]),
    );
  });
  it("leaves preferred mail unknown: the plan does not offer it", () => {
    expect(
      pay(
        fillOf({
          plan: G,
          tier: 3,
          days: 30,
          price: "100.00",
          channel: "preferred_mail",
        }),
      ),
    ).toBe("unknown:channel_not_offered");
  });
  it("charges $0 in the catastrophic phase", () => {
    expect(
      pay(
        fillOf({
          plan: G,
          tier: 3,
          days: 30,
          price: "100.00",
          opening: { ...atThreshold, plan_deductible_met_cents: 0 },
        }),
      ),
    ).toBe(0);
  });
});

describe("H0251-004, 2026: defined standard SNP with LIS copay pairs", () => {
  it("is a defined standard dual-eligible SNP whose bounds are the Table V-2 copays", () => {
    expect(benefitOf(LIS)).toBe("DS");
    const bundle = planBundle(LIS, 1);
    if (bundle.status !== "available") throw new Error("unreachable");
    expect(bundle.special_needs_plan).toMatchObject({ code: "2", snp: true });
    const rules = boundRules(2026)!;
    const pairs = new Set<string>();
    for (const tier of bundle.tiers)
      for (const cell of tier.channels) {
        const found = classifyBounds(
          cell,
          { defined_standard: true, special_needs_plan: true },
          rules,
        );
        if (found.class !== "none" && found.class !== "not_offered") {
          expect(found.class).toBe("lis_range");
          pairs.add(`${tier.phase}:${cell.minimum.raw}-${cell.maximum.raw}`);
        }
      }
    expect([...pairs].sort()).toEqual([
      "initial_coverage:1.6-5.1",
      "initial_coverage:4.9-12.65",
    ]);
  });
  it("prices someone without the subsidy at the defined standard 25%, not the filed $0", () => {
    const f = fillOf({
      plan: LIS,
      tier: 1,
      days: 30,
      price: "100.00",
      opening: deductibleMet,
    });
    expect(pay(f)).toBe(2500);
    expect(
      pay(
        fillOf({
          plan: LIS,
          tier: 2,
          days: 90,
          price: "200.00",
          opening: deductibleMet,
        }),
      ),
    ).toBe(5000);
    expect(f.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "rule", document: "C5", page: 95 }),
        expect.objectContaining({ kind: "rule", document: "C13", row: 25379 }),
        expect.objectContaining({
          kind: "source_row",
          table: "plan",
          fields: ["SNP"],
        }),
      ]),
    );
  });
  it("applies the deductible first and $0 in the catastrophic phase", () => {
    expect(pay(fillOf({ plan: LIS, tier: 1, days: 30, price: "100.00" }))).toBe(
      10000,
    );
    expect(
      pay(
        fillOf({
          plan: LIS,
          tier: 1,
          days: 30,
          price: "100.00",
          opening: atThreshold,
        }),
      ),
    ).toBe(0);
  });
  it("stays unknown when the benefit type is not known", () => {
    expect(
      pay(
        fillOf({
          plan: LIS,
          tier: 1,
          days: 30,
          price: "100.00",
          opening: deductibleMet,
          benefit: "unknown",
        }),
      ),
      // Read as enhanced alternative the same cells are unrecognised, so both reasons show.
    ).toBe("unknown:benefit_type_unknown+bound_class_unrecognised");
  });
});

// ---------- planted mutants ----------

/** Checks a correct engine passes; each mutant below must fail at least one. */
function failingChecks(bounds: BoundDeps): string[] {
  const deps: EngineDeps = { ...engineDeps, bounds };
  const failures: string[] = [];
  const expectPay = (name: string, c: Case, cents: number) => {
    if (pay(fillOf(c, deps)) !== cents) failures.push(name);
  };
  expectPay(
    "greater_of:30",
    { plan: G, tier: 3, days: 30, price: "100.00" },
    4700,
  );
  expectPay(
    "greater_of:60",
    { plan: G, tier: 3, days: 60, price: "400.00" },
    9400,
  );
  expectPay(
    "greater_of:90",
    { plan: G, tier: 3, days: 90, price: "500.00" },
    14100,
  );
  expectPay(
    "lis:no_subsidy",
    { plan: LIS, tier: 1, days: 30, price: "100.00", opening: deductibleMet },
    2500,
  );
  expectPay(
    "lis:deductible",
    { plan: LIS, tier: 1, days: 30, price: "100.00" },
    10000,
  );
  return failures;
}

describe("planted mutants in the bound rules", () => {
  it("the real rules pass every check", () => {
    expect(failingChecks(boundDeps)).toEqual([]);
  });
  it("catches a zero read as a $0 bound", () => {
    const failures = failingChecks({
      ...boundDeps,
      amount: (bound) =>
        bound.status === "value" ? rational(BigInt(bound.cents), 100n) : null,
    });
    // Every greater-of cell files a zero maximum; the LIS pairs file no zero.
    expect(failures).toEqual([
      "greater_of:30",
      "greater_of:60",
      "greater_of:90",
    ]);
  });
  it("catches a no-subsidy charge clamped to the LIS range", () => {
    const failures = failingChecks({
      ...boundDeps,
      lisSharing: (standard, cell) => ({
        kind: "bounded",
        inner: standard,
        minimum: boundDeps.amount(cell.minimum),
        maximum: boundDeps.amount(cell.maximum),
      }),
    });
    expect(failures).toEqual(["lis:no_subsidy"]);
  });
  it("catches a minimum prorated by days supply", () => {
    const failures = failingChecks({
      ...boundDeps,
      fillMinimum: (minimum, days) =>
        mul(minimum, div(rational(BigInt(days)), rational(30n))),
    });
    expect(failures).toEqual(["greater_of:60", "greater_of:90"]);
  });
  it("a zero minimum is never a floor", () => {
    expect(
      boundDeps.amount({ status: "value", cents: 0, raw: "0" }),
    ).toBeNull();
  });
});
