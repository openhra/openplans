import type { SpufChannel } from "../../../ingest/medicare/spuf.js";
import type { BoundDeps, PlanFacts } from "./bounds.js";
import { boundDeps, boundDocuments, classifyBounds } from "./bounds.js";
import type {
  ClaimDeps,
  ClaimFigures,
  ClaimResult,
  PhaseCode,
  Sharing,
} from "./claim.js";
import { ROUNDING_POLICY, claimDeps, createClaimCalculator } from "./claim.js";
import type {
  BenefitTypeOrigin,
  DrugClassification,
  PbpRowRef,
} from "./classification.js";
import { classifyDrug, resolveBenefitType } from "./classification.js";
import type { Rational } from "./decimal.js";
import {
  ZERO,
  cmp,
  fromBasisPoints,
  fromCents,
  parseDecimal,
} from "./decimal.js";
import type {
  Citation,
  DrugProgram,
  ProgramClass,
  ProgramRules,
} from "./program-rules.js";
import { programRules } from "./program-rules.js";
import { maximumFairPrice, mfpTotal } from "./mfp.js";
import type {
  FeeRangeRef,
  FillMfp,
  FillPricing,
  Ingredient,
  PlanAveragePrice,
  PriceFigure,
  PriceReadingKey,
} from "./price.js";
import type { PricingDeps } from "./price.js";
import { FEE_UNKNOWN, fillPricing, pricingDeps } from "./price.js";
import type {
  BenefitBundle,
  ChannelCost,
  Conflict,
  InsulinCost,
  Package,
  RowRef,
  Supply,
  TierCost,
  YearRules,
} from "./repository.js";
import { yearRules } from "./repository.js";

/**
 * Runs an ordered fill schedule through one plan's filed Part D benefit for a beneficiary without
 * the low-income subsidy or another payer. The engine does no I/O: it takes the benefit bundle,
 * the prices and the opening accumulators, and returns patient liability, TrOOP and the phase
 * split of every fill with its evidence.
 *
 * The plan's benefit type comes from its PBP filing when the bundle carries one, and a drug's
 * selected-drug status from the formulary flag and the CMS selected-drug list (classification.ts).
 * A caller's value may fill a gap those leave, as a labelled assertion, but never contradict
 * them.
 *
 * Where a needed fact is unsettled (an unknown benefit type, a drug's program or insulin status,
 * a subsidy rate no pinned document gives), the engine runs every admissible reading. A figure is
 * a value only when all readings agree on it; otherwise it is unknown and names the facts that
 * changed it. Filed minimum and maximum cost sharing follows the rules in bounds.ts; a bound those
 * rules do not recognise leaves the fill unknown.
 */

export const ENGINE_VERSION = "1";
export const MAX_FILLS = 50;
export const MAX_PRODUCTS = 10;
/** Readings are combinations of unsettled facts; past this many the request stays unknown. */
export const MAX_READINGS = 1024;
export const SCENARIO = "non_lis_no_other_payer";

export type BenefitType = "DS" | "AE" | "BA" | "EA" | "unknown";
export type Tri = boolean | "unknown";

export interface FillRequest {
  fill_id: string;
  /** ISO date, YYYY-MM-DD. Fills on the same date run in request order. */
  date: string;
  rxcui: string;
  /** Chooses one package when the formulary lists several proxy NDCs. */
  proxy_ndc?: string;
  days_supply: number;
  /** Recorded with the fill; no unit conversion is attempted. */
  quantity: string;
  unit: string;
  /**
   * Caller assertions. The formulary flag and the CMS selected-drug list settle the selected-drug
   * program and win over them. No cached file settles insulin or vaccine status, so "unknown"
   * keeps both open.
   */
  classification: {
    insulin: Tri;
    acip_vaccine: Tri;
    program: DrugProgram | "unknown";
  };
}

/**
 * A claim price. A dollar amount comes from a CMS worked example or a labelled synthetic test; a
 * plan average (price.ts) is priced with and without the dispensing fee, and the engine runs each
 * reading. An unknown plan-average price names its basis so the fill still reports price figures.
 */
export type PriceEvidence =
  | {
      status: "value";
      amount: string;
      basis: "cms_worked_example" | "synthetic";
      reference: string;
      maximum_fair_price?: string;
    }
  | PlanAveragePrice
  | { status: "unknown"; reason: string; basis?: "cms_plan_average" };

export type OpeningState =
  | { kind: "new_calendar_year" }
  | {
      kind: "provided";
      as_of: string;
      gross_cents: number;
      troop_cents: number;
      plan_deductible_met_cents: number;
    };

export interface EstimateRequest {
  contract_year: number;
  scenario: string;
  benefit_type: BenefitType;
  bundle: BenefitBundle;
  channel: SpufChannel;
  opening: OpeningState;
  fills: FillRequest[];
  /** By fill id; a fill without an entry has no price (`pricing_not_loaded`). */
  prices: Record<string, PriceEvidence>;
}

/**
 * A reported amount. `bounded` holds the minimum and maximum when only the dispensing fee moves
 * the amount and the amount rises with the price; it is never a single value.
 */
export type Figure = PriceFigure;

export type Evidence =
  | ({ kind: "source_row" } & RowRef)
  | ({ kind: "pbp_row" } & PbpRowRef)
  | ({ kind: "rule"; contract_year: number } & Citation)
  | ({ kind: "fee_range" } & FeeRangeRef)
  | { kind: "request"; field: string };

export interface ConflictNote {
  code: string;
  detail: string;
  /** What the plan filed, when the engine saw the row; the rules decide what applies. */
  filed: { channel: SpufChannel; raw: string }[];
  applied: string;
  evidence: RowRef[];
}

export interface Accumulators {
  gross_covered_drug_cost: Figure;
  troop: Figure;
  plan_deductible_met: Figure;
}

/** A plan-average fill's price figures and how it was priced. */
export interface FillPrice {
  basis: "cms_plan_average";
  unit_cost: string | null;
  quantity: string | null;
  quantity_basis: "caller_asserted_ndc_units" | null;
  caveat: string | null;
  fee_set: FillPricing["fee_set"] | null;
  /** Null until the drug is classified. */
  ingredient: Ingredient | null;
  /** The maximum fair price in effect for a selected drug on the fill date, per NDC unit. */
  maximum_fair_price: {
    unit_price: string;
    effective_from: string;
    effective_to: string | null;
  } | null;
  readings: PriceReadingKey[];
  unit_cost_total: Figure;
  total_lowest_fee: Figure;
  total_highest_fee: Figure;
  gross: Figure;
  maximum_fair_price_total: Figure;
}

export interface FillResult {
  fill_id: string;
  date: string;
  rxcui: string;
  status: "estimated" | "bounded" | "unknown";
  tier: number | null;
  supply: Supply | null;
  price_basis: string | null;
  /** Null unless the fill is priced from plan averages. */
  price: FillPrice | null;
  listing_conditions: string[];
  patient_pay: Figure;
  troop_increment: Figure;
  gross_below_threshold: Figure;
  gross_above_threshold: Figure;
  selected_drug_subsidy: Figure;
  manufacturer_discount: Figure;
  covered_plan_paid: Figure;
  non_covered_plan_paid: Figure;
  /** How each drug fact was settled; null when the fill stopped before classification. */
  classification: DrugClassification | null;
  plan_phase: { begin: PhaseCode; end: PhaseCode } | null;
  standard_phase: { begin: PhaseCode; end: PhaseCode } | null;
  before: Accumulators;
  after: Accumulators;
  derivation: string[];
  conflicts: ConflictNote[];
  evidence: Evidence[];
  readings: number;
}

export type EstimateResult =
  | {
      status: "estimated" | "partial" | "unknown";
      contract_year: number;
      plan_key: string;
      scenario: typeof SCENARIO;
      bindable_quote: false;
      estimate_scope: "supplied_schedule";
      engine_version: string;
      rounding_policy: string;
      rules_documents: { id: string; url: string; sha256: string }[];
      channel: SpufChannel;
      channel_verification: "unknown";
      benefit_type: {
        value: BenefitType;
        origin: BenefitTypeOrigin;
        reason: string | null;
        evidence: Evidence[];
      };
      opening_origin: "new_calendar_year" | "caller_assertion";
      assumptions: string[];
      gaps: string[];
      fills: FillResult[];
      totals: {
        patient_pay: Figure;
        calculable_subtotal: {
          cents: number;
          fills: number;
          complete: boolean;
        };
        closing: Accumulators;
      };
      conflicts: ConflictNote[];
    }
  | {
      status: "unknown";
      contract_year: number;
      reason: string;
    }
  | { status: "unsupported"; contract_year: number; reason: string }
  | { status: "invalid"; contract_year: number; errors: string[] };

export interface EngineDeps {
  claim: ClaimDeps;
  rules: (year: number) => YearRules;
  program: (year: number) => ProgramRules | null;
  bounds: BoundDeps;
  classify: {
    drug: typeof classifyDrug;
    benefitType: typeof resolveBenefitType;
  };
  /** Whether the readings' values for one figure settle it: all of them must be the same. */
  agree: (values: readonly string[]) => boolean;
  pricing: PricingDeps;
  /** The maximum fair price in effect for an NDC-11 on a fill date (mfp.ts). */
  maximumFairPrice: typeof maximumFairPrice;
}
export const engineDeps: EngineDeps = {
  claim: claimDeps,
  rules: (year) => yearRules(year),
  program: programRules,
  bounds: boundDeps,
  classify: { drug: classifyDrug, benefitType: resolveBenefitType },
  agree: (values) => values.length > 0 && new Set(values).size === 1,
  pricing: pricingDeps,
  maximumFairPrice: (year, ndc, date) => maximumFairPrice(year, ndc, date),
};

// ---------- readings ----------

interface Variable {
  key: string;
  reason: string;
  options: readonly string[];
}
type World = Record<string, string>;

const supplyBuckets: Record<number, Supply> = {
  30: "30_days",
  60: "60_days",
  90: "90_days",
};
const supplyOf = (days: number): Supply | null => supplyBuckets[days] ?? null;

interface ResolvedFill {
  request: FillRequest;
  blocked: string | null;
  tier: number | null;
  supply: Supply | null;
  pkg: Package | null;
  price: PriceEvidence;
  gross: Rational | null;
  /** Plan-average readings; the engine runs each one when they disagree. */
  pricing: FillPricing | null;
  mfp: Rational | null;
  /** The CMS rows behind a selected drug's maximum fair price. */
  mfpCitations: Citation[];
  programs: DrugProgram[];
  insulin: boolean[];
  vaccine: boolean[];
  classification: DrugClassification | null;
}

const isoDate = /^(\d{4})-(\d{2})-(\d{2})$/;
function validDate(text: string): boolean {
  const match = isoDate.exec(text);
  if (!match) return false;
  const date = new Date(`${text}T00:00:00Z`);
  return (
    !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === text
  );
}

const sorted = <T>(items: Iterable<T>, key: (item: T) => string) => {
  const map = new Map<string, T>();
  for (const item of items) map.set(key(item), item);
  return [...map.entries()]
    .sort(([a], [b]) => a.localeCompare(b, "en"))
    .map(([, v]) => v);
};

export function createEstimator(deps: EngineDeps = engineDeps) {
  const priceClaim = createClaimCalculator(deps.claim);

  return function estimateDrugCosts(request: EstimateRequest): EstimateResult {
    const year = request.contract_year;
    const errors = validate(request);
    if (errors.length)
      return { status: "invalid", contract_year: year, errors };
    if (request.scenario !== SCENARIO)
      return {
        status: "unsupported",
        contract_year: year,
        reason: "scenario_not_supported",
      };
    const bundle = request.bundle;
    if (bundle.status !== "available")
      return { status: "unknown", contract_year: year, reason: bundle.reason };
    const rules = deps.rules(year);
    const program = deps.program(year);
    const bounds = deps.bounds.rules(year);
    if (rules.status !== "value" || !program)
      return {
        status: "unknown",
        contract_year: year,
        reason: "rules_not_loaded",
      };
    if (
      rules.contract_year !== year ||
      program.contract_year !== year ||
      (bounds && bounds.contract_year !== year)
    )
      return {
        status: "unknown",
        contract_year: year,
        reason: "rules_year_mismatch",
      };

    const resolvedType = deps.classify.benefitType(
      request.benefit_type,
      bundle.benefit_type,
    );
    if ("conflict" in resolvedType)
      return {
        status: "unknown",
        contract_year: year,
        reason: resolvedType.conflict,
      };
    const benefitType: BenefitType = resolvedType.type;
    const benefitEvidence: Evidence[] = [
      ...resolvedType.evidence.map((ref) => ({
        kind: "pbp_row" as const,
        ...ref,
      })),
      ...resolvedType.citations.map((citation) => ({
        kind: "rule" as const,
        contract_year: year,
        ...citation,
      })),
    ];

    const params = {
      standardDeductible: fromCents(rules.standard_deductible.cents!),
      outOfPocketThreshold: fromCents(rules.out_of_pocket_threshold.cents!),
      standardInitialShare: fromBasisPoints(
        rules.initial_coverage_cost_sharing.basis_points!,
      ),
      insulinCopayCap: program.insulin.copay_cap,
      insulinPriceShareCap: program.insulin.price_share_cap,
    };
    const ruleEvidence: Evidence[] = [
      rules.standard_deductible,
      rules.out_of_pocket_threshold,
      rules.deductible_cost_sharing,
      rules.initial_coverage_cost_sharing,
      rules.catastrophic_cost_sharing,
    ].flatMap((figure) =>
      figure.citations.map((citation) => ({
        kind: "rule" as const,
        contract_year: year,
        ...citation,
      })),
    );

    // Resolve each fill against the bundle; this does not depend on any reading.
    const resolved = request.fills.map((fill): ResolvedFill => {
      const price = request.prices[fill.fill_id] ?? {
        status: "unknown" as const,
        reason: "pricing_not_loaded",
      };
      const base: ResolvedFill = {
        request: fill,
        blocked: null,
        tier: null,
        supply: supplyOf(fill.days_supply),
        pkg: null,
        price,
        gross: null,
        pricing: null,
        mfp: null,
        mfpCitations: [],
        programs: [],
        insulin: [],
        vaccine: [],
        classification: null,
      };
      const block = (reason: string) => ({ ...base, blocked: reason });
      const drug = bundle.drugs.find((item) => item.rxcui === fill.rxcui);
      if (!drug) return block("drug_not_in_bundle");
      if (drug.status === "not_listed")
        return block(
          drug.supplemental.length ? "supplemental_listing_only" : "not_listed",
        );
      if (drug.status !== "listed")
        return block(drug.reason ?? "drug_evidence_unknown");
      const packages = fill.proxy_ndc
        ? drug.packages.filter((item) => item.proxy_ndc === fill.proxy_ndc)
        : drug.packages;
      if (packages.length !== 1)
        return block(
          packages.length ? "ambiguous_drug_product" : "proxy_ndc_not_listed",
        );
      const pkg = packages[0]!;
      base.pkg = pkg;
      base.tier = pkg.tier;
      if (!base.supply) return block("supply_bucket_unproved");
      if (price.status === "value") {
        base.gross = parseDecimal(price.amount);
        if (!base.gross || cmp(base.gross, ZERO) < 0)
          return block("price_unreadable");
        if (price.maximum_fair_price !== undefined) {
          base.mfp = parseDecimal(price.maximum_fair_price);
          if (!base.mfp) return block("price_unreadable");
        }
      }
      const classified = deps.classify.drug(year, pkg, fill.classification);
      if ("conflict" in classified) return block(classified.conflict);
      base.classification = classified;
      base.programs = classified.program.options;
      if (price.status === "plan_average") {
        const lookup = deps.maximumFairPrice(year, pkg.proxy_ndc, fill.date);
        let mfp: FillMfp = {
          status: "unknown",
          reason:
            lookup.status === "unknown" ? lookup.reason : "quantity_unreadable",
        };
        if (lookup.status === "value") {
          const total = mfpTotal(lookup.unit_price, price.quantity);
          if (total)
            mfp = {
              status: "value",
              unit_price: lookup.unit_price,
              total,
              effective_from: lookup.effective_from,
              effective_to: lookup.effective_to,
            };
        }
        base.pricing = fillPricing(
          price,
          classified.program.options,
          deps.pricing,
          mfp,
        );
        if (base.pricing.readings.length === 1)
          base.gross = base.pricing.readings[0]!.gross;
        base.mfp = base.pricing.mfp?.total ?? null;
        if (base.pricing.ingredient !== "plan_average")
          base.mfpCitations = lookup.citations;
      }
      const tri = (value: Tri) =>
        value === "unknown" ? [false, true] : [value];
      base.insulin = tri(classified.insulin.value);
      base.vaccine = tri(classified.acip_vaccine.value);
      return base;
    });

    // Unsettled facts become reading variables.
    const variables: Variable[] = [];
    const addVariable = (
      key: string,
      reason: string,
      options: readonly string[],
    ) => {
      if (options.length > 1 && !variables.some((item) => item.key === key))
        variables.push({ key, reason, options });
    };
    if (benefitType === "unknown")
      addVariable("benefit", "benefit_type_unknown", [
        "basic",
        "enhanced_alternative",
      ]);
    for (const fill of resolved) {
      if (fill.blocked) continue;
      const rx = fill.request.rxcui;
      if (fill.pricing?.reason)
        addVariable(
          priceKey(fill.request.fill_id),
          fill.pricing.reason,
          fill.pricing.readings.map((reading) => reading.key),
        );
      addVariable(`program:${rx}`, "drug_program_unknown", fill.programs);
      addVariable(
        `insulin:${rx}`,
        "insulin_classification_unknown",
        fill.insulin.map(String),
      );
      addVariable(
        `vaccine:${rx}`,
        "vaccine_classification_unknown",
        fill.vaccine.map(String),
      );
      for (const cls of fill.programs) {
        const [low, high] = program.classes[cls].initial;
        if (cmp(low, high) !== 0)
          addVariable(`rate:${cls}`, "program_rate_not_documented", [
            "low",
            "high",
          ]);
      }
      if (fill.insulin.includes(true)) {
        const row = insulinRow(bundle.insulin, fill.tier, fill.supply!);
        const cell = row?.channels.find(
          (item) => item.channel === request.channel,
        );
        if (
          cell?.status === "filed" &&
          cell.copay.status === "value" &&
          cell.coinsurance.status === "value"
        )
          addVariable(
            `insulin_fields:${fill.tier}|${fill.supply}`,
            "insulin_cost_fields_undefined",
            ["copay", "coinsurance", "lesser_of"],
          );
      }
    }
    const readingCount = variables.reduce(
      (count, item) => count * item.options.length,
      1,
    );
    if (readingCount > MAX_READINGS)
      return {
        status: "unknown",
        contract_year: year,
        reason: "too_many_unsettled_facts",
      };
    const worlds: World[] = [{}];
    for (const variable of variables) {
      const next: World[] = [];
      for (const world of worlds)
        for (const option of variable.options)
          next.push({ ...world, [variable.key]: option });
      worlds.splice(0, worlds.length, ...next);
    }
    // A reading in which an open fact makes a drug both covered insulin and an ACIP vaccine is not
    // a valid reading: no drug is both. Only a drug settled as both keeps that conflict.
    const valid = worlds.filter((world) =>
      resolved.every((fill) => {
        if (fill.blocked) return true;
        const rx = fill.request.rxcui;
        const both =
          (world[`insulin:${rx}`] ?? String(fill.insulin[0])) === "true" &&
          (world[`vaccine:${rx}`] ?? String(fill.vaccine[0])) === "true";
        return (
          !both || (fill.insulin.length === 1 && fill.vaccine.length === 1)
        );
      }),
    );
    if (valid.length) worlds.splice(0, worlds.length, ...valid);

    const opening =
      request.opening.kind === "provided"
        ? {
            gross: BigInt(request.opening.gross_cents),
            troop: BigInt(request.opening.troop_cents),
            met: BigInt(request.opening.plan_deductible_met_cents),
          }
        : { gross: 0n, troop: 0n, met: 0n };
    const runs = worlds.map((world) => simulate(world));

    // ---------- combine readings ----------
    const fills: FillResult[] = resolved.map((fill, index) => {
      const outcomes = runs.map((run) => run[index]!);
      const matters = (pick: (outcome: WorldOutcome) => string | null) => {
        const reasons = new Set<string>();
        for (const outcome of outcomes)
          if (outcome.result.status === "unknown")
            reasons.add(outcome.result.reason);
        if (reasons.size) return [...reasons].sort().join("+");
        for (const variable of variables) {
          const groups = new Map<string, Set<string | null>>();
          worlds.forEach((world, i) => {
            const key = JSON.stringify(
              variables
                .filter((item) => item !== variable)
                .map((item) => world[item.key]),
            );
            const set = groups.get(key) ?? new Set();
            set.add(pick(outcomes[i]!));
            groups.set(key, set);
          });
          if ([...groups.values()].some((set) => set.size > 1))
            reasons.add(variable.reason);
        }
        return [...reasons].sort().join("+") || "readings_disagree";
      };
      // Only this fill's dispensing fee may move a bounded figure, and the figure must rise with
      // the price: unit cost alone <= lowest fee <= highest fee. Any other disagreement stays
      // unknown, as does a figure an earlier fill's fee moves.
      const key = priceKey(fill.request.fill_id);
      const priceVariable = variables.find((item) => item.key === key);
      const bound = (values: readonly bigint[]): Figure | null => {
        if (fill.pricing?.reason !== FEE_UNKNOWN || !priceVariable) return null;
        const order = [BOUNDED_READINGS, MFP_BOUNDED_READINGS].find(
          (keys) => priceVariable.options.join() === keys.join(),
        );
        if (!order) return null;
        const byReading = new Map<string, Set<bigint>>();
        worlds.forEach((world, i) => {
          const set = byReading.get(world[key]!) ?? new Set<bigint>();
          set.add(values[i]!);
          byReading.set(world[key]!, set);
        });
        if ([...byReading.values()].some((set) => set.size !== 1)) return null;
        const ends = order.map((reading) => [...byReading.get(reading)!][0]!);
        // A maximum fair price has no reading without the fee: its lowest-fee reading starts.
        const [alone, low, high] =
          ends.length === 3 ? ends : [ends[0]!, ...ends];
        if (alone! > low! || low! > high!)
          return {
            status: "unknown",
            cents: null,
            reason: "cost_sharing_not_monotonic_in_price",
          };
        return deps.pricing.between(Number(low), Number(high));
      };
      const figure = (
        pick: (claim: ClaimFigures, outcome: WorldOutcome) => bigint | null,
        nullReason: string | ((outcome: WorldOutcome) => string),
        boundable = false,
      ): Figure => {
        const values = outcomes.map((outcome) =>
          outcome.result.status === "value"
            ? pick(outcome.result, outcome)
            : undefined,
        );
        const byVariables = () =>
          matters((outcome) =>
            outcome.result.status === "value"
              ? String(pick(outcome.result, outcome))
              : null,
          );
        if (values.some((value) => value === undefined))
          return { status: "unknown", cents: null, reason: byVariables() };
        if (values.some((value) => value === null)) {
          const reasons = new Set(
            outcomes
              .filter((_, i) => values[i] === null)
              .map((outcome) =>
                typeof nullReason === "string"
                  ? nullReason
                  : nullReason(outcome),
              ),
          );
          return {
            status: "unknown",
            cents: null,
            reason: [...reasons].sort().join("+"),
          };
        }
        if (deps.agree(values.map(String)))
          return { status: "value", cents: Number(values[0]) };
        const bounded = boundable ? bound(values as bigint[]) : null;
        return (
          bounded ?? { status: "unknown", cents: null, reason: byVariables() }
        );
      };
      // Why a reading has no amount for a figure the price or the payer split decides.
      const missing = (outcome: WorldOutcome) => {
        if (outcome.vaccine) return "vaccine_payer_split_not_modelled";
        return outcome.unpriced ?? "program_rate_not_documented";
      };
      const payer = (pick: (claim: ClaimFigures) => bigint | null) =>
        figure(
          (claim, outcome) => (outcome.payerDocumented ? pick(claim) : null),
          missing,
        );
      const phase = (
        pick: (claim: ClaimFigures) => { begin: PhaseCode; end: PhaseCode },
      ) => {
        const values = outcomes.map((outcome) =>
          outcome.result.status === "value"
            ? JSON.stringify(pick(outcome.result))
            : null,
        );
        return values.every((value) => value !== null) &&
          deps.agree(values as string[])
          ? (JSON.parse(values[0]!) as { begin: PhaseCode; end: PhaseCode })
          : null;
      };
      const state = (
        pick: (outcome: WorldOutcome) => StateCents,
        label: string,
      ): Accumulators => {
        const one = (key: keyof StateCents): Figure => {
          const values = outcomes.map((outcome) => pick(outcome)[key]);
          if (
            values.every((value) => value !== null) &&
            deps.agree(values.map(String))
          )
            return { status: "value", cents: Number(values[0]) };
          const reasons = new Set<string>();
          for (const outcome of outcomes)
            if (pick(outcome)[key] === null) reasons.add(`${label}_unknown`);
          return {
            status: "unknown",
            cents: null,
            reason: reasons.size
              ? [...reasons][0]!
              : matters((outcome) => String(pick(outcome)[key])),
          };
        };
        return {
          gross_covered_drug_cost: one("gross"),
          troop: one("troop"),
          plan_deductible_met: one("met"),
        };
      };
      const patient = figure(
        (claim) => claim.patientCents,
        "patient_pay_unknown",
        true,
      );
      const conflicts = sorted(
        outcomes.flatMap((outcome) => outcome.conflicts),
        (note) => JSON.stringify(note),
      );
      const evidence = sorted(
        [
          ...outcomes.flatMap((outcome) => outcome.evidence),
          ...(fill.blocked ? [] : [...ruleEvidence, ...benefitEvidence]),
          ...(fill.classification
            ? [
                ...fill.classification.program.evidence.map((ref) => ({
                  kind: "source_row" as const,
                  ...ref,
                })),
                ...fill.classification.program.citations.map((citation) => ({
                  kind: "rule" as const,
                  contract_year: year,
                  ...citation,
                })),
              ]
            : []),
          { kind: "request" as const, field: `fills.${fill.request.fill_id}` },
          ...fill.mfpCitations.map((citation) => ({
            kind: "rule" as const,
            contract_year: year,
            ...citation,
          })),
          ...(fill.pricing && fill.price.status === "plan_average"
            ? [
                { kind: "source_row" as const, ...fill.price.pricing_row },
                ...fill.price.fee_ranges.map((ref) => ({
                  kind: "fee_range" as const,
                  ...ref,
                })),
              ]
            : []),
          ...(fill.price.status === "value"
            ? [
                {
                  kind: "request" as const,
                  field: `prices.${fill.request.fill_id}`,
                },
              ]
            : []),
        ],
        (item) => JSON.stringify(item),
      );
      const derivation = [
        ...new Set(
          outcomes.flatMap((outcome) =>
            outcome.result.status === "value" ? outcome.result.derivation : [],
          ),
        ),
      ];
      const conditions: string[] = [];
      if (fill.pkg?.prior_authorization !== false)
        conditions.push(
          fill.pkg?.prior_authorization === true
            ? "prior_authorization"
            : "prior_authorization_unknown",
        );
      if (fill.pkg?.step_therapy !== false)
        conditions.push(
          fill.pkg?.step_therapy === true
            ? "step_therapy"
            : "step_therapy_unknown",
        );
      if (fill.pkg?.quantity_limit !== false)
        conditions.push(
          fill.pkg?.quantity_limit === true
            ? "quantity_limit"
            : "quantity_limit_unknown",
        );
      const drug = bundle.drugs.find(
        (item) => item.rxcui === fill.request.rxcui,
      );
      if (drug?.indications.length)
        conditions.push("indication_based_coverage");
      return {
        fill_id: fill.request.fill_id,
        date: fill.request.date,
        rxcui: fill.request.rxcui,
        status: FILL_STATUS[patient.status],
        tier: fill.tier,
        supply: fill.supply,
        price_basis:
          fill.price.status === "unknown"
            ? (fill.price.basis ?? null)
            : fill.price.basis,
        price: fillPrice(fill),
        listing_conditions: fill.pkg ? conditions : [],
        classification: fill.classification,
        patient_pay: patient,
        troop_increment: figure(
          (claim) => claim.troopDeltaCents,
          "troop_unknown",
          true,
        ),
        gross_below_threshold: figure(
          (claim, outcome) =>
            outcome.vaccine ? null : claim.belowThresholdCents,
          "vaccine_payer_split_not_modelled",
        ),
        gross_above_threshold: figure(
          (claim, outcome) =>
            outcome.vaccine || outcome.unpriced
              ? null
              : claim.aboveThresholdCents,
          missing,
        ),
        selected_drug_subsidy: payer((claim) => claim.selectedDrugSubsidyCents),
        manufacturer_discount: payer(
          (claim) => claim.manufacturerDiscountCents,
        ),
        covered_plan_paid: payer((claim) => claim.coveredPlanPaidCents),
        non_covered_plan_paid: payer((claim) => claim.nonCoveredPlanPaidCents),
        plan_phase: phase((claim) => claim.planPhase),
        standard_phase: phase((claim) => claim.standardPhase),
        before: state((outcome) => outcome.before, "opening"),
        after: state((outcome) => outcome.after, "accumulator"),
        derivation,
        conflicts,
        evidence,
        readings: worlds.length,
      };
    });

    const known = fills.filter((fill) => fill.patient_pay.status === "value");
    const subtotal = known.reduce(
      (sum, fill) => sum + (fill.patient_pay.cents ?? 0),
      0,
    );
    const complete = known.length === fills.length;
    let status: "estimated" | "partial" | "unknown" = "unknown";
    if (complete) status = "estimated";
    else if (known.length) status = "partial";
    const gaps: string[] = [
      ...new Set(
        fills.flatMap((fill) =>
          [fill.patient_pay, fill.troop_increment]
            .filter(
              (item): item is Exclude<Figure, { status: "value" }> =>
                item.status !== "value",
            )
            .flatMap((item) => item.reason.split("+")),
        ),
      ),
    ].sort();
    // Say why a fact that left figures unknown is open: the missing source, not only the fact.
    const openBecause: Record<string, (fill: ResolvedFill) => string | null> = {
      drug_program_unknown: (fill) =>
        fill.classification?.program.reason ?? null,
      insulin_classification_unknown: (fill) =>
        fill.classification?.insulin.reason ?? null,
      vaccine_classification_unknown: (fill) =>
        fill.classification?.acip_vaccine.reason ?? null,
      benefit_type_unknown: () => resolvedType.reason,
    };
    for (const [gap, why] of Object.entries(openBecause))
      if (gaps.includes(gap))
        for (const fill of resolved) {
          const reason = why(fill);
          if (reason && !gaps.includes(reason)) gaps.push(reason);
        }
    gaps.sort();
    const bundleConflicts = bundle.conflicts
      .filter(
        (conflict) =>
          conflict.code === "catastrophic_cost_sharing_conflicts_with_rules",
      )
      .map((conflict) => catastrophicNote(conflict));
    const cited = new Set(
      fills.flatMap((fill) =>
        fill.evidence.flatMap((item) =>
          item.kind === "rule" ? [item.document] : [],
        ),
      ),
    );
    const rulesDocuments = [
      ...rules.documents,
      ...boundDocuments().filter(
        (doc) =>
          cited.has(doc.id) &&
          !rules.documents.some((known) => known.id === doc.id),
      ),
    ];
    const last = fills[fills.length - 1]!;
    return {
      status,
      contract_year: year,
      plan_key: bundle.plan_key,
      scenario: SCENARIO,
      bindable_quote: false,
      estimate_scope: "supplied_schedule",
      engine_version: ENGINE_VERSION,
      rounding_policy: ROUNDING_POLICY,
      rules_documents: rulesDocuments,
      channel: request.channel,
      channel_verification: "unknown",
      benefit_type: {
        value: benefitType,
        origin: resolvedType.origin,
        reason: resolvedType.reason,
        evidence: benefitEvidence,
      },
      opening_origin:
        request.opening.kind === "provided"
          ? "caller_assertion"
          : "new_calendar_year",
      assumptions: [
        "Beneficiary without the low-income subsidy and without another payer.",
        "The pharmacy channel is the caller's choice; network participation is not verified.",
        "Selected-drug status is the formulary flag checked against the CMS selected-drug list for the year; insulin and ACIP vaccine status are as supplied or left open.",
        "For covered insulin the 30-day supply bucket is read as the one-month supply of the statutory ceiling.",
        "Premiums, IRMAA, penalties and drugs outside Part D are not evaluated.",
      ],
      gaps,
      fills,
      totals: {
        patient_pay: complete
          ? { status: "value", cents: subtotal }
          : {
              status: "unknown",
              cents: null,
              reason: "fill_amount_unknown",
            },
        calculable_subtotal: { cents: subtotal, fills: known.length, complete },
        closing: last.after,
      },
      conflicts: bundleConflicts,
    };

    // ---------- one reading ----------

    interface StateCents {
      gross: bigint | null;
      troop: bigint | null;
      met: bigint | null;
    }
    interface WorldOutcome {
      result: ClaimResult;
      payerDocumented: boolean;
      vaccine: boolean;
      /** Set when the reading has no price: the figures the price decides stay unknown. */
      unpriced: string | null;
      before: StateCents;
      after: StateCents;
      conflicts: ConflictNote[];
      evidence: Evidence[];
    }

    function simulate(world: World): WorldOutcome[] {
      if (bundle.status !== "available" || !program) return [];
      let state: StateCents = { ...opening };
      const design =
        benefitType === "EA" ||
        (benefitType === "unknown" && world.benefit === "enhanced_alternative")
          ? "enhanced_alternative"
          : "basic";
      // The bound rules need to know whether the plan is defined standard and a SNP.
      let definedStandard: PlanFacts["defined_standard"] = benefitType === "DS";
      if (benefitType === "unknown")
        definedStandard =
          world.benefit === "enhanced_alternative" ? false : "unknown";
      const snp = bundle.special_needs_plan;
      const planFacts: PlanFacts = {
        defined_standard: definedStandard,
        special_needs_plan: snp.status === "value" ? snp.snp : "unknown",
      };
      const planDeductible = bundle.deductible;
      return resolved.map((fill) => {
        const before = state;
        const evidence: Evidence[] = [];
        const conflicts: ConflictNote[] = [];
        if (fill.pkg)
          evidence.push({ kind: "source_row", ...fill.pkg.evidence });
        const finish = (
          result: ClaimResult,
          after: StateCents,
          extra: Partial<WorldOutcome> = {},
        ): WorldOutcome => {
          state = after;
          return {
            result,
            payerDocumented: false,
            vaccine: false,
            unpriced: null,
            before,
            after,
            conflicts,
            evidence,
            ...extra,
          };
        };
        const unknownAll = (reason: string) =>
          finish(
            { status: "unknown", reason, derivation: [] },
            { gross: null, troop: null, met: null },
          );
        if (fill.blocked) return unknownAll(fill.blocked);
        const rx = fill.request.rxcui;
        const cls =
          (world[`program:${rx}`] as DrugProgram | undefined) ??
          fill.programs[0]!;
        const insulin =
          (world[`insulin:${rx}`] ?? String(fill.insulin[0])) === "true";
        const vaccine =
          (world[`vaccine:${rx}`] ?? String(fill.vaccine[0])) === "true";
        if (insulin && vaccine) return unknownAll("classification_conflict");
        const programClass: ProgramClass = program.classes[cls];
        evidence.push(
          ...programClass.citations.map((citation) => ({
            kind: "rule" as const,
            contract_year: year,
            ...citation,
          })),
        );
        if (insulin)
          evidence.push(
            ...program.insulin.citations.map((citation) => ({
              kind: "rule" as const,
              contract_year: year,
              ...citation,
            })),
          );
        if (vaccine)
          evidence.push(
            ...program.vaccine.citations.map((citation) => ({
              kind: "rule" as const,
              contract_year: year,
              ...citation,
            })),
          );
        const [low, high] = programClass.initial;
        const initial = world[`rate:${cls}`] === "high" ? high : low;
        const payerDocumented =
          cmp(low, high) === 0 && programClass.catastrophic !== null;
        if (state.troop === null || state.met === null)
          return unknownAll("earlier_fill_unknown");
        const troop = fromCents(state.troop);
        const threshold = fromCents(
          rules.status === "value" ? rules.out_of_pocket_threshold.cents! : 0,
        );
        const standard = fromCents(
          rules.status === "value" ? rules.standard_deductible.cents! : 0,
        );
        const inCatastrophe = deps.claim.reached(troop, threshold);

        // Find the filed cost sharing for this reading.
        let sharing: Sharing = { kind: "coinsurance", rate: ZERO };
        let deductibleRemaining = ZERO;
        let preDeductibleCell: ChannelCost | null = null;
        let initialCell: ChannelCost | null = null;
        if (!inCatastrophe && !vaccine) {
          if (insulin) {
            if (fill.supply !== "30_days")
              return unknownAll("insulin_supply_ceiling_unproved");
            const row = insulinRow(bundle.insulin, fill.tier, fill.supply);
            if (!row) return unknownAll("insulin_cost_row_missing");
            evidence.push(
              ...row.evidence.map((ref) => ({
                kind: "source_row" as const,
                ...ref,
              })),
            );
            const cell = row.channels.find(
              (item) => item.channel === request.channel,
            );
            if (!cell || cell.status !== "filed")
              return unknownAll(
                cell?.status === "not_offered"
                  ? "channel_not_offered"
                  : (cell?.reason ?? "insulin_cost_unknown"),
              );
            evidence.push(
              ...cell.derived_from.map((ref) => ({
                kind: "source_row" as const,
                ...ref,
              })),
            );
            const copay =
              cell.copay.status === "value"
                ? fromCents(cell.copay.cents)
                : null;
            const coin =
              cell.coinsurance.status === "value"
                ? fromBasisPoints(cell.coinsurance.basis_points)
                : null;
            if (
              cell.copay.status === "unknown" ||
              cell.coinsurance.status === "unknown"
            )
              return unknownAll("insulin_cost_unknown");
            const reading = world[`insulin_fields:${fill.tier}|${fill.supply}`];
            if (copay && coin) {
              sharing = { kind: "lesser_of", copay, rate: coin };
              if (reading === "copay")
                sharing = { kind: "copay", amount: copay };
              if (reading === "coinsurance")
                sharing = { kind: "coinsurance", rate: coin };
            } else if (copay) sharing = { kind: "copay", amount: copay };
            else if (coin) sharing = { kind: "coinsurance", rate: coin };
            else return unknownAll("insulin_cost_not_reported");
          } else {
            const tierRow = (phase: "pre_deductible" | "initial_coverage") =>
              bundle.tiers.find(
                (item) =>
                  item.tier === fill.tier &&
                  item.phase === phase &&
                  item.supply === fill.supply,
              ) ?? null;
            const icpRow = tierRow("initial_coverage");
            if (!icpRow)
              return unknownAll(missingRowReason(bundle.conflicts, fill.tier!));
            evidence.push(
              ...icpRow.evidence.map((ref) => ({
                kind: "source_row" as const,
                ...ref,
              })),
            );
            const applies = icpRow.deductible_applies;
            if (applies === "unknown")
              return unknownAll("deductible_applies_unknown");
            let planRemaining: Rational | null;
            if (deps.claim.reached(troop, standard)) planRemaining = ZERO;
            else if (planDeductible.status === "value") {
              planRemaining = fromCents(
                BigInt(planDeductible.cents) > state.met
                  ? BigInt(planDeductible.cents) - state.met
                  : 0n,
              );
              evidence.push(
                ...bundle.deductible_evidence.map((ref) => ({
                  kind: "source_row" as const,
                  ...ref,
                })),
              );
            } else planRemaining = null;
            if (applies) {
              if (planRemaining === null)
                return unknownAll("plan_deductible_unknown");
              deductibleRemaining = planRemaining;
            } else if (planRemaining === null || cmp(planRemaining, ZERO) > 0) {
              // A tier that waives the deductible uses its pre-deductible row until the plan
              // deductible is met.
              const preRow = tierRow("pre_deductible");
              if (!preRow)
                return unknownAll(
                  planRemaining === null
                    ? "plan_deductible_unknown"
                    : "pre_deductible_row_missing",
                );
              evidence.push(
                ...preRow.evidence.map((ref) => ({
                  kind: "source_row" as const,
                  ...ref,
                })),
              );
              preDeductibleCell =
                preRow.channels.find(
                  (item) => item.channel === request.channel,
                ) ?? null;
            }
            initialCell =
              icpRow.channels.find(
                (item) => item.channel === request.channel,
              ) ?? null;
            const cell = preDeductibleCell ?? initialCell;
            const phaseKey = preDeductibleCell
              ? "pre_deductible"
              : "initial_coverage";
            const read = readCell(cell);
            if (typeof read === "string") return unknownAll(read);
            sharing = read;
            const bound = classifyBounds(
              cell!,
              planFacts,
              bounds,
              deps.bounds.amount,
            );
            evidence.push(
              ...bound.citations.map((citation) => ({
                kind: "rule" as const,
                contract_year: year,
                ...citation,
              })),
            );
            if (bound.class === "lis_range") {
              evidence.push(
                ...snp.evidence.map((ref) => ({
                  kind: "source_row" as const,
                  ...ref,
                })),
              );
              // R4: the filed cells are the subsidy range. Someone without the subsidy pays the
              // defined standard initial-coverage share, which the range never clamps.
              if (phaseKey !== "initial_coverage")
                return unknownAll("lis_range_not_no_subsidy_charge");
              sharing = deps.bounds.lisSharing(
                { kind: "coinsurance", rate: params.standardInitialShare },
                cell!,
              );
            } else if (bound.class === "greater_of")
              sharing = {
                kind: "bounded",
                inner: read,
                minimum: deps.bounds.fillMinimum(
                  bound.minimum,
                  fill.request.days_supply,
                ),
                maximum: deps.bounds.amount(cell!.maximum),
              };
            else if (bound.class !== "none" && bound.class !== "not_offered")
              return unknownAll(bound.reason);
          }
        }

        // A plan-average fill takes this reading's gross cost; a reading no file settles has none.
        let gross = fill.gross;
        let unpricedReason =
          fill.price.status === "unknown"
            ? fill.price.reason
            : "pricing_not_loaded";
        if (fill.pricing && fill.pricing.readings.length > 1) {
          const reading = fill.pricing.readings.find(
            (item) => item.key === world[priceKey(fill.request.fill_id)],
          );
          gross = reading?.gross ?? null;
          unpricedReason = fill.pricing.reason ?? FEE_UNKNOWN;
        } else if (fill.pricing && !gross)
          unpricedReason = fill.pricing.reason ?? FEE_UNKNOWN;
        // Without a price only the catastrophic phase is settled: the enrollee pays nothing there
        // (an ACIP vaccine pays nothing in any phase), so patient pay and TrOOP are known while the
        // gross cost and the payer split stay unknown.
        if (!gross) {
          const unpriced = unpricedReason;
          if (inCatastrophe)
            return finish(
              {
                status: "value",
                grossCents: 0n,
                belowThresholdCents: 0n,
                aboveThresholdCents: 0n,
                patientCents: 0n,
                troopDeltaCents: 0n,
                deductiblePaidCents: 0n,
                selectedDrugSubsidyCents: null,
                manufacturerDiscountCents: null,
                coveredPlanPaidCents: null,
                nonCoveredPlanPaidCents: null,
                planPhase: { begin: "C", end: "C" },
                standardPhase: { begin: "C", end: "C" },
                derivation: [
                  "catastrophic phase: no cost sharing whatever the price",
                ],
              },
              { gross: null, troop: state.troop, met: state.met },
              { payerDocumented: false, vaccine, unpriced },
            );
          return unknownAll(unpriced);
        }

        const result = priceClaim({
          gross,
          troop,
          planDeductibleRemaining: deductibleRemaining,
          design,
          sharing,
          special: special(insulin, vaccine),
          // A plan-average fill's maximum fair price counts only where the drug is selected.
          maximumFairPrice:
            fill.price.status === "plan_average" && cls !== "selected"
              ? null
              : fill.mfp,
          program: {
            payer: programClass.payer,
            initial,
            catastrophic: programClass.catastrophic,
          },
          params,
        });
        if (result.status === "unknown") return unknownAll(result.reason);
        // A waived tier whose deductible is deemed met mid-claim: the two rows must agree.
        if (
          preDeductibleCell &&
          initialCell &&
          deps.claim.reached(
            fromCents(state.troop + result.troopDeltaCents),
            standard,
          ) &&
          cellKey(preDeductibleCell) !== cellKey(initialCell)
        )
          return unknownAll("pre_deductible_split_unresolved");
        if (result.aboveThresholdCents > 0n || inCatastrophe)
          conflicts.push(
            ...catastrophicConflicts(
              bundle.tiers,
              bundle.conflicts,
              fill.tier,
              fill.supply!,
              request.channel,
            ),
          );
        const troopAfter = state.troop + result.troopDeltaCents;
        let met = state.met + result.deductiblePaidCents;
        if (
          planDeductible.status === "value" &&
          deps.claim.reached(fromCents(troopAfter), standard)
        )
          met =
            met > BigInt(planDeductible.cents)
              ? met
              : BigInt(planDeductible.cents);
        return finish(
          result,
          {
            gross:
              state.gross === null ? null : state.gross + result.grossCents,
            troop: troopAfter,
            met,
          },
          { payerDocumented: payerDocumented && !vaccine, vaccine },
        );
      });
    }
  };
}

const FILL_STATUS: Record<Figure["status"], FillResult["status"]> = {
  value: "estimated",
  bounded: "bounded",
  unknown: "unknown",
};
const priceKey = (fillId: string) => `price:${fillId}`;
/** The readings a bounded figure needs, in rising price order. */
const BOUNDED_READINGS: readonly PriceReadingKey[] = [
  "unit_cost",
  "lowest_fee",
  "highest_fee",
];
/** The same for a selected drug priced from its maximum fair price. */
const MFP_BOUNDED_READINGS: readonly PriceReadingKey[] = [
  "mfp_lowest_fee",
  "mfp_highest_fee",
];
/** Listing gaps come before any price: a drug the plan does not list has no plan price. */
const LISTING_BLOCKS = new Set([
  "drug_not_in_bundle",
  "not_listed",
  "supplemental_listing_only",
  "drug_evidence_unknown",
  "ambiguous_drug_product",
  "proxy_ndc_not_listed",
]);

function fillPrice(fill: ResolvedFill): FillPrice | null {
  const price = fill.price;
  const planAverage = price.status === "plan_average";
  if (!planAverage && !(price.status === "unknown" && price.basis)) return null;
  const head = {
    basis: "cms_plan_average" as const,
    unit_cost: planAverage ? price.unit_cost : null,
    quantity: planAverage ? price.quantity : null,
    quantity_basis: planAverage ? price.quantity_basis : null,
    caveat: planAverage ? price.caveat : null,
  };
  const mfp = fill.pricing?.mfp ?? null;
  let reason: string | null = null;
  if (fill.blocked && LISTING_BLOCKS.has(fill.blocked)) reason = fill.blocked;
  else if (price.status === "unknown") reason = price.reason;
  else if (!fill.pricing) reason = fill.blocked ?? "pricing_not_loaded";
  if (reason || !fill.pricing) {
    const none: Figure = {
      status: "unknown",
      cents: null,
      reason: reason ?? "pricing_not_loaded",
    };
    return {
      ...head,
      fee_set: null,
      ingredient: null,
      maximum_fair_price: null,
      readings: [],
      unit_cost_total: none,
      total_lowest_fee: none,
      total_highest_fee: none,
      gross: none,
      maximum_fair_price_total: none,
    };
  }
  return {
    ...head,
    fee_set: fill.pricing.fee_set,
    ingredient: fill.pricing.ingredient,
    maximum_fair_price: mfp
      ? {
          unit_price: mfp.unit_price,
          effective_from: mfp.effective_from,
          effective_to: mfp.effective_to,
        }
      : null,
    readings: fill.pricing.readings.map((reading) => reading.key),
    ...fill.pricing.figures,
  };
}

function special(insulin: boolean, vaccine: boolean) {
  if (vaccine) return "vaccine" as const;
  return insulin ? ("insulin" as const) : ("none" as const);
}

function insulinRow(
  rows: InsulinCost[],
  tier: number | null,
  supply: Supply,
): InsulinCost | null {
  const exact = rows.filter(
    (row) => row.tier === tier && row.supply === supply,
  );
  if (exact.length === 1) return exact[0]!;
  // A blank tier (defined standard plans) applies only when the plan files no tiered rows.
  if (rows.some((row) => row.tier !== null)) return null;
  const blank = rows.filter(
    (row) => row.tier === null && row.supply === supply,
  );
  return blank.length === 1 ? blank[0]! : null;
}

function readCell(cell: ChannelCost | null): Sharing | string {
  if (!cell) return "channel_row_missing";
  if (cell.status === "not_offered") return "channel_not_offered";
  if (cell.status === "unknown") return cell.reason ?? "cost_type_unknown";
  const amount = cell.amount;
  if (!amount || amount.status === "not_reported")
    return "cost_amount_not_reported";
  if (amount.status === "unknown") return amount.reason;
  if ("cents" in amount)
    return { kind: "copay", amount: fromCents(amount.cents) };
  return { kind: "coinsurance", rate: fromBasisPoints(amount.basis_points) };
}

const cellKey = (cell: ChannelCost) =>
  JSON.stringify([
    cell.status,
    cell.amount?.raw ?? null,
    cell.minimum.raw,
    cell.maximum.raw,
  ]);

function missingRowReason(conflicts: Conflict[], tier: number): string {
  return conflicts.some((conflict) =>
    conflict.detail.startsWith(`tier ${tier},`),
  )
    ? "cost_row_in_conflict"
    : "cost_row_missing";
}

function catastrophicNote(conflict: Conflict): ConflictNote {
  return {
    code: conflict.code,
    detail: conflict.detail,
    filed: conflict.filed ?? [],
    applied: "0",
    evidence: conflict.evidence,
  };
}

/**
 * Catastrophic cost sharing is zero under the year's rules. A plan row that files more is kept
 * as evidence with the filed amounts; it never changes what the enrollee pays.
 */
function catastrophicConflicts(
  tiers: TierCost[],
  conflicts: Conflict[],
  tier: number | null,
  supply: Supply,
  channel: SpufChannel,
): ConflictNote[] {
  const notes: ConflictNote[] = [];
  const row = tiers.find(
    (item) =>
      item.tier === tier &&
      item.phase === "catastrophic" &&
      item.supply === supply,
  );
  const filed = (row?.channels ?? []).filter(
    (cell) =>
      cell.amount?.status === "value" &&
      ("cents" in cell.amount
        ? cell.amount.cents
        : cell.amount.basis_points) !== 0,
  );
  if (row && filed.some((cell) => cell.channel === channel))
    notes.push({
      code: "catastrophic_cost_sharing_conflicts_with_rules",
      detail: `tier ${tier}, ${supply}: the plan files catastrophic cost sharing; the year's rules set none`,
      filed: filed.map((cell) => ({
        channel: cell.channel,
        raw: cell.amount!.raw,
      })),
      applied: "0",
      evidence: row.evidence,
    });
  for (const conflict of conflicts)
    if (
      conflict.code === "catastrophic_cost_sharing_conflicts_with_rules" &&
      conflict.detail.startsWith(`tier ${tier}, ${supply}:`)
    )
      notes.push(catastrophicNote(conflict));
  return notes;
}

function validate(request: EstimateRequest): string[] {
  const errors: string[] = [];
  const year = request.contract_year;
  if (!Number.isInteger(year)) errors.push("contract_year must be an integer");
  if (request.bundle.contract_year !== year)
    errors.push("bundle is for another contract year");
  const channels: SpufChannel[] = [
    "preferred_retail",
    "standard_retail",
    "preferred_mail",
    "standard_mail",
  ];
  if (!channels.includes(request.channel)) errors.push("unknown channel");
  if (!["DS", "AE", "BA", "EA", "unknown"].includes(request.benefit_type))
    errors.push("unknown benefit_type");
  const fills = request.fills;
  if (!fills.length) errors.push("fills must not be empty");
  if (fills.length > MAX_FILLS) errors.push(`at most ${MAX_FILLS} fills`);
  if (new Set(fills.map((fill) => fill.rxcui)).size > MAX_PRODUCTS)
    errors.push(`at most ${MAX_PRODUCTS} distinct products`);
  const ids = new Set<string>();
  let previous = "";
  let openingDate = `${year}-01-01`;
  if (request.opening.kind === "provided") {
    const opening = request.opening;
    const amounts = [
      opening.gross_cents,
      opening.troop_cents,
      opening.plan_deductible_met_cents,
    ];
    if (!amounts.every((value) => Number.isSafeInteger(value) && value >= 0))
      errors.push("opening amounts must be whole cents, zero or more");
    else {
      if (opening.troop_cents > opening.gross_cents)
        errors.push("opening TrOOP exceeds gross covered drug cost");
      if (opening.plan_deductible_met_cents > opening.troop_cents)
        errors.push("opening plan deductible met exceeds TrOOP");
      const bundle = request.bundle;
      if (
        bundle.status === "available" &&
        bundle.deductible.status === "value" &&
        opening.plan_deductible_met_cents > bundle.deductible.cents
      )
        errors.push("opening plan deductible met exceeds the plan deductible");
    }
    if (!validDate(opening.as_of) || !opening.as_of.startsWith(`${year}-`))
      errors.push("opening as_of must be a date in the contract year");
    openingDate = opening.as_of;
  }
  for (const fill of fills) {
    if (!fill.fill_id || ids.has(fill.fill_id))
      errors.push(`duplicate or empty fill_id ${JSON.stringify(fill.fill_id)}`);
    ids.add(fill.fill_id);
    if (!validDate(fill.date))
      errors.push(`fill ${fill.fill_id}: invalid date`);
    else if (!fill.date.startsWith(`${year}-`))
      errors.push(`fill ${fill.fill_id}: date outside the contract year`);
    else if (fill.date < openingDate)
      errors.push(`fill ${fill.fill_id}: before the opening state`);
    else if (previous && fill.date < previous)
      errors.push(`fill ${fill.fill_id}: out of date order`);
    if (validDate(fill.date)) previous = fill.date;
    if (!/^\d{1,8}$/.test(fill.rxcui))
      errors.push(`fill ${fill.fill_id}: malformed rxcui`);
    if (!Number.isInteger(fill.days_supply) || fill.days_supply < 1)
      errors.push(
        `fill ${fill.fill_id}: days_supply must be a positive integer`,
      );
    if (!parseDecimal(fill.quantity) || !fill.unit)
      errors.push(
        `fill ${fill.fill_id}: quantity needs a decimal amount and a unit`,
      );
  }
  for (const id of Object.keys(request.prices))
    if (!ids.has(id))
      errors.push(`price for unknown fill ${JSON.stringify(id)}`);
  return errors;
}

export const estimateDrugCosts = createEstimator();
