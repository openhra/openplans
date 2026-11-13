import type { SqlSession } from "../db/database.js";
import { formatPlanKey } from "../domain/medicare/index.js";
import type { PlanKey } from "../domain/medicare/index.js";
import {
  ENGINE_VERSION,
  estimateDrugCosts,
} from "../domain/medicare/part-d-cost/engine.js";
import type {
  Accumulators,
  EstimateRequest,
  EstimateResult,
  Evidence,
  FillPrice,
  FillRequest,
  Figure,
  PriceEvidence,
} from "../domain/medicare/part-d-cost/engine.js";
import { planAveragePrice } from "../domain/medicare/part-d-cost/price.js";
import {
  BUNDLE_VERSION,
  UNIT_COST_CAVEAT,
  planAveragePricesProblem,
  readBenefitBundle,
  readDispensingFeeRanges,
  readUnitCost,
  yearRules,
} from "../domain/medicare/part-d-cost/repository.js";
import type {
  BenefitBundle,
  MoneyFigure,
  RateFigure,
  RowGroup,
  RowRef,
} from "../domain/medicare/part-d-cost/repository.js";
import { drugCostRequestSchema } from "../api/medicare-schemas.js";
import type { DrugCostRequest } from "../api/medicare-schemas.js";
import * as v from "../api/validation.js";
import { partDEnabled, partDStatus } from "./medicare-part-d.js";

/**
 * Part D drug-cost estimates for one plan and a supplied fill schedule. The estimate stays off
 * unless the operator sets OPENPLANS_MEDICARE_DRUG_COST=on, and it also needs Part D serving
 * (OPENPLANS_MEDICARE_PART_D=on). A request is personal, so the route that calls this needs the
 * personalized-estimate grant, and the schedule is never stored, cached or logged.
 *
 * Benefit type and drug classifications come only from the CMS files. The request schema has no
 * field for them, and the engine gets `unknown` wherever the files are silent. With
 * `price_basis: "none"` a fill's amount is a value only where the filed benefit settles it
 * whatever the price. `cms_plan_average` prices fills from the quarterly pricing file and the
 * dispensing-fee ranges. It has its own switch, OPENPLANS_MEDICARE_DRUG_COST_PRICES=on, off by
 * default; with it off the service refuses that basis with `price_basis_not_supported`. With it
 * on, a release whose unit costs or fee ranges are not loaded answers unknown before any fill is
 * priced.
 */
export function drugCostEnabled(): boolean {
  return process.env.OPENPLANS_MEDICARE_DRUG_COST === "on";
}
/** The plan-average price switch. It only counts while the estimator itself is on. */
export function drugCostPricingEnabled(): boolean {
  return process.env.OPENPLANS_MEDICARE_DRUG_COST_PRICES === "on";
}

export interface DrugCostDeps {
  /** The estimator switch. */
  enabled: () => boolean;
  /** The Part D serving switch the estimator also needs. */
  partD: () => boolean;
  /** The switch for `price_basis: "cms_plan_average"`. */
  pricing: () => boolean;
  /** Why the pinned release cannot price fills, or null when its prices and fees are loaded. */
  pricesProblem: typeof planAveragePricesProblem;
  readUnitCost: typeof readUnitCost;
  readFeeRanges: typeof readDispensingFeeRanges;
  parse: (body: unknown) => DrugCostRequest;
  /** What the engine is told about a fill's drug classes; the service never passes caller facts. */
  drugFacts: (
    fill: DrugCostRequest["fills"][number],
  ) => FillRequest["classification"];
  readBundle: typeof readBenefitBundle;
  estimate: (request: EstimateRequest) => EstimateResult;
  /** The evidence item that cites a group of rows sharing their values once. */
  groupEvidence: (group: RowGroup) => GroupEvidence;
  /** How an engine figure is written in the answer; replaceable only to plant test mutants. */
  figure: (value: Figure, refs: string[]) => FigureOut;
}

const unknownFacts = (): FillRequest["classification"] => ({
  insulin: "unknown",
  acip_vaccine: "unknown",
  program: "unknown",
});

/** Strict parse. Error fields name schema paths only, never values or unknown key names. */
export function parseDrugCostRequest(body: unknown): DrugCostRequest {
  const parsed = drugCostRequestSchema.safeParse(body);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0]!;
  const field = ["body", ...issue.path.map(String)].join(".");
  return v.fail(
    field,
    issue.code === "unrecognized_keys" ? "UNSUPPORTED_FIELD" : "INVALID_INPUT",
  );
}

export const drugCostDeps: DrugCostDeps = {
  enabled: drugCostEnabled,
  partD: partDEnabled,
  pricing: drugCostPricingEnabled,
  pricesProblem: planAveragePricesProblem,
  readUnitCost,
  readFeeRanges: readDispensingFeeRanges,
  parse: parseDrugCostRequest,
  drugFacts: unknownFacts,
  readBundle: readBenefitBundle,
  estimate: estimateDrugCosts,
  groupEvidence: (group) => ({ kind: "source_rows", ...group }),
  figure: figureOut,
};

// ---------- response ----------

export type FigureOut = {
  status: "value" | "bounded" | "unknown";
  cents: number | null;
  /** Only on a bounded figure: the amount lies between these, both included. */
  minimum_cents?: number;
  maximum_cents?: number;
  reason: string | null;
  evidence_refs: string[];
};
/** Rows that carry the same values in the cited fields, cited once. */
export type GroupEvidence = { kind: "source_rows" } & RowGroup;
type EvidenceOut = { id: string } & (Evidence | GroupEvidence);

const sameRows = (row: RowRef, group: RowGroup) =>
  row.snapshot_id === group.snapshot_id &&
  row.table === group.table &&
  JSON.stringify(row.fields) === JSON.stringify(group.fields);

/**
 * Numbers evidence items in first-use order, so the same request gives the same bytes. When a
 * figure cites every row of a group, such as a plan's county rows that all file the same
 * deductible, the group takes one id in place of one id per row.
 */
class EvidenceTable {
  private readonly ids = new Map<string, string>();
  readonly items: EvidenceOut[] = [];
  /** Every item a figure cited before grouping, for the coverage check. */
  readonly cited = new Map<string, Evidence>();
  constructor(
    private readonly groups: readonly RowGroup[],
    private readonly groupEvidence: DrugCostDeps["groupEvidence"],
  ) {}
  private ref(item: Evidence | GroupEvidence): string {
    const key = JSON.stringify(item);
    let id = this.ids.get(key);
    if (!id) {
      id = `e${this.items.length + 1}`;
      this.ids.set(key, id);
      this.items.push({ id, ...item });
    }
    return id;
  }
  refs(items: readonly Evidence[]): string[] {
    for (const item of items) this.cited.set(JSON.stringify(item), item);
    // A group stands in for its rows only when the figure cites all of them.
    const whole = this.groups.filter((group) => {
      const rows = new Set(
        items.flatMap((item) =>
          item.kind === "source_row" && sameRows(item, group)
            ? [item.source_row]
            : [],
        ),
      );
      return group.source_rows.every((row) => rows.has(row));
    });
    const out = new Set<string>();
    for (const item of items) {
      const group =
        item.kind === "source_row"
          ? whole.find(
              (entry) =>
                sameRows(item, entry) &&
                entry.source_rows.includes(item.source_row),
            )
          : undefined;
      out.add(this.ref(group ? this.groupEvidence(group) : item));
    }
    return [...out];
  }
}

/**
 * Every item a figure cited must be in the answer's evidence: as itself, or as a row of a group
 * with the same snapshot, table and fields.
 */
export function evidenceCoverageProblems(
  cited: Iterable<Evidence>,
  evidence: readonly EvidenceOut[],
): string[] {
  const exact = new Set<string>();
  const groups: GroupEvidence[] = [];
  for (const { id: _id, ...item } of evidence) {
    if (item.kind === "source_rows") groups.push(item);
    else exact.add(JSON.stringify(item));
  }
  const problems: string[] = [];
  for (const item of cited) {
    if (exact.has(JSON.stringify(item))) continue;
    if (
      item.kind === "source_row" &&
      groups.some(
        (group) =>
          sameRows(item, group) && group.source_rows.includes(item.source_row),
      )
    )
      continue;
    problems.push(
      item.kind === "source_row"
        ? `lost source ${item.table} row ${item.source_row}`
        : `lost ${item.kind} evidence`,
    );
  }
  return problems;
}

/** A group lists its rows once each, in order, and the value of every field it names. */
function groupProblems(item: Record<string, unknown>): string[] {
  const rows = item.source_rows;
  const fields = item.fields;
  const values = item.values as Record<string, unknown> | undefined;
  const problems: string[] = [];
  if (
    !Array.isArray(rows) ||
    !rows.length ||
    !rows.every(
      (row, i) =>
        Number.isInteger(row) &&
        (row as number) > 0 &&
        (i === 0 || (row as number) > (rows[i - 1] as number)),
    )
  )
    problems.push(`${String(item.id)}: group rows not listed in order`);
  if (
    !Array.isArray(fields) ||
    !fields.length ||
    !values ||
    typeof values !== "object" ||
    Object.keys(values).length !== fields.length ||
    !fields.every((field) => typeof values[field as string] === "string")
  )
    problems.push(`${String(item.id)}: group without its shared values`);
  return problems;
}

const rowEvidence = (rows: readonly RowRef[]): Evidence[] =>
  rows.map((row) => ({ kind: "source_row", ...row }));

/** A bounded figure keeps both ends and no single amount; it is never written as one number. */
export function figureOut(value: Figure, refs: string[]): FigureOut {
  if (value.status === "value")
    return {
      status: "value",
      cents: value.cents,
      reason: null,
      evidence_refs: refs,
    };
  if (value.status === "bounded")
    return {
      status: "bounded",
      cents: null,
      minimum_cents: value.minimum_cents,
      maximum_cents: value.maximum_cents,
      reason: value.reason,
      evidence_refs: refs,
    };
  return {
    status: "unknown",
    cents: null,
    reason: value.reason,
    evidence_refs: refs,
  };
}

const priceFigures = [
  "unit_cost_total",
  "total_lowest_fee",
  "total_highest_fee",
  "gross",
] as const;
/** A plan-average fill's price block; every figure cites the fill's evidence. */
function priceOut(
  price: FillPrice | null,
  refs: string[],
  figure: DrugCostDeps["figure"],
) {
  if (!price) return null;
  return {
    basis: price.basis,
    unit_cost: price.unit_cost,
    quantity: price.quantity,
    quantity_basis: price.quantity_basis,
    fee_set: price.fee_set,
    readings: price.readings,
    caveat: price.caveat,
    figures: Object.fromEntries(
      priceFigures.map((key) => [key, figure(price[key], refs)]),
    ) as Record<(typeof priceFigures)[number], FigureOut>,
  };
}
function moneyFigure(value: MoneyFigure, refs: string[]): FigureOut {
  if (value.status === "value")
    return {
      status: "value",
      cents: value.cents,
      reason: null,
      evidence_refs: refs,
    };
  return {
    status: "unknown",
    cents: null,
    reason: value.status === "not_reported" ? "not_reported" : value.reason,
    evidence_refs: refs,
  };
}
function filedMoney(value: MoneyFigure) {
  if (value.status === "value")
    return { status: "value" as const, cents: value.cents, raw: value.raw };
  return {
    status: "unknown" as const,
    reason: value.status === "not_reported" ? "not_reported" : value.reason,
    raw: value.raw,
  };
}
function filedRate(value: RateFigure) {
  if (value.status === "value")
    return { status: "value" as const, rate: value.rate, raw: value.raw };
  return {
    status: "unknown" as const,
    reason: value.status === "not_reported" ? "not_reported" : value.reason,
    raw: value.raw,
  };
}

function accumulators(
  value: Accumulators,
  refs: string[],
  figure: DrugCostDeps["figure"],
): Record<keyof Accumulators, FigureOut> {
  return {
    gross_covered_drug_cost: figure(value.gross_covered_drug_cost, refs),
    troop: figure(value.troop, refs),
    plan_deductible_met: figure(value.plan_deductible_met, refs),
  };
}

const fillFigures = [
  "patient_pay",
  "troop_increment",
  "gross_below_threshold",
  "gross_above_threshold",
  "selected_drug_subsidy",
  "manufacturer_discount",
  "covered_plan_paid",
  "non_covered_plan_paid",
] as const;

interface Head {
  plan_key: string;
  contract_year: number;
  bindable_quote: false;
  price_basis: DrugCostRequest["price_basis"];
  estimate_scope: "supplied_schedule";
}

/** A gated, missing or unsupported answer: no figures, one reason. */
function closed(
  head: Head,
  status: "unknown" | "unsupported",
  reason: string,
  as_of: string | null = null,
) {
  return { ...head, status, reason, as_of };
}

/** The plan-level filed evidence and annual rules, each with its sources. */
function planFigures(
  bundle: Extract<BenefitBundle, { status: "available" }>,
  table: EvidenceTable,
) {
  const rules = bundle.rules;
  const rule = (
    key: "standard_deductible" | "out_of_pocket_threshold",
  ): FigureOut => {
    if (rules.status !== "value")
      return {
        status: "unknown",
        cents: null,
        reason: rules.reason,
        evidence_refs: [],
      };
    const item = rules[key];
    return {
      status: "value",
      cents: item.cents!,
      reason: null,
      evidence_refs: table.refs(
        item.citations.map((citation) => ({
          kind: "rule",
          contract_year: bundle.contract_year,
          ...citation,
        })),
      ),
    };
  };
  return {
    plan_deductible: moneyFigure(
      bundle.deductible,
      table.refs(rowEvidence(bundle.deductible_evidence)),
    ),
    standard_deductible: rule("standard_deductible"),
    out_of_pocket_threshold: rule("out_of_pocket_threshold"),
  };
}

/** What the plan filed for this fill's tier, supply and channel; never presented as patient pay. */
function filedCostSharing(
  bundle: Extract<BenefitBundle, { status: "available" }>,
  channel: DrugCostRequest["channel"],
  tier: number | null,
  supply: string | null,
  table: EvidenceTable,
) {
  if (tier === null || supply === null) return [];
  return bundle.tiers
    .filter((row) => row.tier === tier && row.supply === supply)
    .map((row) => {
      const cell = row.channels.find((item) => item.channel === channel);
      let amount:
        ReturnType<typeof filedMoney> | ReturnType<typeof filedRate> | null =
        null;
      if (cell?.amount && cell.status === "copay")
        amount = filedMoney(cell.amount as MoneyFigure);
      else if (cell?.amount && cell.status === "coinsurance")
        amount = filedRate(cell.amount as RateFigure);
      return {
        phase: row.phase,
        deductible_applies: row.deductible_applies,
        specialty_tier: row.specialty_tier,
        type: cell?.status ?? "unknown",
        amount,
        minimum: cell ? filedMoney(cell.minimum) : null,
        maximum: cell ? filedMoney(cell.maximum) : null,
        reason: cell ? cell.reason : "channel_not_in_row",
        evidence_refs: table.refs(rowEvidence(row.evidence)),
      };
    });
}

function listing(
  bundle: Extract<BenefitBundle, { status: "available" }>,
  rxcui: string,
  proxyNdc: string | undefined,
  table: EvidenceTable,
) {
  const drug = bundle.drugs.find((item) => item.rxcui === rxcui);
  if (!drug)
    return {
      status: "unknown" as const,
      reason: "drug_not_in_bundle",
      product: "none" as const,
      packages: [],
    };
  const packages = drug.packages.filter(
    (item) => proxyNdc === undefined || item.proxy_ndc === proxyNdc,
  );
  return {
    status: drug.status,
    reason: drug.reason,
    product: drug.product,
    packages: packages.map((item) => ({
      proxy_ndc: item.proxy_ndc,
      tier: item.tier,
      prior_authorization: item.prior_authorization,
      step_therapy: item.step_therapy,
      quantity_limit: item.quantity_limit,
      quantity_limit_amount: item.quantity_limit_amount,
      quantity_limit_days: item.quantity_limit_days,
      selected_drug: item.selected_drug,
      evidence_refs: table.refs(rowEvidence([item.evidence])),
    })),
  };
}

/**
 * Turns an engine result into the HTTP answer. Every figure names its evidence by id, every
 * unknown says why, and the evidence list holds each cited row, rule and request field once.
 */
function project(
  head: Head,
  input: DrugCostRequest,
  bundle: Extract<BenefitBundle, { status: "available" }>,
  result: Extract<EstimateResult, { fills: unknown }>,
  deps: DrugCostDeps,
) {
  const table = new EvidenceTable(bundle.row_groups ?? [], deps.groupEvidence);
  const figure = deps.figure;
  const opening: Evidence[] =
    input.opening_state.kind === "provided"
      ? [{ kind: "request", field: "opening_state" }]
      : [];
  const allRefs = new Set<string>();
  const plan = planFigures(bundle, table);
  const benefitType = {
    value: result.benefit_type.value,
    origin: result.benefit_type.origin,
    reason: result.benefit_type.reason,
    evidence_refs: table.refs(result.benefit_type.evidence),
  };
  const fills = result.fills.map((fill, index) => {
    const refs = table.refs([...fill.evidence, ...opening]);
    for (const ref of refs) allRefs.add(ref);
    const request = input.fills[index]!;
    return {
      fill_id: fill.fill_id,
      date: fill.date,
      rxcui: fill.rxcui,
      status: fill.status,
      tier: fill.tier,
      supply: fill.supply,
      listing: listing(bundle, fill.rxcui, request.proxy_ndc, table),
      listing_conditions: fill.listing_conditions,
      filed_cost_sharing: filedCostSharing(
        bundle,
        input.channel,
        fill.tier,
        fill.supply,
        table,
      ),
      classification: fill.classification && {
        program: {
          options: fill.classification.program.options,
          origin: fill.classification.program.origin,
          reason: fill.classification.program.reason,
        },
        insulin: fill.classification.insulin,
        acip_vaccine: fill.classification.acip_vaccine,
      },
      figures: Object.fromEntries(
        fillFigures.map((key) => [key, figure(fill[key], refs)]),
      ) as Record<(typeof fillFigures)[number], FigureOut>,
      price: priceOut(fill.price, refs, figure),
      plan_phase: fill.plan_phase,
      standard_phase: fill.standard_phase,
      before: accumulators(fill.before, refs, figure),
      after: accumulators(fill.after, refs, figure),
      derivation: fill.derivation,
      conflicts: fill.conflicts.map((note) => ({
        code: note.code,
        detail: note.detail,
        filed: note.filed,
        applied: note.applied,
        evidence_refs: table.refs(rowEvidence(note.evidence)),
      })),
      readings: fill.readings,
    };
  });
  const totalRefs = [...allRefs];
  const subtotal = result.totals.calculable_subtotal;
  const answer = {
    ...head,
    status: result.status,
    scenario: result.scenario,
    as_of: bundle.release.as_of,
    snapshot_ids: [
      ...new Set([
        bundle.release.snapshot_id,
        ...(bundle.benefit_type?.release
          ? [bundle.benefit_type.release.snapshot_id]
          : []),
      ]),
    ],
    formulary_id: bundle.formulary_id,
    versions: {
      engine: ENGINE_VERSION,
      bundle: BUNDLE_VERSION,
      rounding: result.rounding_policy,
    },
    rules_documents: result.rules_documents,
    channel: result.channel,
    channel_verification: result.channel_verification,
    opening_origin: result.opening_origin,
    benefit_type: benefitType,
    assumptions:
      input.price_basis === "cms_plan_average"
        ? [...result.assumptions, PRICE_ASSUMPTION]
        : result.assumptions,
    gaps: [...new Set([...result.gaps, ...bundle.gaps])].sort(),
    plan_figures: plan,
    fills,
    totals: {
      patient_pay: figure(result.totals.patient_pay, totalRefs),
      // Labelled subtotal of the fills whose amount is known. It is never a lower bound on the year.
      calculable_subtotal: {
        status: "value" as const,
        cents: subtotal.cents,
        reason: null,
        evidence_refs: totalRefs,
        fills: subtotal.fills,
        complete: subtotal.complete,
      },
      closing: accumulators(result.totals.closing, totalRefs, figure),
      premiums: { status: "not_evaluated" as const },
    },
    conflicts: result.conflicts.map((note) => ({
      code: note.code,
      detail: note.detail,
      filed: note.filed,
      applied: note.applied,
      evidence_refs: table.refs(rowEvidence(note.evidence)),
    })),
    evidence: table.items,
  };
  return { answer, cited: table.cited.values() };
}
export type DrugCostEstimate =
  ReturnType<typeof project>["answer"] | ReturnType<typeof closed>;

/** The engine sets a fill's status from its patient pay; the answer must keep the two in step. */
const FILL_STATUS_OF: Record<string, string> = {
  value: "estimated",
  bounded: "bounded",
  unknown: "unknown",
};
type FigureLike = {
  status?: string;
  cents?: number | null;
  minimum_cents?: number;
  maximum_cents?: number;
};
/**
 * A plan-average gross cost is one value only when the unit cost alone and both fee readings give
 * that value; a bounded gross runs exactly from the lowest-fee total to the highest-fee total.
 */
function grossProblem(price: unknown): string | null {
  const figures = (price as { figures?: Record<string, FigureLike> } | null)
    ?.figures;
  if (!figures) return null;
  const { gross, unit_cost_total, total_lowest_fee, total_highest_fee } =
    figures;
  if (gross?.status === "value") {
    const agree = [unit_cost_total, total_lowest_fee, total_highest_fee].every(
      (item) => item?.status === "value" && item.cents === gross.cents,
    );
    return agree ? null : "gross given as one value while its readings differ";
  }
  if (
    gross?.status === "bounded" &&
    (total_lowest_fee?.cents !== gross.minimum_cents ||
      total_highest_fee?.cents !== gross.maximum_cents)
  )
    return "gross bounds differ from the fee readings";
  return null;
}
function fillStatusProblems(answer: unknown): string[] {
  const fills = (answer as { fills?: unknown }).fills;
  if (!Array.isArray(fills)) return [];
  return fills.flatMap((fill: Record<string, unknown>, i) => {
    const problems: string[] = [];
    const patient = (fill.figures as Record<string, FigureLike>)?.patient_pay;
    if (FILL_STATUS_OF[String(patient?.status)] !== fill.status)
      problems.push(
        `$.fills[${i}]: status ${String(fill.status)} disagrees with patient pay`,
      );
    const gross = grossProblem(fill.price);
    if (gross) problems.push(`$.fills[${i}].price: ${gross}`);
    return problems;
  });
}

/**
 * Every value figure cites evidence that is in the answer, every unknown says why, and a bounded
 * figure keeps its two ends with no single amount.
 */
export function estimateProvenanceProblems(answer: unknown): string[] {
  const problems: string[] = [];
  const root = answer as { evidence?: Record<string, unknown>[] };
  const ids = new Set<unknown>();
  for (const item of root.evidence ?? []) {
    if (ids.has(item.id)) problems.push(`$.evidence: ${String(item.id)} twice`);
    ids.add(item.id);
    if (item.kind === "source_rows") problems.push(...groupProblems(item));
  }
  const visit = (value: unknown, path: string) => {
    if (Array.isArray(value)) {
      value.forEach((item, i) => visit(item, `${path}[${i}]`));
      return;
    }
    if (!value || typeof value !== "object") return;
    const node = value as Record<string, unknown>;
    if ("evidence_refs" in node && "status" in node && "cents" in node) {
      const refs = node.evidence_refs as string[];
      if (node.status === "value" && !refs.length)
        problems.push(`${path}: value without evidence`);
      // A value is one exact amount; a range must never be written as one.
      if (
        node.status === "value" &&
        ("minimum_cents" in node || "maximum_cents" in node || node.reason)
      )
        problems.push(`${path}: value carries bounds or a reason`);
      if (node.status === "bounded" && node.cents !== null)
        problems.push(`${path}: bounds written as one amount`);
      if (node.status === "bounded") {
        if (!refs.length) problems.push(`${path}: bounds without evidence`);
        if (!node.reason) problems.push(`${path}: bounds without a reason`);
        const low = node.minimum_cents;
        const high = node.maximum_cents;
        if (
          !Number.isSafeInteger(low) ||
          !Number.isSafeInteger(high) ||
          (low as number) > (high as number)
        )
          problems.push(`${path}: bounds out of order`);
      }
      if (node.status === "unknown" && !node.reason)
        problems.push(`${path}: unknown without a reason`);
    }
    if (Array.isArray(node.evidence_refs))
      for (const ref of node.evidence_refs as string[])
        if (!ids.has(ref)) problems.push(`${path}: dangling ${ref}`);
    for (const [key, child] of Object.entries(node))
      if (key !== "evidence") visit(child, `${path}.${key}`);
  };
  visit(answer, "$");
  problems.push(...fillStatusProblems(answer));
  if (/not[ _-]?covered/i.test(JSON.stringify(answer)))
    problems.push("an answer never says not covered");
  return problems;
}

const PRICE_ASSUMPTION = `Prices are plan averages. ${UNIT_COST_CAVEAT} The estimate prices each fill from the unit cost alone and with the lowest and highest dispensing fee. Where those differ, an amount is a minimum and a maximum, never one value.`;

/**
 * Plan-average prices for each fill from the bundle's own release. The proxy NDC is the fill's,
 * or the only one the plan lists for the drug; a drug the plan does not list, or lists under
 * several NDCs with none chosen, gets no price.
 */
async function planAveragePrices(
  db: SqlSession,
  key: PlanKey,
  year: number,
  input: DrugCostRequest,
  bundle: Extract<BenefitBundle, { status: "available" }>,
  deps: DrugCostDeps,
): Promise<Record<string, PriceEvidence>> {
  const prices: Record<string, PriceEvidence> = {};
  for (const fill of input.fills) {
    const unknown = (reason: string): PriceEvidence => ({
      status: "unknown",
      reason,
      basis: "cms_plan_average",
    });
    const drug = bundle.drugs.find((item) => item.rxcui === fill.rxcui);
    const packages = (drug?.status === "listed" ? drug.packages : []).filter(
      (item) =>
        fill.proxy_ndc === undefined || item.proxy_ndc === fill.proxy_ndc,
    );
    if (packages.length !== 1) {
      prices[fill.fill_id] = unknown(
        packages.length ? "proxy_ndc_ambiguous" : "proxy_ndc_not_listed",
      );
      continue;
    }
    const request = {
      snapshotId: bundle.release.snapshot_id,
      year,
      plan: key,
      daysSupply: fill.days_supply,
      channel: input.channel,
    };
    const unitCost = await deps.readUnitCost(db, {
      ...request,
      ndc: packages[0]!.proxy_ndc,
      quantityUnit: fill.unit,
    });
    if (unitCost.status !== "value") {
      prices[fill.fill_id] = unknown(unitCost.reason);
      continue;
    }
    const fees = await deps.readFeeRanges(db, request);
    const price = planAveragePrice(unitCost, fees, fill.quantity);
    prices[fill.fill_id] =
      price.status === "unknown" ? unknown(price.reason) : price;
  }
  return prices;
}

/**
 * Runs one estimate. The caller has already checked the plan exists for the year. Engine schedule
 * errors become a 400 with a field name only. The service never echoes or logs the schedule.
 */
export async function drugCostEstimate(
  db: SqlSession,
  key: PlanKey,
  year: number,
  input: DrugCostRequest,
  deps: DrugCostDeps = drugCostDeps,
): Promise<DrugCostEstimate> {
  const head: Head = {
    plan_key: formatPlanKey(key),
    contract_year: year,
    bindable_quote: false,
    price_basis: input.price_basis,
    estimate_scope: "supplied_schedule",
  };
  if (!deps.partD()) return closed(head, "unknown", "pending_terms_review");
  if (!deps.enabled()) return closed(head, "unknown", "estimator_disabled");
  const planAverage = input.price_basis === "cms_plan_average";
  if (planAverage && !deps.pricing())
    return closed(head, "unsupported", "price_basis_not_supported");
  const bundle = await deps.readBundle(db, {
    plan: key,
    year,
    rxcuis: input.fills.map((fill) => fill.rxcui),
  });
  if (bundle.status !== "available")
    return closed(head, "unknown", bundle.reason, bundle.release?.as_of);
  if (planAverage) {
    // No fill is priced, and nothing is calculated, from a release without its prices and fees.
    const problem = await deps.pricesProblem(
      db,
      bundle.release.snapshot_id,
      year,
    );
    if (problem) return closed(head, "unknown", problem, bundle.release.as_of);
  }
  const opening = input.opening_state;
  const prices = planAverage
    ? await planAveragePrices(db, key, year, input, bundle, deps)
    : {};
  const result = deps.estimate({
    contract_year: year,
    scenario: input.scenario,
    // The PBP filing decides. The engine reads it from the bundle, never from the caller.
    benefit_type: "unknown",
    bundle,
    channel: input.channel,
    opening:
      opening.kind === "provided"
        ? {
            kind: "provided",
            as_of: opening.as_of,
            gross_cents: opening.gross_covered_drug_cost_cents,
            troop_cents: opening.troop_cents,
            plan_deductible_met_cents: opening.plan_deductible_met_cents,
          }
        : { kind: "new_calendar_year" },
    fills: input.fills.map((fill) => ({
      fill_id: fill.fill_id,
      date: fill.date,
      rxcui: fill.rxcui,
      ...(fill.proxy_ndc === undefined ? {} : { proxy_ndc: fill.proxy_ndc }),
      days_supply: fill.days_supply,
      quantity: fill.quantity,
      unit: fill.unit,
      classification: deps.drugFacts(fill),
    })),
    prices,
  });
  if (result.status === "invalid")
    return v.fail("body.fills", "INVALID_SCHEDULE");
  if (!("fills" in result))
    return closed(head, result.status, result.reason, bundle.release.as_of);
  const { answer, cited } = project(head, input, bundle, result, deps);
  const problems = [
    ...estimateProvenanceProblems(answer),
    ...evidenceCoverageProblems(cited, answer.evidence),
  ];
  if (problems.length) throw new Error("estimate provenance incomplete");
  return answer;
}

/** Whether the year's Part D release has plan-average prices and fees, and whether they are served. */
async function pricingCapability(
  db: SqlSession,
  year: number,
  partD: Awaited<ReturnType<typeof partDStatus>>,
  deps: Pick<DrugCostDeps, "pricing" | "pricesProblem">,
) {
  const served = deps.pricing() ? ("on" as const) : ("off" as const);
  if (partD.status !== "available" || !partD.snapshot_id)
    return {
      status: "unknown" as const,
      reason: partD.reason ?? "pending_terms_review",
      switch: served,
    };
  const problem = await deps.pricesProblem(db, partD.snapshot_id, year);
  return problem
    ? { status: "unknown" as const, reason: problem, switch: served }
    : {
        status: "available" as const,
        snapshot_id: partD.snapshot_id,
        as_of: partD.as_of,
        switch: served,
      };
}

/**
 * The estimator capability for /v1/medicare/data-availability says what it can read for a year and
 * what stays unknown. Only reported when the estimator switch is on, so the default answer keeps
 * its existing shape. `cms_plan_average` is listed only while its own switch is on and the year's
 * prices and fees are loaded.
 */
export async function drugCostCapability(
  db: SqlSession,
  year: number,
  pbp: { snapshot_id: string; as_of_label: string } | undefined,
  deps: Pick<DrugCostDeps, "pricing" | "pricesProblem"> = drugCostDeps,
) {
  const partD = await partDStatus(db, year);
  const pricing = await pricingCapability(db, year, partD, deps);
  const rules = yearRules(year);
  const parts = {
    benefit_evidence: partD,
    benefit_mapping: pbp
      ? {
          status: "available",
          as_of: pbp.as_of_label,
          snapshot_id: pbp.snapshot_id,
        }
      : { status: "unknown", reason: "pbp_not_loaded" },
    rules:
      rules.status === "value"
        ? { status: "available", documents: rules.documents.length }
        : { status: "unknown", reason: rules.reason },
    drug_classification: {
      selected_drug: "formulary_flag",
      insulin: "unknown",
      acip_vaccine: "unknown",
      applicable_drug: "unknown",
    },
    terminology: { status: "unknown", reason: "drug_names_not_in_estimate" },
    pricing,
    pharmacy_network: {
      status: "unknown",
      reason: "pharmacy_network_not_verified",
    },
  };
  let reason: string | null = null;
  if (partD.status !== "available")
    reason = partD.reason ?? "pending_terms_review";
  else if (rules.status !== "value") reason = rules.reason;
  return {
    status: reason ? "unknown" : "available",
    ...(reason ? { reason } : {}),
    access: "personalized_estimate_grant",
    price_basis:
      pricing.switch === "on" && pricing.status === "available"
        ? ["none", "cms_plan_average"]
        : ["none"],
    scenarios: ["non_lis_no_other_payer"],
    ...parts,
  };
}
