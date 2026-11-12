// Part D phase arithmetic. Expected figures for the CMS worked examples come from
// tests/fixtures/medicare-costs/oracles.json, transcribed by hand from the pinned documents. Every
// other price and benefit below is synthetic and labelled so.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type {
  ClaimDeps,
  ClaimInput,
  ClaimParameters,
  Sharing,
} from "../../src/domain/medicare/part-d-cost/claim.js";
import {
  claimDeps,
  createClaimCalculator,
  priceClaim,
} from "../../src/domain/medicare/part-d-cost/claim.js";
import type { Rational } from "../../src/domain/medicare/part-d-cost/decimal.js";
import {
  add,
  cmp,
  formatCents,
  formatDecimal,
  fromBasisPoints,
  max,
  sub,
  fromCents,
  parseDecimal,
  roundHalfUpCents,
} from "../../src/domain/medicare/part-d-cost/decimal.js";
import type {
  BenefitType,
  EngineDeps,
  EstimateRequest,
  EstimateResult,
  FillRequest,
  FillResult,
  PriceEvidence,
} from "../../src/domain/medicare/part-d-cost/engine.js";
import {
  createEstimator,
  engineDeps,
  estimateDrugCosts,
} from "../../src/domain/medicare/part-d-cost/engine.js";
import type { DrugProgram } from "../../src/domain/medicare/part-d-cost/program-rules.js";
import { programRules } from "../../src/domain/medicare/part-d-cost/program-rules.js";
import type {
  BenefitBundle,
  ChannelCost,
  Conflict,
  InsulinCost,
  MoneyFigure,
  RowRef,
  TierCost,
} from "../../src/domain/medicare/part-d-cost/repository.js";
import {
  decodeBound,
  yearRules,
} from "../../src/domain/medicare/part-d-cost/repository.js";
import { spufChannels } from "../../src/ingest/medicare/spuf.js";

const d = (text: string): Rational => {
  const value = parseDecimal(text);
  if (!value) throw new Error(`bad decimal ${text}`);
  return value;
};
const dollars = (cents: number) => formatCents(BigInt(cents));

interface Oracle {
  id: string;
  document: string;
  contractYear: number;
  inputs: Record<string, string>;
  expected: Record<string, string>;
}
const oracleFile = JSON.parse(
  readFileSync(
    new URL("../fixtures/medicare-costs/oracles.json", import.meta.url),
    "utf8",
  ),
) as { workedExamples: Oracle[] };

// ---------- synthetic bundles ----------

let rowCounter = 0;
const ref = (table: RowRef["table"]): RowRef => ({
  snapshot_id: "synthetic",
  table,
  source_row: ++rowCounter,
  fields: [],
});
const money = (cents: number): MoneyFigure => ({
  status: "value",
  cents,
  raw: formatCents(BigInt(cents)),
});
const notReported: MoneyFigure = { status: "not_reported", raw: "" };

interface CellSpec {
  type: "copay" | "coinsurance" | "not_offered";
  amount?: string;
  min?: string;
  max?: string;
}
function cell(spec: CellSpec): Omit<ChannelCost, "channel"> {
  const bound = (value: string | undefined) =>
    value === undefined ? notReported : decodeBound(value);
  if (spec.type === "not_offered")
    return {
      status: "not_offered",
      amount: null,
      minimum: bound(spec.min),
      maximum: bound(spec.max),
      reason: null,
    };
  const amount =
    spec.type === "copay"
      ? money(Number(roundHalfUpCents(d(spec.amount!))))
      : {
          status: "value" as const,
          rate: spec.amount!,
          basis_points: Number(roundHalfUpCents(d(spec.amount!))) * 100,
          raw: spec.amount!,
        };
  return {
    status: spec.type,
    amount,
    minimum: bound(spec.min),
    maximum: bound(spec.max),
    reason: null,
  };
}
function tierRow(
  tier: number,
  phase: TierCost["phase"],
  spec: CellSpec,
  options: { supply?: TierCost["supply"]; deductible?: boolean } = {},
): TierCost {
  return {
    tier,
    phase,
    supply: options.supply ?? "30_days",
    specialty_tier: false,
    deductible_applies: options.deductible ?? true,
    channels: spufChannels.map((channel) => ({
      channel: channel.channel,
      ...cell(spec),
    })),
    evidence: [ref("beneficiary_cost")],
  };
}
function insulinRow(
  tier: number | null,
  copay: string,
  coinsurance: string,
): InsulinCost {
  return {
    tier,
    supply: "30_days",
    channels: spufChannels.map((channel) => ({
      channel: channel.channel,
      status: "filed" as const,
      copay: copay ? money(Number(roundHalfUpCents(d(copay)))) : notReported,
      coinsurance: coinsurance
        ? {
            status: "value" as const,
            rate: coinsurance,
            basis_points: Number(roundHalfUpCents(d(coinsurance))) * 100,
            raw: coinsurance,
          }
        : { status: "not_reported" as const, raw: "" as const },
      reason: null,
      derived_from: [],
    })),
    evidence: [ref("insulin_cost")],
  };
}
interface DrugSpec {
  rxcui: string;
  tier: number;
  selected?: boolean | "unknown";
  status?: "listed" | "not_listed";
  ndcs?: string[];
}
const productOf = (listed: boolean, count: number) => {
  if (!listed) return "none" as const;
  return count > 1 ? ("ambiguous" as const) : ("single" as const);
};
function bundle(spec: {
  year?: number;
  deductibleCents?: number | null;
  tiers: TierCost[];
  insulin?: InsulinCost[];
  drugs: DrugSpec[];
  conflicts?: Conflict[];
  snp?: "0" | "1" | "2" | "3";
}): BenefitBundle {
  const year = spec.year ?? 2026;
  return {
    status: "available",
    bundle_version: "1",
    plan_key: "H9000-001-000",
    contract_year: year,
    release: {
      snapshot_id: "synthetic",
      kind: "synthetic",
      contract_year: year,
      as_of: `${year}-01-01`,
      sha256: "0".repeat(64),
      url: "synthetic",
    },
    formulary_id: "00000001",
    deductible:
      spec.deductibleCents === null
        ? notReported
        : money(spec.deductibleCents ?? 61500),
    deductible_evidence: [ref("plan")],
    special_needs_plan: {
      status: "value",
      code: spec.snp ?? "0",
      snp: (spec.snp ?? "0") !== "0",
      evidence: [{ ...ref("plan"), fields: ["SNP"] }],
    },
    tiers: spec.tiers,
    insulin: spec.insulin ?? [],
    drugs: spec.drugs.map((drug) => {
      const ndcs = drug.ndcs ?? ["00000000001"];
      const listed = (drug.status ?? "listed") === "listed";
      return {
        rxcui: drug.rxcui,
        status: listed ? "listed" : "not_listed",
        reason: listed && ndcs.length > 1 ? "ambiguous_drug_product" : null,
        product: productOf(listed, ndcs.length),
        packages: listed
          ? ndcs.map((ndc) => ({
              proxy_ndc: ndc,
              tier: drug.tier,
              prior_authorization: false,
              step_therapy: false,
              quantity_limit: false,
              quantity_limit_amount: null,
              quantity_limit_days: null,
              selected_drug: drug.selected ?? false,
              formulary_version: "1",
              evidence: ref("formulary"),
            }))
          : [],
        supplemental: [],
        indications: [],
      };
    }),
    rules: yearRules(year),
    conflicts: spec.conflicts ?? [],
    gaps: [],
  };
}
function fill(
  id: string,
  date: string,
  options: Partial<FillRequest> & {
    program?: DrugProgram | "unknown";
    insulin?: boolean | "unknown";
    vaccine?: boolean | "unknown";
  } = {},
): FillRequest {
  return {
    fill_id: id,
    date,
    rxcui: options.rxcui ?? "1000",
    days_supply: options.days_supply ?? 30,
    quantity: "30",
    unit: "tablet",
    classification: {
      insulin: options.insulin ?? false,
      acip_vaccine: options.vaccine ?? false,
      program: options.program ?? "not_applicable",
    },
    ...(options.proxy_ndc ? { proxy_ndc: options.proxy_ndc } : {}),
  };
}
const synthetic = (amount: string): PriceEvidence => ({
  status: "value",
  amount,
  basis: "synthetic",
  reference: "synthetic test price",
});
function request(
  plan: BenefitBundle,
  fills: FillRequest[],
  prices: Record<string, PriceEvidence>,
  extra: Partial<EstimateRequest> = {},
): EstimateRequest {
  return {
    contract_year: plan.contract_year,
    scenario: "non_lis_no_other_payer",
    benefit_type: "DS",
    bundle: plan,
    channel: "preferred_retail",
    opening: { kind: "new_calendar_year" },
    fills,
    prices,
    ...extra,
  };
}
type Available = Extract<EstimateResult, { fills: FillResult[] }>;
function run(
  input: EstimateRequest,
  estimate: (input: EstimateRequest) => EstimateResult = estimateDrugCosts,
): Available {
  const result = estimate(input);
  if (!("fills" in result))
    throw new Error(`no fills: ${JSON.stringify(result)}`);
  return result;
}
const cents = (figure: FillResult["patient_pay"]) =>
  figure.status === "value" ? figure.cents : `unknown:${figure.reason}`;

/** A defined standard plan, tier 1 with 25% coinsurance and the deductible applying. */
const dsPlan = (year = 2026) =>
  bundle({
    year,
    deductibleCents: year === 2026 ? 61500 : 70000,
    tiers: [
      tierRow(1, "initial_coverage", { type: "coinsurance", amount: "0.25" }),
      tierRow(1, "catastrophic", { type: "copay", amount: "0" }),
    ],
    drugs: [{ rxcui: "1000", tier: 1 }],
  });

// ---------- CMS worked examples ----------

const design: Record<
  string,
  { design: ClaimInput["design"]; program: DrugProgram; benefit: BenefitType }
> = {
  "ds-deductible-crossing": {
    design: "basic",
    program: "selected",
    benefit: "DS",
  },
  "selected-drug-copay-ceiling": {
    design: "basic",
    program: "selected",
    benefit: "BA",
  },
  "ds-catastrophic-crossing": {
    design: "basic",
    program: "selected",
    benefit: "DS",
  },
  "ea-mapping-crossing": {
    design: "enhanced_alternative",
    program: "selected",
    benefit: "EA",
  },
  // C7 section 3: "a Basic Plan or an EA Plan", so the engine is given an unknown type.
  "insulin-lesser-of": {
    design: "basic",
    program: "applicable",
    benefit: "unknown",
  },
  "insulin-catastrophic-crossing": {
    design: "basic",
    program: "applicable",
    benefit: "unknown",
  },
  "selected-insulin-mfp-ceiling": {
    design: "basic",
    program: "selected",
    benefit: "unknown",
  },
};

function claimParams(deps: EngineDeps, year: number): ClaimParameters {
  const rules = deps.rules(year);
  const program = deps.program(year)!;
  if (rules.status !== "value") throw new Error("rules");
  return {
    standardDeductible: fromCents(rules.standard_deductible.cents!),
    outOfPocketThreshold: fromCents(rules.out_of_pocket_threshold.cents!),
    standardInitialShare: fromBasisPoints(
      rules.initial_coverage_cost_sharing.basis_points!,
    ),
    insulinCopayCap: program.insulin.copay_cap,
    insulinPriceShareCap: program.insulin.price_share_cap,
  };
}

function oracleClaim(oracle: Oracle, deps: EngineDeps): ClaimInput {
  const input = oracle.inputs;
  const setup = design[oracle.id]!;
  const params = claimParams(deps, oracle.contractYear);
  const troop = d(input.openingTroop!);
  const insulin = "insulinCopay" in input || "planCopay" in input;
  let sharing: Sharing;
  if (insulin)
    sharing = {
      kind: "lesser_of",
      copay: d(input.insulinCopay ?? input.planCopay!),
      rate: d(input.insulinCoinsurance ?? input.planCoinsurance!),
    };
  else if (input.filedCopay)
    sharing = { kind: "copay", amount: d(input.filedCopay) };
  else
    sharing = {
      kind: "coinsurance",
      rate: input.planInitialCoinsurance
        ? d(input.planInitialCoinsurance)
        : params.standardInitialShare,
    };
  // Defined standard plans use the standard deductible; their spending so far all went to it.
  let planDeductible = d("0");
  if (setup.benefit === "DS") planDeductible = params.standardDeductible;
  if (input.planDeductible) planDeductible = d(input.planDeductible);
  const remaining = max(d("0"), sub(planDeductible, troop));
  const cls = deps.program(oracle.contractYear)!.classes[setup.program];
  return {
    gross: d(input.grossDrugCost ?? input.negotiatedPrice!),
    troop,
    planDeductibleRemaining: remaining,
    design: setup.design,
    sharing,
    special: insulin ? "insulin" : "none",
    maximumFairPrice: input.maximumFairPrice ? d(input.maximumFairPrice) : null,
    program: {
      payer: cls.payer,
      initial: cls.initial[0],
      catastrophic: cls.catastrophic,
    },
    params,
  };
}

/** Compares every expected figure of an oracle; returns the mismatches. */
function oracleMismatches(oracle: Oracle, deps: EngineDeps): string[] {
  const result = createClaimCalculator(deps.claim)(oracleClaim(oracle, deps));
  if (result.status !== "value") return [`${oracle.id}: ${result.reason}`];
  const troopAfter =
    Number(roundHalfUpCents(d(oracle.inputs.openingTroop!))) +
    Number(result.troopDeltaCents);
  const actual: Record<string, string | null> = {
    patientPay: formatCents(result.patientCents),
    troopIncrement: formatCents(result.troopDeltaCents),
    closingTroop: dollars(troopAfter),
    grossBelowThreshold: formatCents(result.belowThresholdCents),
    grossAboveThreshold: formatCents(result.aboveThresholdCents),
    selectedDrugSubsidy:
      result.selectedDrugSubsidyCents === null
        ? null
        : formatCents(result.selectedDrugSubsidyCents),
    manufacturerDiscount:
      result.manufacturerDiscountCents === null
        ? null
        : formatCents(result.manufacturerDiscountCents),
    coveredPlanPaid:
      result.coveredPlanPaidCents === null
        ? null
        : formatCents(result.coveredPlanPaidCents),
    nonCoveredPlanPaid:
      result.nonCoveredPlanPaidCents === null
        ? null
        : formatCents(result.nonCoveredPlanPaidCents),
    beginningPhase: result.planPhase.begin,
    endingPhase: result.planPhase.end,
  };
  return Object.entries(oracle.expected).flatMap(([key, value]) => {
    if (!(key in actual)) return [`${oracle.id}.${key}: not computed`];
    return actual[key] === value
      ? []
      : [`${oracle.id}.${key}: expected ${value}, got ${actual[key]}`];
  });
}

/** The same oracle run end to end through the schedule engine with a synthetic plan bundle. */
function oracleEngine(
  oracle: Oracle,
  estimate: (input: EstimateRequest) => EstimateResult,
): string[] {
  const input = oracle.inputs;
  const setup = design[oracle.id]!;
  const year = oracle.contractYear;
  const insulin = "insulinCopay" in input || "planCopay" in input;
  const troop = Number(roundHalfUpCents(d(input.openingTroop!)));
  const gross = Number(roundHalfUpCents(d(input.openingGrossCoveredDrugCost!)));
  const ds = setup.benefit === "DS";
  const rules = yearRules(year);
  let deductibleCents = 0;
  if (ds && rules.status === "value")
    deductibleCents = rules.standard_deductible.cents!;
  if (input.planDeductible)
    deductibleCents = Number(roundHalfUpCents(d(input.planDeductible)));
  const met = Math.min(troop, deductibleCents);
  const icp: CellSpec = input.filedCopay
    ? { type: "copay", amount: input.filedCopay }
    : { type: "coinsurance", amount: input.planInitialCoinsurance ?? "0.25" };
  const plan = bundle({
    year,
    deductibleCents,
    tiers: [
      tierRow(1, "initial_coverage", icp, { deductible: deductibleCents > 0 }),
    ],
    insulin: insulin
      ? [
          insulinRow(
            1,
            input.insulinCopay ?? input.planCopay!,
            input.insulinCoinsurance ?? input.planCoinsurance!,
          ),
        ]
      : [],
    drugs: [{ rxcui: "2000", tier: 1, selected: setup.program === "selected" }],
  });
  const price: PriceEvidence = {
    status: "value",
    amount: input.grossDrugCost ?? input.negotiatedPrice!,
    basis: "cms_worked_example",
    reference: `${oracle.document} ${oracle.id}`,
    ...(input.maximumFairPrice
      ? { maximum_fair_price: input.maximumFairPrice }
      : {}),
  };
  const result = estimate(
    request(
      plan,
      [
        fill("f1", `${year}-06-01`, {
          rxcui: "2000",
          program: setup.program,
          insulin,
        }),
      ],
      { f1: price },
      {
        benefit_type: setup.benefit,
        opening:
          troop || gross
            ? {
                kind: "provided",
                as_of: `${year}-06-01`,
                gross_cents: gross,
                troop_cents: troop,
                plan_deductible_met_cents: met,
              }
            : { kind: "new_calendar_year" },
      },
    ),
  );
  if (!("fills" in result)) return [`${oracle.id}: engine ${result.status}`];
  const f = result.fills[0]!;
  const actual: Record<string, FillResult["patient_pay"]> = {
    patientPay: f.patient_pay,
    troopIncrement: f.troop_increment,
    grossBelowThreshold: f.gross_below_threshold,
    grossAboveThreshold: f.gross_above_threshold,
    selectedDrugSubsidy: f.selected_drug_subsidy,
    manufacturerDiscount: f.manufacturer_discount,
    coveredPlanPaid: f.covered_plan_paid,
    nonCoveredPlanPaid: f.non_covered_plan_paid,
    closingTroop: f.after.troop,
  };
  return Object.entries(oracle.expected).flatMap(([key, value]) => {
    if (key === "beginningPhase" || key === "endingPhase") {
      const phase = f.plan_phase?.[key === "beginningPhase" ? "begin" : "end"];
      return phase === value
        ? []
        : [`${oracle.id}.${key} (engine): expected ${value}, got ${phase}`];
    }
    const figure = actual[key];
    if (!figure) return [`${oracle.id}.${key} (engine): not computed`];
    const got =
      figure.status === "value"
        ? dollars(figure.cents)
        : `unknown:${figure.reason}`;
    return got === value
      ? []
      : [`${oracle.id}.${key} (engine): expected ${value}, got ${got}`];
  });
}

describe("CMS worked examples (oracles.json)", () => {
  it("covers every example in the fixture", () => {
    expect(oracleFile.workedExamples.map((item) => item.id).sort()).toEqual(
      Object.keys(design).sort(),
    );
  });
  for (const oracle of oracleFile.workedExamples) {
    it(`${oracle.document} ${oracle.id}: every expected figure, claim level`, () => {
      expect(oracleMismatches(oracle, engineDeps)).toEqual([]);
    });
    it(`${oracle.document} ${oracle.id}: patient pay, TrOOP and payer split, engine level`, () => {
      expect(oracleEngine(oracle, estimateDrugCosts)).toEqual([]);
    });
  }
});

describe("C11 method checks (CY 2025 parameters, internal profile only)", () => {
  // C11 publishes CY 2025 claims. They check the copay and enhanced-plan method only, with their
  // own 2025 parameters passed in explicitly; they are not 2026 or 2027 examples.
  const params2025: ClaimParameters = {
    standardDeductible: d("590"),
    outOfPocketThreshold: d("2000"),
    standardInitialShare: d("0.25"),
    insulinCopayCap: d("35"),
    insulinPriceShareCap: d("0.25"),
  };
  const applicable = {
    payer: "manufacturer_discount" as const,
    initial: d("0.10"),
    catastrophic: d("0.20"),
  };
  const base = {
    special: "none" as const,
    maximumFairPrice: null,
    program: applicable,
    params: params2025,
  };
  const cases: [string, ClaimInput, Record<string, string>][] = [
    [
      "example 1, EA deductible to catastrophic",
      {
        ...base,
        gross: d("7200"),
        troop: d("100"),
        planDeductibleRemaining: d("200"),
        design: "enhanced_alternative",
        sharing: { kind: "coinsurance", rate: d("0.20") },
      },
      {
        below: "6130.00",
        patient: "1386.00",
        discount: "778.00",
        cpp: "4522.00",
        npp: "514.00",
        troop: "1900.00",
      },
    ],
    [
      "example 2, EA with no plan deductible",
      {
        ...base,
        gross: d("12000"),
        troop: d("40"),
        planDeductibleRemaining: d("0"),
        design: "enhanced_alternative",
        sharing: { kind: "coinsurance", rate: d("0.20") },
      },
      {
        below: "6190.00",
        patient: "1238.00",
        discount: "1726.00",
        cpp: "8314.00",
        troop: "1960.00",
      },
    ],
    [
      "example 5, copay in initial coverage is charged once",
      {
        ...base,
        gross: d("7600"),
        troop: d("100"),
        planDeductibleRemaining: d("200"),
        design: "enhanced_alternative",
        sharing: { kind: "copay", amount: d("250") },
      },
      {
        below: "6130.00",
        patient: "450.00",
        discount: "858.00",
        cpp: "4842.00",
        npp: "1450.00",
        troop: "1900.00",
      },
    ],
    [
      "example 8, BA tier without deductible crossing the standard deductible",
      {
        ...base,
        gross: d("100"),
        troop: d("580"),
        planDeductibleRemaining: d("0"),
        design: "basic",
        sharing: { kind: "coinsurance", rate: d("0.20") },
      },
      {
        below: "100.00",
        patient: "20.00",
        discount: "9.00",
        cpp: "71.00",
        troop: "20.00",
      },
    ],
  ];
  for (const [name, input, expected] of cases)
    it(name, () => {
      const result = priceClaim(input);
      if (result.status !== "value") throw new Error(result.reason);
      const got: Record<string, string> = {
        below: formatCents(result.belowThresholdCents),
        patient: formatCents(result.patientCents),
        discount: formatCents(result.manufacturerDiscountCents!),
        cpp: formatCents(result.coveredPlanPaidCents!),
        npp: formatCents(result.nonCoveredPlanPaidCents!),
        troop: formatCents(result.troopDeltaCents),
      };
      for (const [key, value] of Object.entries(expected))
        expect(`${key} ${got[key]}`).toBe(`${key} ${value}`);
    });
});

// ---------- exact arithmetic ----------

describe("exact decimal arithmetic", () => {
  it("rounds half up on exact values that binary floating point gets wrong", () => {
    // 4.02 * 0.25 = 1.005 exactly; in floating point 1.005 * 100 is 100.49999..., which rounds down.
    expect(roundHalfUpCents({ n: 201n, d: 200n })).toBe(101n);
    expect(Math.round(1.005 * 100)).toBe(100);
    expect(formatDecimal(d("0.1"))).toBe("0.1");
    expect(formatCents(roundHalfUpCents(d("285.714285")))).toBe("285.71");
    expect(parseDecimal("1e3")).toBeNull();
    expect(parseDecimal(".25")).toBeNull();
  });
  it("prices a synthetic 25% fill of $4.02 at $1.01", () => {
    const result = run(
      request(
        dsPlan(),
        [fill("f1", "2026-03-01")],
        { f1: synthetic("4.02") },
        {
          opening: {
            kind: "provided",
            as_of: "2026-01-01",
            gross_cents: 100000,
            troop_cents: 61500,
            plan_deductible_met_cents: 61500,
          },
        },
      ),
    );
    expect(cents(result.fills[0]!.patient_pay)).toBe(101);
  });
});

// ---------- schedules (synthetic) ----------

describe("defined standard schedule, synthetic prices", () => {
  it("walks deductible, initial coverage and catastrophe in 2026", () => {
    const fills = [
      fill("a", "2026-01-05"),
      fill("b", "2026-02-05"),
      fill("c", "2026-03-05"),
      fill("d", "2026-04-05"),
    ];
    const prices = {
      a: synthetic("500.00"),
      b: synthetic("1000.00"),
      c: synthetic("6000.00"),
      d: synthetic("300.00"),
    };
    const result = run(request(dsPlan(), fills, prices));
    expect(result.status).toBe("estimated");
    // a: all deductible. b: $115 deductible + 25% of $885. c: crosses $2,100. d: catastrophic.
    expect(result.fills.map((item) => cents(item.patient_pay))).toEqual([
      50000,
      11500 + 22125,
      210000 - 83625,
      0,
    ]);
    expect(result.fills.map((item) => item.plan_phase)).toEqual([
      { begin: "D", end: "D" },
      { begin: "D", end: "N" },
      { begin: "N", end: "C" },
      { begin: "C", end: "C" },
    ]);
    expect(result.totals.patient_pay).toEqual({
      status: "value",
      cents: 210000,
    });
    expect(result.totals.closing.troop).toEqual({
      status: "value",
      cents: 210000,
    });
    const c = result.fills[2]!;
    expect(
      c.gross_below_threshold.cents! + c.gross_above_threshold.cents!,
    ).toBe(600000);
    expect(c.conflicts).toEqual([]);
  });
  it("uses the 2027 deductible and threshold for a 2027 schedule", () => {
    const fills = [fill("a", "2027-01-05"), fill("b", "2027-02-05")];
    const result = run(
      request(dsPlan(2027), fills, {
        a: synthetic("800.00"),
        b: synthetic("10000.00"),
      }),
    );
    // $700 deductible + 25% of $100, then the rest of the $2,400 threshold.
    expect(result.fills.map((item) => cents(item.patient_pay))).toEqual([
      72500,
      240000 - 72500,
    ]);
    expect(result.fills[1]!.plan_phase).toEqual({ begin: "N", end: "C" });
  });
  it("is byte-stable for a fixed input", () => {
    const input = request(dsPlan(), [fill("a", "2026-01-05")], {
      a: synthetic("812.34"),
    });
    expect(JSON.stringify(estimateDrugCosts(input))).toBe(
      JSON.stringify(estimateDrugCosts(input)),
    );
  });
});

describe("split fills", () => {
  it("charges the copay once when a fill straddles the plan deductible", () => {
    const plan = bundle({
      deductibleCents: 30000,
      tiers: [tierRow(3, "initial_coverage", { type: "copay", amount: "40" })],
      drugs: [{ rxcui: "1000", tier: 3 }],
    });
    const result = run(
      request(
        plan,
        [fill("a", "2026-01-05")],
        { a: synthetic("500.00") },
        { benefit_type: "BA" },
      ),
    );
    expect(cents(result.fills[0]!.patient_pay)).toBe(30000 + 4000);
    expect(result.fills[0]!.after.plan_deductible_met).toEqual({
      status: "value",
      cents: 30000,
    });
  });
  it("caps a copay at the drug cost", () => {
    const plan = bundle({
      deductibleCents: 0,
      tiers: [
        tierRow(
          1,
          "initial_coverage",
          { type: "copay", amount: "15" },
          { deductible: false },
        ),
      ],
      drugs: [{ rxcui: "1000", tier: 1 }],
    });
    const result = run(
      request(
        plan,
        [fill("a", "2026-01-05")],
        { a: synthetic("9.99") },
        { benefit_type: "BA" },
      ),
    );
    expect(cents(result.fills[0]!.patient_pay)).toBe(999);
  });
  it("deems the plan deductible met once TrOOP meets the standard deductible", () => {
    // Tier 1 waives a $500 plan deductible; tier 2 does not. TrOOP from tier 1 reaches $615 first.
    const plan = bundle({
      deductibleCents: 50000,
      tiers: [
        tierRow(
          1,
          "pre_deductible",
          { type: "coinsurance", amount: "0.25" },
          { deductible: false },
        ),
        tierRow(
          1,
          "initial_coverage",
          { type: "coinsurance", amount: "0.25" },
          { deductible: false },
        ),
        tierRow(2, "initial_coverage", { type: "coinsurance", amount: "0.25" }),
      ],
      drugs: [
        { rxcui: "1000", tier: 1 },
        { rxcui: "1001", tier: 2 },
      ],
    });
    const result = run(
      request(
        plan,
        [fill("a", "2026-01-05"), fill("b", "2026-02-05", { rxcui: "1001" })],
        {
          a: synthetic("2600.00"),
          b: synthetic("100.00"),
        },
        { benefit_type: "BA" },
      ),
    );
    expect(cents(result.fills[0]!.patient_pay)).toBe(65000);
    expect(result.fills[0]!.after.plan_deductible_met).toEqual({
      status: "value",
      cents: 50000,
    });
    // No deductible left for tier 2: 25%, not 100%.
    expect(cents(result.fills[1]!.patient_pay)).toBe(2500);
  });
  it("leaves a waived tier unknown when its pre-deductible and initial rows differ across the split", () => {
    const plan = bundle({
      deductibleCents: 50000,
      tiers: [
        tierRow(
          1,
          "pre_deductible",
          { type: "coinsurance", amount: "0.50" },
          { deductible: false },
        ),
        tierRow(
          1,
          "initial_coverage",
          { type: "coinsurance", amount: "0.25" },
          { deductible: false },
        ),
      ],
      drugs: [{ rxcui: "1000", tier: 1 }],
    });
    const result = run(
      request(
        plan,
        [fill("a", "2026-01-05")],
        { a: synthetic("2000.00") },
        { benefit_type: "BA" },
      ),
    );
    expect(cents(result.fills[0]!.patient_pay)).toBe(
      "unknown:pre_deductible_split_unresolved",
    );
  });
});

describe("catastrophic cost sharing filed against the rules", () => {
  const plan = bundle({
    tiers: [
      tierRow(5, "initial_coverage", { type: "coinsurance", amount: "0.25" }),
      tierRow(5, "catastrophic", { type: "copay", amount: "10" }),
    ],
    drugs: [{ rxcui: "1000", tier: 5 }],
    conflicts: [
      {
        code: "catastrophic_cost_sharing_conflicts_with_rules",
        detail:
          "tier 5, 30_days: the year's rules set no catastrophic cost sharing",
        evidence: [ref("beneficiary_cost")],
      },
    ],
  });
  const opening = {
    kind: "provided" as const,
    as_of: "2026-01-01",
    gross_cents: 900000,
    troop_cents: 210000,
    plan_deductible_met_cents: 61500,
  };
  it("charges $0, flags the conflict and keeps the filed $10 visible", () => {
    const result = run(
      request(
        plan,
        [fill("a", "2026-05-01")],
        { a: synthetic("400.00") },
        { opening },
      ),
    );
    const f = result.fills[0]!;
    expect(cents(f.patient_pay)).toBe(0);
    const notes = f.conflicts.map((note) => [
      note.code,
      note.applied,
      note.filed.map((item) => item.raw),
    ]);
    expect(notes).toHaveLength(2);
    expect(notes).toEqual(
      expect.arrayContaining([
        ["catastrophic_cost_sharing_conflicts_with_rules", "0", []],
        [
          "catastrophic_cost_sharing_conflicts_with_rules",
          "0",
          ["10.00", "10.00", "10.00", "10.00"],
        ],
      ]),
    );
    expect(result.conflicts).toHaveLength(1);
  });
  it("shows the amount the reader set aside when the row itself is gone", () => {
    const readerOnly = bundle({
      tiers: [
        tierRow(5, "initial_coverage", { type: "coinsurance", amount: "0.25" }),
      ],
      drugs: [{ rxcui: "1000", tier: 5 }],
      conflicts: [
        {
          code: "catastrophic_cost_sharing_conflicts_with_rules",
          detail:
            "tier 5, 30_days: the year's rules set no catastrophic cost sharing",
          evidence: [ref("beneficiary_cost")],
          filed: [{ channel: "preferred_retail", raw: "10" }],
        },
      ],
    });
    const result = run(
      request(
        readerOnly,
        [fill("a", "2026-05-01")],
        { a: synthetic("400.00") },
        { opening },
      ),
    );
    const f = result.fills[0]!;
    expect(cents(f.patient_pay)).toBe(0);
    expect(f.conflicts.map((note) => [note.applied, note.filed])).toEqual([
      ["0", [{ channel: "preferred_retail", raw: "10" }]],
    ]);
    expect(result.conflicts[0]!.filed).toEqual([
      { channel: "preferred_retail", raw: "10" },
    ]);
  });
  it("charges $0 above the threshold even without a price", () => {
    const result = run(
      request(plan, [fill("a", "2026-05-01")], {}, { opening }),
    );
    const f = result.fills[0]!;
    expect(cents(f.patient_pay)).toBe(0);
    expect(f.after.gross_covered_drug_cost.status).toBe("unknown");
    expect(f.after.troop).toEqual({ status: "value", cents: 210000 });
  });
});

describe("filed minimum and maximum cost sharing", () => {
  // Rules R0-R5 in src/domain/medicare/part-d-cost/bounds.ts. Every price below is synthetic.
  const planWith = (spec: CellSpec, snp: "0" | "2" = "0") =>
    bundle({
      deductibleCents: 0,
      tiers: [tierRow(1, "initial_coverage", spec, { deductible: false })],
      drugs: [{ rxcui: "1000", tier: 1 }],
      snp,
    });
  const one = (
    spec: CellSpec,
    price = "80.00",
    benefit: BenefitType = "BA",
    snp: "0" | "2" = "0",
  ) =>
    run(
      request(
        planWith(spec, snp),
        [fill("a", "2026-01-05")],
        { a: synthetic(price) },
        { benefit_type: benefit },
      ),
    ).fills[0]!;
  const ruleRows = (f: FillResult) =>
    f.evidence
      .flatMap((item) =>
        item.kind === "rule" && item.row !== undefined
          ? [`${item.document}:${item.row}`]
          : [],
      )
      .sort();
  it("R1: zero minimum and maximum, or none filed, is no bound", () => {
    expect(
      cents(one({ type: "coinsurance", amount: "0.25" }).patient_pay),
    ).toBe(2000);
    const zero = one({
      type: "coinsurance",
      amount: "0.25",
      min: "0",
      max: "0",
    });
    expect(cents(zero.patient_pay)).toBe(2000);
    expect(ruleRows(zero)).toEqual([]);
    expect(
      cents(
        one({ type: "copay", amount: "10", min: "0", max: "0" }).patient_pay,
      ),
    ).toBe(1000);
  });
  it("R0: a channel that is not offered ignores its bounds", () => {
    expect(
      cents(one({ type: "not_offered", min: "47", max: "0" }).patient_pay),
    ).toBe("unknown:channel_not_offered");
  });
  it("R2: greater of coinsurance and the minimum, on a plan that is not defined standard", () => {
    const spec = {
      type: "coinsurance",
      amount: "0.2",
      min: "47",
      max: "0",
    } as const;
    expect(cents(one(spec, "100.00").patient_pay)).toBe(4700);
    expect(cents(one(spec, "300.00").patient_pay)).toBe(6000);
    // The existing cap holds: never more than the claim.
    expect(cents(one(spec, "30.00").patient_pay)).toBe(3000);
    const f = one(spec, "100.00", "EA");
    expect(cents(f.patient_pay)).toBe(4700);
    expect(ruleRows(f)).toEqual(["C13:25379", "C13:25630"]);
    expect(f.status).toBe("estimated");
  });
  it("R2 does not apply to a defined standard plan or a copay", () => {
    const spec = {
      type: "coinsurance",
      amount: "0.2",
      min: "47",
      max: "0",
    } as const;
    expect(cents(one(spec, "100.00", "DS").patient_pay)).toBe(
      "unknown:bound_class_unrecognised",
    );
    expect(
      cents(
        one({ type: "copay", amount: "10", min: "47", max: "0" }).patient_pay,
      ),
    ).toBe("unknown:bound_class_unrecognised");
  });
  it("R3: a maximum alone is lesser-of, unknown until a plan files one", () => {
    const f = one({
      type: "coinsurance",
      amount: "0.25",
      min: "0",
      max: "100",
    });
    expect(cents(f.patient_pay)).toBe("unknown:bound_class_unrecognised");
    expect(ruleRows(f)).toEqual(["C13:25631"]);
  });
  it("R5: other combinations are unknown", () => {
    expect(
      cents(
        one({ type: "coinsurance", amount: "0.25", min: "30", max: "100" })
          .patient_pay,
      ),
    ).toBe("unknown:bound_class_unrecognised");
    // LIS-shaped bounds on a plan that is not a defined standard SNP.
    expect(
      cents(
        one(
          { type: "copay", amount: "0", min: "1.6", max: "5.1" },
          "80.00",
          "DS",
        ).patient_pay,
      ),
    ).toBe("unknown:bound_class_unrecognised");
    // A DS SNP whose bounds are not the year's LIS copays.
    expect(
      cents(
        one(
          { type: "copay", amount: "0", min: "1.6", max: "5.2" },
          "80.00",
          "DS",
          "2",
        ).patient_pay,
      ),
    ).toBe("unknown:bound_class_unrecognised");
  });
  it("R4: on a defined standard SNP the bounds are the LIS range, never a clamp", () => {
    const f = one(
      { type: "copay", amount: "0", min: "1.6", max: "5.1" },
      "100.00",
      "DS",
      "2",
    );
    expect(cents(f.patient_pay)).toBe(2500);
    expect(ruleRows(f)).toEqual(["C13:25379"]);
    expect(
      f.evidence.some(
        (item) =>
          item.kind === "rule" && item.document === "C5" && item.page === 95,
      ),
    ).toBe(true);
    expect(
      f.evidence.some(
        (item) => item.kind === "source_row" && item.fields.includes("SNP"),
      ),
    ).toBe(true);
    expect(
      cents(
        one(
          { type: "coinsurance", amount: "0.25", min: "0", max: "12.65" },
          "100.00",
          "DS",
          "2",
        ).patient_pay,
      ),
    ).toBe(2500);
  });
  it("R4 in the pre-deductible row has no no-subsidy charge", () => {
    const plan = bundle({
      deductibleCents: 61500,
      tiers: [
        tierRow(
          1,
          "pre_deductible",
          { type: "copay", amount: "0", min: "1.6", max: "5.1" },
          { deductible: false },
        ),
        tierRow(
          1,
          "initial_coverage",
          { type: "coinsurance", amount: "0.25" },
          { deductible: false },
        ),
      ],
      drugs: [{ rxcui: "1000", tier: 1 }],
      snp: "2",
    });
    const f = run(
      request(plan, [fill("a", "2026-01-05")], { a: synthetic("100.00") }),
    ).fills[0]!;
    expect(cents(f.patient_pay)).toBe(
      "unknown:lis_range_not_no_subsidy_charge",
    );
  });
  it("needs the benefit type and SNP status before reading a bound", () => {
    const lis = { type: "copay", amount: "0", min: "1.6", max: "5.1" } as const;
    expect(cents(one(lis, "100.00", "unknown", "2").patient_pay)).toBe(
      "unknown:benefit_type_unknown+bound_class_unrecognised",
    );
    const plan = planWith(lis, "2");
    if (plan.status !== "available") throw new Error("unreachable");
    plan.special_needs_plan = {
      status: "unknown",
      raw: "",
      reason: "snp_not_reported",
      evidence: [],
    };
    const f = run(
      request(plan, [fill("a", "2026-01-05")], { a: synthetic("100.00") }),
    ).fills[0]!;
    expect(cents(f.patient_pay)).toBe("unknown:special_needs_plan_unknown");
    // Zero bounds do not need either fact.
    expect(
      cents(
        one(
          { type: "coinsurance", amount: "0.25", min: "0", max: "0" },
          "80.00",
          "unknown",
        ).patient_pay,
      ),
    ).toBe(2000);
  });
  it("lists the pinned archive behind a dictionary citation", () => {
    const result = run(
      request(
        planWith({ type: "coinsurance", amount: "0.2", min: "47", max: "0" }),
        [fill("a", "2026-01-05")],
        { a: synthetic("100.00") },
        { benefit_type: "EA" },
      ),
    );
    expect(result.rules_documents.map((doc) => doc.id)).toContain("C13");
    expect(
      run(
        request(dsPlan(), [fill("a", "2026-01-05")], { a: synthetic("1.00") }),
      ).rules_documents.map((doc) => doc.id),
    ).not.toContain("C13");
  });
});

describe("unsettled classifications and benefit type", () => {
  const brand = bundle({
    deductibleCents: 0,
    tiers: [
      tierRow(
        1,
        "initial_coverage",
        { type: "copay", amount: "40" },
        { deductible: false },
      ),
      tierRow(
        2,
        "initial_coverage",
        { type: "coinsurance", amount: "0.25" },
        { deductible: false },
      ),
    ],
    drugs: [
      { rxcui: "1000", tier: 1, selected: "unknown" },
      { rxcui: "1001", tier: 2, selected: "unknown" },
    ],
  });
  const opening = {
    kind: "provided" as const,
    as_of: "2026-01-01",
    gross_cents: 100000,
    troop_cents: 70000,
    plan_deductible_met_cents: 0,
  };
  it("knows patient pay when no subsidy rate could cap it, not the payer split", () => {
    const f = run(
      request(
        brand,
        [fill("a", "2026-02-01", { rxcui: "1001", program: "unknown" })],
        { a: synthetic("100.00") },
        { benefit_type: "BA", opening },
      ),
    ).fills[0]!;
    expect(cents(f.patient_pay)).toBe(2500);
    expect(cents(f.covered_plan_paid)).toBe("unknown:drug_program_unknown");
  });
  it("leaves a copay at the drug cost unknown while the subsidy cap may apply", () => {
    const f = run(
      request(
        brand,
        [fill("a", "2026-02-01", { program: "unknown" })],
        { a: synthetic("40.00") },
        { benefit_type: "BA", opening },
      ),
    ).fills[0]!;
    expect(cents(f.patient_pay)).toBe("unknown:drug_program_unknown");
  });
  it("needs the program rate in 2027 only where it could bind", () => {
    const plan2027 = bundle({
      year: 2027,
      deductibleCents: 0,
      tiers: [
        tierRow(
          1,
          "initial_coverage",
          { type: "copay", amount: "40" },
          { deductible: false },
        ),
        tierRow(
          2,
          "initial_coverage",
          { type: "coinsurance", amount: "0.25" },
          { deductible: false },
        ),
      ],
      drugs: [
        { rxcui: "1000", tier: 1 },
        { rxcui: "1001", tier: 2 },
      ],
    });
    const open2027 = { ...opening, as_of: "2027-01-01", troop_cents: 80000 };
    const ok = run(
      request(
        plan2027,
        [fill("a", "2027-02-01", { rxcui: "1001", program: "applicable" })],
        { a: synthetic("100.00") },
        { benefit_type: "BA", opening: open2027 },
      ),
    ).fills[0]!;
    expect(cents(ok.patient_pay)).toBe(2500);
    expect(cents(ok.manufacturer_discount)).toBe(
      "unknown:program_rate_not_documented",
    );
    const capped = run(
      request(
        plan2027,
        [fill("a", "2027-02-01", { program: "applicable" })],
        { a: synthetic("40.00") },
        { benefit_type: "BA", opening: open2027 },
      ),
    ).fills[0]!;
    expect(cents(capped.patient_pay)).toBe(
      "unknown:program_rate_not_documented",
    );
  });
  it("runs both benefit mappings when the type is unknown", () => {
    // Coinsurance below the standard 25%: an enhanced plan would add supplemental TrOOP.
    const plan = bundle({
      deductibleCents: 0,
      tiers: [
        tierRow(
          1,
          "initial_coverage",
          { type: "coinsurance", amount: "0.10" },
          { deductible: false },
        ),
      ],
      drugs: [{ rxcui: "1000", tier: 1 }],
    });
    const f = run(
      request(
        plan,
        [fill("a", "2026-02-01")],
        { a: synthetic("100.00") },
        { benefit_type: "unknown", opening },
      ),
    ).fills[0]!;
    expect(cents(f.patient_pay)).toBe(1000);
    expect(cents(f.troop_increment)).toBe("unknown:benefit_type_unknown");
    expect(f.after.troop.status).toBe("unknown");
  });
  it("leaves insulin status open as unknown", () => {
    const f = run(
      request(dsPlan(), [fill("a", "2026-02-01", { insulin: "unknown" })], {
        a: synthetic("100.00"),
      }),
    ).fills[0]!;
    expect(cents(f.patient_pay)).toBe("unknown:insulin_cost_row_missing");
  });
  it("charges nothing for an ACIP-recommended adult vaccine and keeps the payer split unknown", () => {
    const f = run(
      request(dsPlan(), [fill("a", "2026-02-01", { vaccine: true })], {
        a: synthetic("250.00"),
      }),
    ).fills[0]!;
    expect(cents(f.patient_pay)).toBe(0);
    expect(cents(f.troop_increment)).toBe(0);
    expect(cents(f.covered_plan_paid)).toBe(
      "unknown:vaccine_payer_split_not_modelled",
    );
  });
});

describe("at the out-of-pocket threshold without a price", () => {
  const threshold = { 2026: 210000, 2027: 240000 } as const;
  const opening = (year: 2026 | 2027, below = 0) => ({
    kind: "provided" as const,
    as_of: `${year}-01-01`,
    gross_cents: threshold[year] * 4,
    troop_cents: threshold[year] - below,
    plan_deductible_met_cents: 0,
  });
  const open = {
    program: "unknown",
    insulin: "unknown",
    vaccine: "unknown",
  } as const;
  for (const year of [2026, 2027] as const)
    it(`${year}: $0 in every valid reading of the open facts is a value`, () => {
      const plan = bundle({
        year,
        deductibleCents: year === 2026 ? 61500 : 70000,
        tiers: [
          tierRow(1, "initial_coverage", {
            type: "coinsurance",
            amount: "0.25",
          }),
        ],
        drugs: [{ rxcui: "1000", tier: 1, selected: "unknown" }],
      });
      const result = run(
        request(
          plan,
          [fill("a", `${year}-02-02`, open)],
          {},
          {
            benefit_type: "unknown",
            opening: opening(year),
          },
        ),
      );
      const f = result.fills[0]!;
      // Insulin and vaccine both open: three valid readings each way the benefit and program go.
      expect(f.readings).toBeGreaterThan(1);
      expect(cents(f.patient_pay)).toBe(0);
      expect(cents(f.troop_increment)).toBe(0);
      expect(f.status).toBe("estimated");
      expect(result.status).toBe("estimated");
      expect(f.plan_phase).toEqual({ begin: "C", end: "C" });
      expect(f.after.troop).toEqual({
        status: "value",
        cents: threshold[year],
      });
      // The price still decides the gross cost and the payer split.
      expect(cents(f.gross_above_threshold)).toMatch(
        /^unknown:.*pricing_not_loaded/,
      );
      expect(cents(f.covered_plan_paid)).toMatch(
        /^unknown:.*pricing_not_loaded/,
      );
      expect(f.after.gross_covered_drug_cost.status).toBe("unknown");
      // The rule that the enrollee pays nothing in the catastrophic phase is cited.
      const rules = yearRules(year);
      if (rules.status !== "value") throw new Error("rules not loaded");
      for (const citation of rules.catastrophic_cost_sharing.citations)
        expect(f.evidence).toContainEqual({
          kind: "rule",
          contract_year: year,
          ...citation,
        });
    });
  it("one cent below the threshold the amount needs a price", () => {
    const f = run(
      request(
        dsPlan(),
        [fill("a", "2026-02-02")],
        {},
        {
          opening: opening(2026, 1),
        },
      ),
    ).fills[0]!;
    expect(cents(f.patient_pay)).toBe("unknown:pricing_not_loaded");
  });
  it("keeps a figure unknown when one reading differs", () => {
    // One cent short of the threshold, a $100 fill costs 1 cent unless it is a vaccine.
    const f = run(
      request(
        dsPlan(),
        [fill("a", "2026-02-02", { vaccine: "unknown" })],
        { a: synthetic("100.00") },
        { opening: opening(2026, 1) },
      ),
    ).fills[0]!;
    expect(cents(f.patient_pay)).toBe("unknown:vaccine_classification_unknown");
  });
  it("keeps the conflict for a drug settled as both insulin and a vaccine", () => {
    const f = run(
      request(
        dsPlan(),
        [fill("a", "2026-02-02", { insulin: true, vaccine: true })],
        {},
        {
          opening: opening(2026),
        },
      ),
    ).fills[0]!;
    expect(cents(f.patient_pay)).toBe("unknown:classification_conflict");
  });
});

describe("missing evidence stays unknown", () => {
  it("propagates a missing price to later fills", () => {
    const fills = [
      fill("a", "2026-01-05"),
      fill("b", "2026-02-05"),
      fill("c", "2026-03-05"),
    ];
    const result = run(
      request(dsPlan(), fills, {
        a: synthetic("100.00"),
        c: synthetic("100.00"),
      }),
    );
    expect(result.fills.map((item) => cents(item.patient_pay))).toEqual([
      10000,
      "unknown:pricing_not_loaded",
      "unknown:earlier_fill_unknown",
    ]);
    expect(result.status).toBe("partial");
    expect(result.totals.patient_pay.status).toBe("unknown");
    expect(result.totals.calculable_subtotal).toEqual({
      cents: 10000,
      fills: 1,
      complete: false,
    });
    expect(result.gaps).toContain("pricing_not_loaded");
  });
  it("never turns an absent listing into a denial", () => {
    const plan = bundle({
      tiers: [
        tierRow(1, "initial_coverage", { type: "coinsurance", amount: "0.25" }),
      ],
      drugs: [{ rxcui: "1000", tier: 1, status: "not_listed" }],
    });
    const result = run(
      request(plan, [fill("a", "2026-01-05")], { a: synthetic("10.00") }),
    );
    expect(result.status).toBe("unknown");
    expect(cents(result.fills[0]!.patient_pay)).toBe("unknown:not_listed");
    expect(JSON.stringify(result)).not.toMatch(/not.covered/i);
  });
  it("refuses to pick one of several proxy NDCs", () => {
    const plan = bundle({
      tiers: [
        tierRow(1, "initial_coverage", { type: "coinsurance", amount: "0.25" }),
      ],
      drugs: [{ rxcui: "1000", tier: 1, ndcs: ["00000000001", "00000000002"] }],
    });
    expect(
      cents(
        run(request(plan, [fill("a", "2026-01-05")], { a: synthetic("10.00") }))
          .fills[0]!.patient_pay,
      ),
    ).toBe("unknown:ambiguous_drug_product");
    expect(
      cents(
        run(
          request(
            plan,
            [fill("a", "2026-01-05", { proxy_ndc: "00000000002" })],
            { a: synthetic("10.00") },
          ),
        ).fills[0]!.patient_pay,
      ),
    ).toBe(1000);
  });
  it("does not map a 28-day supply onto the 30-day bucket", () => {
    const result = run(
      request(dsPlan(), [fill("a", "2026-01-05", { days_supply: 28 })], {
        a: synthetic("10.00"),
      }),
    );
    expect(cents(result.fills[0]!.patient_pay)).toBe(
      "unknown:supply_bucket_unproved",
    );
  });
  it("needs a known plan deductible", () => {
    const plan = bundle({
      deductibleCents: null,
      tiers: [
        tierRow(1, "initial_coverage", { type: "coinsurance", amount: "0.25" }),
      ],
      drugs: [{ rxcui: "1000", tier: 1 }],
    });
    expect(
      cents(
        run(request(plan, [fill("a", "2026-01-05")], { a: synthetic("10.00") }))
          .fills[0]!.patient_pay,
      ),
    ).toBe("unknown:plan_deductible_unknown");
  });
  it("treats an unoffered channel as unknown, not as zero", () => {
    const plan = bundle({
      tiers: [tierRow(1, "initial_coverage", { type: "not_offered" })],
      drugs: [{ rxcui: "1000", tier: 1 }],
    });
    const opening = {
      kind: "provided" as const,
      as_of: "2026-01-01",
      gross_cents: 70000,
      troop_cents: 70000,
      plan_deductible_met_cents: 61500,
    };
    expect(
      cents(
        run(
          request(
            plan,
            [fill("a", "2026-01-05")],
            { a: synthetic("10.00") },
            { opening },
          ),
        ).fills[0]!.patient_pay,
      ),
    ).toBe("unknown:channel_not_offered");
  });
});

describe("request validation", () => {
  const ok = request(dsPlan(), [fill("a", "2026-01-05")], {
    a: synthetic("10.00"),
  });
  const status = (input: EstimateRequest) => estimateDrugCosts(input).status;
  it("rejects malformed schedules", () => {
    expect(
      status({
        ...ok,
        fills: [fill("a", "2026-01-05"), fill("a", "2026-02-05")],
      }),
    ).toBe("invalid");
    expect(
      status({
        ...ok,
        fills: [fill("a", "2026-02-05"), fill("b", "2026-01-05")],
      }),
    ).toBe("invalid");
    expect(status({ ...ok, fills: [fill("a", "2027-01-05")] })).toBe("invalid");
    expect(status({ ...ok, fills: [fill("a", "2026-02-30")] })).toBe("invalid");
    expect(status({ ...ok, fills: [] })).toBe("invalid");
    expect(
      status({
        ...ok,
        fills: Array.from({ length: 51 }, (_, i) =>
          fill(`f${i}`, "2026-01-05"),
        ),
      }),
    ).toBe("invalid");
    expect(
      status({
        ...ok,
        fills: Array.from({ length: 11 }, (_, i) =>
          fill(`f${i}`, "2026-01-05", { rxcui: String(3000 + i) }),
        ),
      }),
    ).toBe("invalid");
    expect(status({ ...ok, prices: { zz: synthetic("1.00") } })).toBe(
      "invalid",
    );
  });
  it("rejects inconsistent opening balances", () => {
    const opening = (troop: number, gross: number, met: number) => ({
      kind: "provided" as const,
      as_of: "2026-01-01",
      gross_cents: gross,
      troop_cents: troop,
      plan_deductible_met_cents: met,
    });
    expect(status({ ...ok, opening: opening(500, 100, 0) })).toBe("invalid");
    expect(status({ ...ok, opening: opening(100, 500, 200) })).toBe("invalid");
    expect(status({ ...ok, opening: opening(70000, 90000, 70000) })).toBe(
      "invalid",
    );
    expect(
      status({ ...ok, opening: { ...opening(0, 0, 0), as_of: "2026-02-01" } }),
    ).toBe("invalid");
  });
  it("supports only the non-LIS scenario and reviewed years", () => {
    expect(status({ ...ok, scenario: "lis" })).toBe("unsupported");
    const plan2028 = bundle({ year: 2028, tiers: [], drugs: [] });
    expect(
      estimateDrugCosts(request(plan2028, [fill("a", "2028-01-05")], {})),
    ).toEqual({
      status: "unknown",
      contract_year: 2028,
      reason: "rules_not_loaded",
    });
  });
});

// ---------- properties over synthetic schedules ----------

describe("properties", () => {
  let seed = 20261111;
  const next = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const plans = (): [BenefitType, BenefitBundle][] => [
    ["DS", dsPlan()],
    [
      "BA",
      bundle({
        deductibleCents: 25000,
        tiers: [
          tierRow(
            1,
            "pre_deductible",
            { type: "copay", amount: "5" },
            { deductible: false },
          ),
          tierRow(
            1,
            "initial_coverage",
            { type: "copay", amount: "5" },
            { deductible: false },
          ),
          tierRow(2, "initial_coverage", { type: "copay", amount: "47" }),
          tierRow(3, "initial_coverage", {
            type: "coinsurance",
            amount: "0.33",
          }),
        ],
        drugs: [
          { rxcui: "1000", tier: 1 },
          { rxcui: "1001", tier: 2 },
          { rxcui: "1002", tier: 3, selected: true },
        ],
      }),
    ],
    [
      "EA",
      bundle({
        deductibleCents: 10000,
        tiers: [
          tierRow(2, "initial_coverage", {
            type: "coinsurance",
            amount: "0.15",
          }),
          tierRow(3, "initial_coverage", {
            type: "coinsurance",
            amount: "0.20",
          }),
        ],
        drugs: [
          { rxcui: "1001", tier: 2 },
          { rxcui: "1002", tier: 3, selected: true },
        ],
      }),
    ],
  ];
  it("holds over 60 random synthetic schedules", () => {
    for (let trial = 0; trial < 60; trial++) {
      const [type, plan] = plans()[trial % 3]!;
      const drugs = plan.status === "available" ? plan.drugs : [];
      const count = 1 + Math.floor(next() * 12);
      const fills: FillRequest[] = [];
      const prices: Record<string, PriceEvidence> = {};
      for (let i = 0; i < count; i++) {
        const drug = drugs[Math.floor(next() * drugs.length)]!;
        const id = `f${i}`;
        fills.push(
          fill(
            id,
            `2026-${String(1 + Math.floor(i / 2)).padStart(2, "0")}-15`,
            {
              rxcui: drug.rxcui,
              program:
                drug.packages[0]!.selected_drug === true
                  ? "selected"
                  : "applicable",
            },
          ),
        );
        prices[id] = synthetic(`${Math.floor(next() * 400000) / 100}`);
      }
      const result = run(request(plan, fills, prices, { benefit_type: type }));
      let troop = 0;
      let catastrophic = false;
      for (const f of result.fills) {
        expect(
          f.status,
          `${type} ${f.fill_id} ${JSON.stringify(f.patient_pay)}`,
        ).toBe("estimated");
        const patient = f.patient_pay.cents!;
        const gross = Number(
          roundHalfUpCents(
            d(
              prices[f.fill_id]!.status === "value"
                ? (prices[f.fill_id] as { amount: string }).amount
                : "0",
            ),
          ),
        );
        expect(patient).toBeGreaterThanOrEqual(0);
        if (catastrophic) expect(patient).toBe(0);
        expect(
          f.gross_below_threshold.cents! + f.gross_above_threshold.cents!,
        ).toBe(gross);
        const parts = [
          f.selected_drug_subsidy,
          f.manufacturer_discount,
          f.covered_plan_paid,
          f.non_covered_plan_paid,
        ];
        expect(parts.every((part) => part.status === "value")).toBe(true);
        expect(parts.reduce((sum, part) => sum + part.cents!, patient)).toBe(
          gross,
        );
        expect(f.after.troop.cents!).toBeGreaterThanOrEqual(troop);
        expect(f.after.troop.cents!).toBeLessThanOrEqual(210000);
        if (type !== "EA") expect(f.troop_increment.cents).toBe(patient);
        troop = f.after.troop.cents!;
        catastrophic = troop >= 210000;
      }
    }
  });
});

// ---------- planted mutants ----------

/** Named checks that a correct engine passes. Each mutant below must fail at least one. */
function failingChecks(deps: EngineDeps): string[] {
  const estimate = createEstimator(deps);
  const run = (
    input: EstimateRequest,
    engine: typeof estimate,
  ): Available | undefined => {
    const result = engine(input);
    return "fills" in result ? result : undefined;
  };
  const failures: string[] = [];
  for (const oracle of oracleFile.workedExamples) {
    if (oracleMismatches(oracle, deps).length)
      failures.push(`oracle:${oracle.id}`);
    if (oracleEngine(oracle, estimate).length)
      failures.push(`engine:${oracle.id}`);
  }
  // Exactly at the 2026 threshold the claim is catastrophic.
  const atThreshold = run(
    request(
      dsPlan(),
      [fill("a", "2026-06-01")],
      { a: synthetic("100.00") },
      {
        opening: {
          kind: "provided",
          as_of: "2026-01-01",
          gross_cents: 800000,
          troop_cents: 210000,
          plan_deductible_met_cents: 61500,
        },
      },
    ),
    estimate,
  )?.fills[0];
  if (atThreshold?.plan_phase?.begin !== "C")
    failures.push("boundary:threshold");
  // At the threshold with no price and open facts, every valid reading pays $0; one cent below,
  // the price decides; and a reading that differs keeps the amount unknown.
  const unpriced = (below: number, extra: Parameters<typeof fill>[2] = {}) =>
    run(
      request(
        dsPlan(),
        [fill("a", "2026-06-01", extra)],
        below < 0 ? { a: synthetic("100.00") } : {},
        {
          opening: {
            kind: "provided",
            as_of: "2026-01-01",
            gross_cents: 800000,
            troop_cents: 210000 - Math.abs(below),
            plan_deductible_met_cents: 61500,
          },
        },
      ),
      estimate,
    )?.fills[0];
  const open = { insulin: "unknown", vaccine: "unknown" } as const;
  const atZero = unpriced(0, open)?.patient_pay;
  if (!atZero || cents(atZero) !== 0)
    failures.push("threshold:unpriced_open_facts");
  if (unpriced(1)?.patient_pay.status !== "unknown")
    failures.push("threshold:one_cent_below");
  if (unpriced(-1, { vaccine: "unknown" })?.patient_pay.status !== "unknown")
    failures.push("readings:disagree");
  // TrOOP that lands exactly on the standard deductible does not exceed it: no subsidy.
  const waived = bundle({
    deductibleCents: 0,
    tiers: [
      tierRow(
        1,
        "initial_coverage",
        { type: "coinsurance", amount: "0.25" },
        { deductible: false },
      ),
    ],
    drugs: [{ rxcui: "1000", tier: 1, selected: true }],
  });
  const atStandard = run(
    request(
      waived,
      [fill("a", "2026-06-01", { program: "selected" })],
      { a: synthetic("60.00") },
      {
        benefit_type: "BA",
        opening: {
          kind: "provided",
          as_of: "2026-01-01",
          gross_cents: 100000,
          troop_cents: 60000,
          plan_deductible_met_cents: 0,
        },
      },
    ),
    estimate,
  )?.fills[0];
  if (!atStandard || cents(atStandard.selected_drug_subsidy) !== 0)
    failures.push("boundary:standard_deductible");
  // 2027 uses its own deductible.
  const y2027 = run(
    request(dsPlan(2027), [fill("a", "2027-01-05")], {
      a: synthetic("800.00"),
    }),
    estimate,
  )?.fills[0];
  if (!y2027 || cents(y2027.patient_pay) !== 72500) failures.push("year:2027");
  // Half-cent rounding on an exact value.
  const half = run(
    request(
      dsPlan(),
      [fill("a", "2026-03-01")],
      { a: synthetic("4.02") },
      {
        opening: {
          kind: "provided",
          as_of: "2026-01-01",
          gross_cents: 100000,
          troop_cents: 61500,
          plan_deductible_met_cents: 61500,
        },
      },
    ),
    estimate,
  )?.fills[0];
  if (!half || cents(half.patient_pay) !== 101)
    failures.push("rounding:half_cent");
  return failures;
}

describe("planted mutants", () => {
  const mutate = (
    claim: Partial<ClaimDeps>,
    rest: Partial<EngineDeps> = {},
  ): EngineDeps => ({
    ...engineDeps,
    ...rest,
    claim: { ...claimDeps, ...claim },
  });
  it("the real engine passes every check", () => {
    expect(failingChecks(engineDeps)).toEqual([]);
  });
  it("catches an off-by-one threshold boundary", () => {
    const failures = failingChecks(
      mutate({
        reached: (troop, limit) => troop.n * limit.d > limit.n * troop.d,
      }),
    );
    expect(failures).toContain("boundary:threshold");
  });
  it("catches a threshold one cent low", () => {
    const failures = failingChecks(
      mutate({
        reached: (troop, limit) => cmp(troop, sub(limit, fromCents(1))) >= 0,
      }),
    );
    expect(failures).toContain("threshold:one_cent_below");
  });
  it("catches a threshold one cent high on an unpriced fill", () => {
    const failures = failingChecks(
      mutate({
        reached: (troop, limit) => cmp(troop, add(limit, fromCents(1))) >= 0,
      }),
    );
    expect(failures).toContain("threshold:unpriced_open_facts");
  });
  it("catches a reading that differs accepted as a value", () => {
    const failures = failingChecks(
      mutate({}, { agree: (values) => values.length > 0 }),
    );
    expect(failures).toContain("readings:disagree");
  });
  it("catches an off-by-one standard deductible boundary", () => {
    const failures = failingChecks(
      mutate({
        exceeds: (troop, limit) => troop.n * limit.d >= limit.n * troop.d,
      }),
    );
    expect(failures).toContain("boundary:standard_deductible");
  });
  // The mutants relabel the other year's figures, so the engine's own year guard cannot see them.
  const relabelled = (year: number) => {
    const rules = yearRules(year === 2026 ? 2027 : 2026);
    return { ...rules, contract_year: year };
  };
  it("catches the other year's parameters", () => {
    const failures = failingChecks(mutate({}, { rules: relabelled }));
    expect(failures).toEqual(
      expect.arrayContaining([
        "oracle:ds-deductible-crossing",
        "engine:ds-catastrophic-crossing",
        "year:2027",
      ]),
    );
  });
  it("catches the other year's program figures", () => {
    const failures = failingChecks(
      mutate(
        {},
        {
          program: (year) => ({
            ...programRules(year === 2026 ? 2027 : 2026)!,
            contract_year: year,
          }),
        },
      ),
    );
    expect(failures).toEqual(
      expect.arrayContaining([
        "oracle:ds-deductible-crossing",
        "engine:selected-drug-copay-ceiling",
      ]),
    );
  });
  it("refuses rules labelled for another year", () => {
    const input = request(dsPlan(), [fill("a", "2026-01-05")], {
      a: synthetic("10.00"),
    });
    const engine = createEstimator(
      mutate({}, { rules: (year) => yearRules(year === 2026 ? 2027 : 2026) }),
    );
    expect(engine(input)).toEqual({
      status: "unknown",
      contract_year: 2026,
      reason: "rules_year_mismatch",
    });
  });
  it("catches floating-point rounding", () => {
    const failures = failingChecks(
      mutate({
        round: (value) =>
          BigInt(Math.round((Number(value.n) / Number(value.d)) * 100)),
      }),
    );
    expect(failures).toContain("rounding:half_cent");
  });
});
