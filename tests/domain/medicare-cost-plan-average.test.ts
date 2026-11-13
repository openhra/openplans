// Plan-average prices through the Part D engine. Every unit cost, fee range, benefit
// and schedule below is synthetic and labelled so; the real-file check is
// scripts/oracle/medicare-part-d-price.mjs.
import { describe, expect, it } from "vitest";
import type {
  EngineDeps,
  EstimateRequest,
  EstimateResult,
  FillRequest,
  FillResult,
  OpeningState,
  PriceEvidence,
} from "../../src/domain/medicare/part-d-cost/engine.js";
import {
  createEstimator,
  engineDeps,
} from "../../src/domain/medicare/part-d-cost/engine.js";
import type {
  FeeSpan,
  PlanAveragePrice,
  PricingDeps,
} from "../../src/domain/medicare/part-d-cost/price.js";
import {
  FEE_UNKNOWN,
  feeSpan,
  fillPricing,
  planAveragePrice,
  pricingDeps,
} from "../../src/domain/medicare/part-d-cost/price.js";
import type {
  BenefitBundle,
  FeeRangeReading,
  FeeRanges,
  MoneyFigure,
  RowRef,
  TierCost,
  UnitCost,
} from "../../src/domain/medicare/part-d-cost/repository.js";
import {
  UNIT_COST_CAVEAT,
  unitCostTenThousandths,
  yearRules,
} from "../../src/domain/medicare/part-d-cost/repository.js";
import {
  drugCostDeps,
  drugCostEstimate,
  estimateProvenanceProblems,
} from "../../src/services/medicare-drug-cost.js";
import type { DrugCostDeps } from "../../src/services/medicare-drug-cost.js";
import { spufChannels } from "../../src/ingest/medicare/spuf.js";

// ---------- synthetic inputs ----------

const PRICING_ROW: RowRef = {
  snapshot_id: "synthetic",
  table: "pricing",
  source_row: 7,
  fields: ["UNIT_COST"],
};
const unitCost = (text: string): UnitCost => ({
  status: "value",
  basis: "cms_plan_average",
  unit_cost: text,
  ten_thousandths: unitCostTenThousandths(text)!,
  days_supply: 30,
  quantity_basis: "caller_asserted_ndc_units",
  caveat: UNIT_COST_CAVEAT,
  evidence: PRICING_ROW,
});
interface RangeSpec {
  readable?: number;
  missing?: number;
  floor?: string | null;
  floorsMissing?: number;
}
function range(
  type: FeeRangeReading["fee_type"],
  min: string | null,
  max: string | null,
  spec: RangeSpec = {},
): FeeRangeReading {
  const readable = spec.readable ?? (min === null ? 0 : 10);
  const missing = spec.missing ?? (min === null ? 10 : 0);
  return {
    fee_type: type,
    pharmacies: readable + missing,
    fees_readable: readable,
    fees_missing: missing,
    min_fee: min,
    max_fee: max,
    max_floor_price: spec.floor === undefined ? "0.0000" : spec.floor,
    floors_missing: spec.floorsMissing ?? 0,
    evidence: {
      snapshot_id: "synthetic",
      table: "dispensing_fee",
      source_files: ["synthetic networks"],
      source_sha256: ["0".repeat(64)],
      first_source_row: 1,
    },
  };
}
const fees = (...ranges: FeeRangeReading[]): FeeRanges => ({
  status: "value",
  channel: "preferred_retail",
  days_supply: 30,
  ranges,
});
/** Brand $0.50-$2.00 and generic $0.25-$1.00: the lowest fee is $0.25 and the highest $2.00. */
const spread = () =>
  fees(
    range("brand", "0.5000", "2.0000"),
    range("generic", "0.2500", "1.0000"),
    range("selected", null, null),
  );
const flat = () =>
  fees(
    range("brand", "0.0000", "0.0000"),
    range("generic", "0.0000", "0.0000"),
    range("selected", null, null),
  );
// 1.2345 x 30 = $37.035: $37.04 alone, $37.29 with the lowest fee, $39.04 with the highest.
const UNIT = "1.2345";
const QUANTITY = "30";
const ALONE = 3704;
const LOW = 3729;
const HIGH = 3904;

function price(
  ranges: FeeRanges,
  deps: PricingDeps = pricingDeps,
  unit = UNIT,
): PlanAveragePrice {
  const built = planAveragePrice(unitCost(unit), ranges, QUANTITY, deps);
  if (built.status !== "plan_average") throw new Error(built.reason);
  return built;
}

let rowCounter = 100;
const ref = (table: RowRef["table"]): RowRef => ({
  snapshot_id: "synthetic",
  table,
  source_row: ++rowCounter,
  fields: [],
});
const money = (cents: number): MoneyFigure => ({
  status: "value",
  cents,
  raw: (cents / 100).toFixed(2),
});
const none: MoneyFigure = { status: "not_reported", raw: "" };
function tier(
  phase: TierCost["phase"],
  sharing: { copay: number } | { rate: string },
): TierCost {
  return {
    tier: 1,
    phase,
    supply: "30_days",
    specialty_tier: false,
    deductible_applies: true,
    channels: spufChannels.map(({ channel }) => ({
      channel,
      status: "copay" in sharing ? "copay" : "coinsurance",
      amount:
        "copay" in sharing
          ? money(sharing.copay)
          : {
              status: "value",
              rate: sharing.rate,
              basis_points: Math.round(Number(sharing.rate) * 10_000),
              raw: sharing.rate,
            },
      minimum: none,
      maximum: none,
      reason: null,
    })),
    evidence: [ref("beneficiary_cost")],
  };
}
function plan(sharing: { copay: number } | { rate: string }): BenefitBundle {
  return {
    status: "available",
    bundle_version: "1",
    plan_key: "H9000-001-0",
    contract_year: 2026,
    release: {
      snapshot_id: "synthetic",
      kind: "synthetic",
      contract_year: 2026,
      as_of: "2026-01-01",
      sha256: "0".repeat(64),
      url: "synthetic",
    },
    formulary_id: "00000001",
    deductible: money(61500),
    deductible_evidence: [ref("plan")],
    special_needs_plan: {
      status: "value",
      code: "0",
      snp: false,
      evidence: [ref("plan")],
    },
    tiers: [
      tier("initial_coverage", sharing),
      tier("catastrophic", { copay: 0 }),
    ],
    insulin: [],
    drugs: [
      {
        rxcui: "1000",
        status: "listed",
        reason: null,
        product: "single",
        packages: [
          {
            proxy_ndc: "00000000001",
            tier: 1,
            prior_authorization: false,
            step_therapy: false,
            quantity_limit: false,
            quantity_limit_amount: null,
            quantity_limit_days: null,
            selected_drug: false,
            formulary_version: "1",
            evidence: ref("formulary"),
          },
        ],
        supplemental: [],
        indications: [],
      },
    ],
    rules: yearRules(2026),
    conflicts: [],
    gaps: [],
  };
}
const fill = (id: string, date = "2026-03-02"): FillRequest => ({
  fill_id: id,
  date,
  rxcui: "1000",
  days_supply: 30,
  quantity: QUANTITY,
  unit: "ndc_unit",
  classification: {
    insulin: false,
    acip_vaccine: false,
    program: "not_applicable",
  },
});
/** The standard deductible already met, so initial-coverage cost sharing applies. */
const pastDeductible = (troopCents = 61500): OpeningState => ({
  kind: "provided",
  as_of: "2026-01-01",
  gross_cents: Math.max(troopCents, 400000),
  troop_cents: troopCents,
  plan_deductible_met_cents: 61500,
});
type Available = Extract<EstimateResult, { fills: FillResult[] }>;
function estimate(
  bundle: BenefitBundle,
  prices: Record<string, PriceEvidence>,
  options: { opening?: OpeningState; deps?: EngineDeps } = {},
): Available {
  const fills = Object.keys(prices).map((id, i) =>
    fill(id, `2026-03-0${i + 2}`),
  );
  const request: EstimateRequest = {
    contract_year: 2026,
    scenario: "non_lis_no_other_payer",
    benefit_type: "DS",
    bundle,
    channel: "preferred_retail",
    opening: options.opening ?? pastDeductible(),
    fills,
    prices,
  };
  const result = createEstimator(options.deps ?? engineDeps)(request);
  if (!("fills" in result)) throw new Error(JSON.stringify(result));
  return result;
}

// ---------- the checks, shared with the planted mutants ----------

type Check = [name: string, ok: () => boolean];
function checks(deps: PricingDeps): Check[] {
  const engine = { ...engineDeps, pricing: deps };
  const run = (
    sharing: { copay: number } | { rate: string },
    ranges: FeeRanges,
  ) =>
    estimate(plan(sharing), { f1: price(ranges, deps) }, { deps: engine })
      .fills[0]!;
  const same = (a: unknown, b: unknown) =>
    JSON.stringify(a) === JSON.stringify(b);
  return [
    [
      "gross is bounded by the lowest and highest fee",
      () =>
        same(fillPricing(price(spread(), deps), [], deps).figures.gross, {
          status: "bounded",
          cents: null,
          minimum_cents: LOW,
          maximum_cents: HIGH,
          reason: FEE_UNKNOWN,
        }),
    ],
    [
      "coinsurance patient pay is bounded in order",
      () =>
        same(run({ rate: "0.25" }, spread()).patient_pay, {
          status: "bounded",
          cents: null,
          minimum_cents: 932,
          maximum_cents: 976,
          reason: FEE_UNKNOWN,
        }),
    ],
    [
      "no readable fee leaves the fee totals and gross unknown",
      () => {
        const figures = fillPricing(
          price(
            fees(
              range("brand", null, null),
              range("generic", null, null),
              range("selected", null, null),
            ),
            deps,
          ),
          [],
          deps,
        ).figures;
        return (
          figures.total_lowest_fee.status === "unknown" &&
          figures.total_highest_fee.status === "unknown" &&
          figures.gross.status === "unknown" &&
          figures.gross.reason === FEE_UNKNOWN
        );
      },
    ],
    [
      "no readable fee leaves coinsurance patient pay unknown",
      () => {
        const patient = run(
          { rate: "0.25" },
          fees(range("brand", null, null), range("generic", null, null)),
        ).patient_pay;
        return patient.status === "unknown" && patient.reason === FEE_UNKNOWN;
      },
    ],
    [
      "equal fees give one value",
      () =>
        same(fillPricing(price(flat(), deps), [], deps).figures.gross, {
          status: "value",
          cents: ALONE,
        }),
    ],
  ];
}
const failing = (deps: PricingDeps) =>
  checks(deps)
    .filter(([, ok]) => !ok())
    .map(([name]) => name);

// ---------- tests ----------

describe("plan-average price figures (synthetic)", () => {
  it("prices a fill alone, with the lowest fee and with the highest fee", () => {
    const pricing = fillPricing(price(spread()), ["not_applicable"]);
    expect(pricing.fee_set).toBe("brand_or_generic");
    expect(pricing.readings.map((item) => item.key)).toEqual([
      "unit_cost",
      "lowest_fee",
      "highest_fee",
    ]);
    expect(pricing.figures).toEqual({
      unit_cost_total: { status: "value", cents: ALONE },
      total_lowest_fee: { status: "value", cents: LOW },
      total_highest_fee: { status: "value", cents: HIGH },
      gross: {
        status: "bounded",
        cents: null,
        minimum_cents: LOW,
        maximum_cents: HIGH,
        reason: FEE_UNKNOWN,
      },
    });
  });

  it("gives one value when all three readings agree to the cent", () => {
    const pricing = fillPricing(price(flat()), ["not_applicable"]);
    expect(pricing.readings).toHaveLength(1);
    expect(pricing.reason).toBeNull();
    expect(pricing.figures.gross).toEqual({ status: "value", cents: ALONE });
  });

  it("takes the selected-drug fee, or the brand fee where none is filed", () => {
    const selected = ["selected"];
    const withSelected = fees(
      range("brand", "0.5000", "2.0000"),
      range("generic", "0.1000", "0.2000"),
      range("selected", "1.0000", "1.5000"),
    );
    expect(fillPricing(price(withSelected), selected).fee_set).toBe(
      "selected_or_brand",
    );
    expect(price(withSelected).fees.selected_or_brand).toEqual({
      status: "value",
      lowest: "1",
      highest: "1.5",
    });
    // No pharmacy files a selected fee: every pharmacy falls back to its brand fee.
    expect(price(spread()).fees.selected_or_brand).toEqual({
      status: "value",
      lowest: "0.5",
      highest: "2",
    });
  });

  it("leaves a mixed selected and brand range unknown when the brand fees could move it", () => {
    const mixed = (brandLow: string, brandHigh: string) =>
      price(
        fees(
          range("brand", brandLow, brandHigh),
          range("generic", "0.1000", "0.2000"),
          range("selected", "1.0000", "1.5000", { readable: 6, missing: 4 }),
        ),
      ).fees.selected_or_brand;
    expect(mixed("1.2000", "1.4000")).toEqual({
      status: "value",
      lowest: "1",
      highest: "1.5",
    });
    expect(mixed("0.5000", "1.4000")).toEqual<FeeSpan>({
      status: "unknown",
      reason: FEE_UNKNOWN,
    });
    expect(mixed("1.2000", "3.0000")).toEqual<FeeSpan>({
      status: "unknown",
      reason: FEE_UNKNOWN,
    });
  });

  it("uses every fee type while the selected-drug program is open", () => {
    expect(
      fillPricing(price(spread()), ["selected", "applicable"]).fee_set,
    ).toBe("any_fee_type");
  });

  it("never reads a missing fee as $0", () => {
    const missing = price(
      fees(range("brand", null, null), range("generic", null, null)),
    );
    const figures = fillPricing(missing, ["not_applicable"]).figures;
    expect(figures.unit_cost_total).toEqual({ status: "value", cents: ALONE });
    for (const key of [
      "total_lowest_fee",
      "total_highest_fee",
      "gross",
    ] as const)
      expect(figures[key]).toEqual({
        status: "unknown",
        cents: null,
        reason: FEE_UNKNOWN,
      });
  });

  it("names a plan without in-area pharmacies as an unknown fee, and a missing table by name", () => {
    const noPharmacy = planAveragePrice(
      unitCost(UNIT),
      { status: "unknown", reason: "no_in_area_network_pharmacy" },
      QUANTITY,
    );
    const notLoaded = planAveragePrice(
      unitCost(UNIT),
      { status: "unknown", reason: "dispensing_fees_not_loaded" },
      QUANTITY,
    );
    expect(
      noPharmacy.status === "plan_average" &&
        fillPricing(noPharmacy, []).figures.gross,
    ).toEqual({ status: "unknown", cents: null, reason: FEE_UNKNOWN });
    expect(
      notLoaded.status === "plan_average" &&
        fillPricing(notLoaded, []).figures.total_lowest_fee,
    ).toEqual({
      status: "unknown",
      cents: null,
      reason: "dispensing_fees_not_loaded",
    });
  });

  it("leaves the gross cost unknown when a floor price could bind", () => {
    const above = fees(
      range("brand", "0.0000", "0.0000", { floor: "40.0000" }),
      range("generic", "0.0000", "0.0000", { floor: "40.0000" }),
    );
    const unreadable = fees(
      range("brand", "0.0000", "0.0000", { floorsMissing: 1 }),
      range("generic", "0.0000", "0.0000", { floorsMissing: 1 }),
    );
    for (const ranges of [above, unreadable])
      expect(fillPricing(price(ranges), []).figures.gross).toEqual({
        status: "unknown",
        cents: null,
        reason: "floor_price_may_apply",
      });
    const below = fees(
      range("brand", "0.0000", "0.0000", { floor: "5.0000" }),
      range("generic", "0.0000", "0.0000", { floor: "5.0000" }),
    );
    expect(fillPricing(price(below), []).figures.gross).toEqual({
      status: "value",
      cents: ALONE,
    });
  });

  it("keeps an unknown price unknown and refuses a zero quantity", () => {
    expect(
      planAveragePrice(
        { status: "unknown", reason: "unit_cost_unreadable", evidence: [] },
        spread(),
        QUANTITY,
      ),
    ).toEqual({ status: "unknown", reason: "unit_cost_unreadable" });
    expect(planAveragePrice(unitCost(UNIT), spread(), "0")).toEqual({
      status: "unknown",
      reason: "quantity_unreadable",
    });
  });
});

describe("plan-average prices in the engine (synthetic)", () => {
  it("settles a copay below every reading as one value and bounds the gross cost", () => {
    const result = estimate(plan({ copay: 1000 }), { f1: price(spread()) });
    const one = result.fills[0]!;
    expect(one.status).toBe("estimated");
    expect(one.patient_pay).toEqual({ status: "value", cents: 1000 });
    expect(one.price_basis).toBe("cms_plan_average");
    expect(one.price?.gross).toEqual({
      status: "bounded",
      cents: null,
      minimum_cents: LOW,
      maximum_cents: HIGH,
      reason: FEE_UNKNOWN,
    });
    expect(one.readings).toBe(3);
    expect(one.evidence).toContainEqual({ kind: "source_row", ...PRICING_ROW });
    expect(one.evidence.some((item) => item.kind === "fee_range")).toBe(true);
  });

  it("bounds coinsurance by the lowest and highest fee and keeps the payer split unknown", () => {
    const result = estimate(plan({ rate: "0.25" }), { f1: price(spread()) });
    const one = result.fills[0]!;
    const bounds = {
      status: "bounded",
      cents: null,
      minimum_cents: 932,
      maximum_cents: 976,
      reason: FEE_UNKNOWN,
    };
    expect(one.status).toBe("bounded");
    expect(one.patient_pay).toEqual(bounds);
    expect(one.troop_increment).toEqual(bounds);
    expect(one.covered_plan_paid).toMatchObject({
      status: "unknown",
      reason: FEE_UNKNOWN,
    });
    expect(one.after.troop.status).toBe("unknown");
    expect(result.status).toBe("unknown");
    expect(result.totals.patient_pay.status).toBe("unknown");
    expect(result.totals.calculable_subtotal).toEqual({
      cents: 0,
      fills: 0,
      complete: false,
    });
    expect(result.gaps).toContain(FEE_UNKNOWN);
  });

  it("gives one value when the fees cannot move the price", () => {
    const one = estimate(plan({ rate: "0.25" }), { f1: price(flat()) })
      .fills[0]!;
    expect(one.patient_pay).toEqual({ status: "value", cents: 926 });
    expect(one.price?.gross).toEqual({ status: "value", cents: ALONE });
  });

  it("leaves a later fill unknown when an earlier fill's fee moves it", () => {
    // $15.00 short of the threshold: the second fill pays what the first leaves.
    const result = estimate(
      plan({ rate: "0.25" }),
      { f1: price(spread()), f2: price(spread()) },
      { opening: pastDeductible(208500) },
    );
    expect(result.fills[0]!.patient_pay.status).toBe("bounded");
    expect(result.fills[1]!.patient_pay).toMatchObject({
      status: "unknown",
      reason: FEE_UNKNOWN,
    });
  });

  it("never charges $0 for a missing fee or a missing price before the threshold", () => {
    const missingFee = price(
      fees(range("brand", null, null), range("generic", null, null)),
    );
    const noFee = estimate(plan({ rate: "0.25" }), { f1: missingFee })
      .fills[0]!;
    expect(noFee.patient_pay).toMatchObject({
      status: "unknown",
      reason: FEE_UNKNOWN,
    });
    const noPrice = estimate(plan({ rate: "0.25" }), {
      f1: {
        status: "unknown",
        reason: "price_days_supply_not_published",
        basis: "cms_plan_average",
      },
    }).fills[0]!;
    expect(noPrice.patient_pay).toMatchObject({
      status: "unknown",
      reason: "price_days_supply_not_published",
    });
    expect(noPrice.price?.gross).toEqual({
      status: "unknown",
      cents: null,
      reason: "price_days_supply_not_published",
    });
  });

  it("still charges nothing in the catastrophic phase when the fee is unknown", () => {
    const missingFee = price(
      fees(range("brand", null, null), range("generic", null, null)),
    );
    const one = estimate(
      plan({ rate: "0.25" }),
      { f1: missingFee },
      { opening: pastDeductible(210000) },
    ).fills[0]!;
    expect(one.patient_pay).toEqual({ status: "value", cents: 0 });
  });
});

describe("planted pricing mutants", () => {
  it("passes every check with the production rules", () => {
    expect(failing(pricingDeps)).toEqual([]);
  });

  it("catches a midpoint returned instead of bounds", () => {
    const midpoint: PricingDeps = {
      ...pricingDeps,
      between: (low, high) => ({
        status: "value",
        cents: Math.round((low + high) / 2),
      }),
    };
    expect(failing(midpoint)).toEqual(
      expect.arrayContaining([
        "gross is bounded by the lowest and highest fee",
        "coinsurance patient pay is bounded in order",
      ]),
    );
  });

  it("catches a missing fee treated as $0", () => {
    const zeroFee: PricingDeps = {
      ...pricingDeps,
      feeSpan: (readings) => {
        const real = feeSpan(readings);
        return real.status === "value"
          ? real
          : { status: "value", lowest: "0", highest: "0" };
      },
    };
    expect(failing(zeroFee)).toEqual(
      expect.arrayContaining([
        "no readable fee leaves the fee totals and gross unknown",
        "no readable fee leaves coinsurance patient pay unknown",
      ]),
    );
  });

  // The rest of the design's planted mutants for the plan-average price.
  const sameFee = (pick: (low: number, high: number) => number) => {
    const deps: PricingDeps = {
      ...pricingDeps,
      feeSpan: (readings) => {
        const real = feeSpan(readings);
        if (real.status !== "value") return real;
        const fee = String(pick(Number(real.lowest), Number(real.highest)));
        return { status: "value", lowest: fee, highest: fee };
      },
    };
    return deps;
  };

  it("catches the fee readings dropped (unit cost alone)", () => {
    expect(failing(sameFee(() => 0))).toEqual(
      expect.arrayContaining([
        "gross is bounded by the lowest and highest fee",
        "coinsurance patient pay is bounded in order",
      ]),
    );
  });

  it("catches the fees collapsed to their mean", () => {
    expect(failing(sameFee((low, high) => (low + high) / 2))).toEqual(
      expect.arrayContaining([
        "gross is bounded by the lowest and highest fee",
        "coinsurance patient pay is bounded in order",
      ]),
    );
  });

  it("catches a binding floor price ignored", () => {
    // Floors of $40.00 lie above the $37.04 unit cost total, so they could bind.
    const floored = fees(
      range("brand", "0.0000", "0.0000", { floor: "40.0000" }),
      range("generic", "0.0000", "0.0000", { floor: "40.0000" }),
    );
    const floorChecks = (
      read: (price: PlanAveragePrice) => PlanAveragePrice,
    ) => {
      const built = read(price(floored));
      const gross = fillPricing(built, []).figures.gross;
      const patient = estimate(plan({ rate: "0.25" }), { f1: built }).fills[0]!
        .patient_pay;
      return [
        gross.status === "unknown" && gross.reason === "floor_price_may_apply",
        patient.status === "unknown" &&
          patient.reason === "floor_price_may_apply",
      ];
    };
    expect(floorChecks((built) => built)).toEqual([true, true]);
    const ignored = (built: PlanAveragePrice): PlanAveragePrice => ({
      ...built,
      floor: { status: "value", highest: null },
    });
    expect(floorChecks(ignored)).toEqual([false, false]);
  });

  it("catches swapped bounds", () => {
    const swapped: PricingDeps = {
      ...pricingDeps,
      between: (low, high) => pricingDeps.between(high, low),
    };
    expect(failing(swapped)).toEqual(
      expect.arrayContaining([
        "gross is bounded by the lowest and highest fee",
        "coinsurance patient pay is bounded in order",
      ]),
    );
  });
});

describe("plan-average estimates through the service (synthetic, no database)", () => {
  const body = {
    scenario: "non_lis_no_other_payer",
    price_basis: "cms_plan_average" as const,
    channel: "preferred_retail" as const,
    opening_state: {
      kind: "provided" as const,
      as_of: "2026-01-01",
      gross_covered_drug_cost_cents: 400000,
      troop_cents: 61500,
      plan_deductible_met_cents: 61500,
    },
    fills: [
      {
        fill_id: "f1",
        date: "2026-03-02",
        rxcui: "1000",
        quantity: QUANTITY,
        unit: "ndc_unit",
        days_supply: 30,
      },
    ],
  };
  const deps = (overrides: Partial<DrugCostDeps> = {}): DrugCostDeps => ({
    ...drugCostDeps,
    enabled: () => true,
    partD: () => true,
    pricing: () => true,
    pricesProblem: async () => null,
    drugFacts: () => ({
      insulin: false,
      acip_vaccine: false,
      program: "not_applicable",
    }),
    readBundle: async () => plan({ rate: "0.25" }),
    readUnitCost: async () => unitCost(UNIT),
    readFeeRanges: async () => spread(),
    ...overrides,
  });
  const key = { contractId: "H9000", planId: "001", segmentId: "0" };
  const ask = (d: DrugCostDeps) =>
    drugCostEstimate(
      null as never,
      key,
      2026,
      drugCostDeps.parse(body),
      d,
    ) as Promise<Record<string, unknown>>;

  it("refuses the plan-average basis while its switch is off", async () => {
    expect(await ask(deps({ pricing: () => false }))).toMatchObject({
      status: "unsupported",
      reason: "price_basis_not_supported",
    });
  });

  it("answers bounds with evidence and the plan-average caveat", async () => {
    const answer = await ask(deps());
    const fills = answer.fills as {
      figures: Record<string, unknown>;
      price: { figures: Record<string, unknown>; caveat: string };
    }[];
    expect(fills[0]!.figures.patient_pay).toMatchObject({
      status: "bounded",
      cents: null,
      minimum_cents: 932,
      maximum_cents: 976,
      reason: FEE_UNKNOWN,
    });
    expect(fills[0]!.price.figures.gross).toMatchObject({
      status: "bounded",
      minimum_cents: LOW,
      maximum_cents: HIGH,
    });
    expect(fills[0]!.price.caveat).toBe(UNIT_COST_CAVEAT);
    expect(
      (answer.evidence as { kind: string; table?: string }[]).some(
        (item) => item.kind === "source_row" && item.table === "pricing",
      ),
    ).toBe(true);
    expect(
      (answer.evidence as { kind: string }[]).some(
        (item) => item.kind === "fee_range",
      ),
    ).toBe(true);
    expect(answer.bindable_quote).toBe(false);
    expect(estimateProvenanceProblems(answer)).toEqual([]);
  });

  it("checks bounds: out of order or without evidence is refused", async () => {
    const answer = await ask(deps());
    const swapped = structuredClone(answer) as {
      fills: { figures: Record<string, Record<string, unknown>> }[];
    };
    const patient = swapped.fills[0]!.figures.patient_pay!;
    [patient.minimum_cents, patient.maximum_cents] = [
      patient.maximum_cents,
      patient.minimum_cents,
    ];
    expect(estimateProvenanceProblems(swapped)).toEqual([
      "$.fills[0].figures.patient_pay: bounds out of order",
    ]);
    patient.evidence_refs = [];
    expect(estimateProvenanceProblems(swapped)).toContain(
      "$.fills[0].figures.patient_pay: bounds without evidence",
    );
  });

  it("gives no price for a drug the plan does not list", async () => {
    const answer = await ask(
      deps({
        readBundle: async () => ({
          ...(plan({ rate: "0.25" }) as Extract<
            BenefitBundle,
            { status: "available" }
          >),
          drugs: [],
        }),
      }),
    );
    const fills = answer.fills as {
      price: { figures: Record<string, { reason: string }> };
    }[];
    expect(fills[0]!.price.figures.gross!.reason).toBe("drug_not_in_bundle");
  });
});
