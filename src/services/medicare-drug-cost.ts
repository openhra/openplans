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
  FillRequest,
  Figure,
} from "../domain/medicare/part-d-cost/engine.js";
import {
  BUNDLE_VERSION,
  readBenefitBundle,
  yearRules,
} from "../domain/medicare/part-d-cost/repository.js";
import type {
  BenefitBundle,
  MoneyFigure,
  RateFigure,
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
 * field for them, and the engine gets `unknown` wherever the files are silent. No price source is
 * loaded for estimates yet, so a fill's amount is a value only where the filed benefit settles it
 * whatever the price. Everything else is unknown with its reason.
 */
export function drugCostEnabled(): boolean {
  return process.env.OPENPLANS_MEDICARE_DRUG_COST === "on";
}

export interface DrugCostDeps {
  /** The estimator switch. */
  enabled: () => boolean;
  /** The Part D serving switch the estimator also needs. */
  partD: () => boolean;
  parse: (body: unknown) => DrugCostRequest;
  /** What the engine is told about a fill's drug classes; the service never passes caller facts. */
  drugFacts: (
    fill: DrugCostRequest["fills"][number],
  ) => FillRequest["classification"];
  readBundle: typeof readBenefitBundle;
  estimate: (request: EstimateRequest) => EstimateResult;
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
  parse: parseDrugCostRequest,
  drugFacts: unknownFacts,
  readBundle: readBenefitBundle,
  estimate: estimateDrugCosts,
};

// ---------- response ----------

export type FigureOut = {
  status: "value" | "unknown";
  cents: number | null;
  reason: string | null;
  evidence_refs: string[];
};
type EvidenceOut = { id: string } & Evidence;

/** Numbers evidence items in first-use order, so the same request gives the same bytes. */
class EvidenceTable {
  private readonly ids = new Map<string, string>();
  readonly items: EvidenceOut[] = [];
  ref(item: Evidence): string {
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
    return [...new Set(items.map((item) => this.ref(item)))];
  }
}

const rowEvidence = (rows: readonly RowRef[]): Evidence[] =>
  rows.map((row) => ({ kind: "source_row", ...row }));

function figure(value: Figure, refs: string[]): FigureOut {
  return value.status === "value"
    ? { status: "value", cents: value.cents, reason: null, evidence_refs: refs }
    : {
        status: "unknown",
        cents: null,
        reason: value.reason,
        evidence_refs: refs,
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
) {
  const table = new EvidenceTable();
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
      plan_phase: fill.plan_phase,
      standard_phase: fill.standard_phase,
      before: accumulators(fill.before, refs),
      after: accumulators(fill.after, refs),
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
  return {
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
    assumptions: result.assumptions,
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
      closing: accumulators(result.totals.closing, totalRefs),
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
}
export type DrugCostEstimate =
  ReturnType<typeof project> | ReturnType<typeof closed>;

/** Every value figure cites evidence that is in the answer, and every unknown says why. */
export function estimateProvenanceProblems(answer: unknown): string[] {
  const problems: string[] = [];
  const root = answer as { evidence?: { id: string }[] };
  const ids = new Set((root.evidence ?? []).map((item) => item.id));
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
  if (/not[ _-]?covered/i.test(JSON.stringify(answer)))
    problems.push("an answer never says not covered");
  return problems;
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
  if (input.price_basis !== "none")
    return closed(head, "unsupported", "price_basis_not_supported");
  const bundle = await deps.readBundle(db, {
    plan: key,
    year,
    rxcuis: input.fills.map((fill) => fill.rxcui),
  });
  if (bundle.status !== "available")
    return closed(head, "unknown", bundle.reason, bundle.release?.as_of);
  const opening = input.opening_state;
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
    prices: {},
  });
  if (result.status === "invalid")
    return v.fail("body.fills", "INVALID_SCHEDULE");
  if (!("fills" in result))
    return closed(head, result.status, result.reason, bundle.release.as_of);
  const answer = project(head, input, bundle, result);
  const problems = estimateProvenanceProblems(answer);
  if (problems.length) throw new Error("estimate provenance incomplete");
  return answer;
}

/**
 * The estimator capability for /v1/medicare/data-availability says what it can read for a year and
 * what stays unknown. Only reported when the estimator switch is on, so the default answer keeps
 * its existing shape.
 */
export async function drugCostCapability(
  db: SqlSession,
  year: number,
  pbp: { snapshot_id: string; as_of_label: string } | undefined,
) {
  const partD = await partDStatus(db, year);
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
    pricing: { status: "unknown", reason: "pricing_not_loaded" },
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
    price_basis: ["none"],
    scenarios: ["non_lis_no_other_payer"],
    ...parts,
  };
}
