import type { SqlSession } from "@openplans/plugin-sdk";

/**
 * How an SBC item compares with the federal cost-sharing tables (the plan attributes and the
 * benefits and cost-sharing PUF of the active catalog) for one plan variant.
 */
export type CheckStatus =
  | "agrees"
  | "conflicting"
  | "puf_absent"
  | "not_compared"
  | "no_puf_counterpart";

/** A network cost as both sources print it: a copay in dollars and a coinsurance percentage. */
export interface Cost {
  copay: number;
  coinsurance: number;
}

/** SBC chart labels with exactly one counterpart among the PUF's benefit names. */
export const PUF_BENEFIT: Readonly<Record<string, string>> = Object.freeze({
  "Primary care visit to treat an injury or illness":
    "Primary Care Visit to Treat an Injury or Illness",
  "Specialist visit": "Specialist Visit",
  "Preventive care/screening/immunization":
    "Preventive Care/Screening/Immunization",
  "Imaging (CT/PET scans, MRIs)": "Imaging (CT/PET Scans, MRIs)",
  "Generic drugs": "Generic Drugs",
  "Preferred brand drugs": "Preferred Brand Drugs",
  "Non-preferred brand drugs": "Non-Preferred Brand Drugs",
  "Specialty drugs": "Specialty Drugs",
  "Facility fee (e.g., ambulatory surgery center)":
    "Outpatient Facility Fee (e.g., Ambulatory Surgery Center)",
  "Emergency room care": "Emergency Room Services",
  "Emergency medical transportation": "Emergency Transportation/Ambulance",
  "Urgent care": "Urgent Care Centers or Facilities",
  "Facility fee (e.g., hospital room)":
    "Inpatient Hospital Services (e.g., Hospital Stay)",
  "Home health care": "Home Health Care Services",
  "Rehabilitation services": "Outpatient Rehabilitation Services",
  "Habilitation services": "Habilitation Services",
  "Skilled nursing care": "Skilled Nursing Facility",
  "Durable medical equipment": "Durable Medical Equipment",
  "Hospice services": "Hospice Services",
  "Children's eye exam": "Routine Eye Exam for Children",
  "Children's glasses": "Eye Glasses for Children",
  "Children's dental check-up": "Dental Check-Up for Children",
});

/** The Important Questions checked against plan attributes, and the attribute columns they read. */
export const PUF_QUESTION: Readonly<
  Record<string, { individual: string[]; family: string[] }>
> = Object.freeze({
  "What is the overall deductible?": {
    individual: ["TEHBDedInnTier1Individual", "MEHBDedInnTier1Individual"],
    family: ["TEHBDedInnTier1FamilyPerGroup", "MEHBDedInnTier1FamilyPerGroup"],
  },
  "What is the out-of-pocket limit for this plan?": {
    individual: ["TEHBInnTier1IndividualMOOP", "MEHBInnTier1IndividualMOOP"],
    family: [
      "TEHBInnTier1FamilyPerGroupMOOP",
      "MEHBInnTier1FamilyPerGroupMOOP",
    ],
  },
});

const MONEY = /\$\s?([\d,]+(?:\.\d{1,2})?)/g;
const PERCENT = /(\d+(?:\.\d+)?)\s?%/g;
const NOT_APPLICABLE = /^\s*(?:not applicable)?\s*$/i;
const FREE = /\bno charge\b/i;

const amounts = (text: string, pattern: RegExp) =>
  [...text.matchAll(pattern)].map((m) => Number(m[1]!.replace(/,/g, "")));

/**
 * The network cost an SBC cell states, or null when it is not one plain cost: more than one
 * dollar amount or percentage, a labelled part ("Office visit: ...", "Tier 1: ..."), "Not covered",
 * or no cost at all. "No charge" is a zero cost.
 */
export function sbcCost(text: string): Cost | null {
  // "Office visit: $60 ... Surgery: 20%" or "Tier 1: $10": several costs, not one.
  if (/\bnot covered\b/i.test(text) || text.includes(":")) return null;
  const copays = amounts(text, MONEY);
  const percents = amounts(text, PERCENT);
  if (copays.length > 1 || percents.length > 1) return null;
  if (!copays.length && !percents.length)
    return FREE.test(text) ? { copay: 0, coinsurance: 0 } : null;
  return { copay: copays[0] ?? 0, coinsurance: percents[0] ?? 0 };
}

/**
 * The network cost of a PUF benefit row (`CopayInnTier1`, `CoinsInnTier1`), or null when neither
 * cell holds a value. "Not Applicable" is no amount; "No Charge" is zero.
 */
export function pufCost(
  copay: string | null,
  coins: string | null,
): Cost | null {
  const read = (cell: string | null, pattern: RegExp) => {
    if (cell === null || NOT_APPLICABLE.test(cell)) return null;
    if (FREE.test(cell)) return 0;
    const found = amounts(cell, pattern);
    return found.length === 1 ? found[0]! : undefined;
  };
  const c = read(copay, MONEY);
  const p = read(coins, PERCENT);
  if (c === undefined || p === undefined) return null;
  if (c === null && p === null) return null;
  return { copay: c ?? 0, coinsurance: p ?? 0 };
}

const formatCost = (cost: Cost) =>
  `copay $${cost.copay}, coinsurance ${cost.coinsurance}%`;

/** The individual and family amounts an answer states ("$1,500/individual or $3,000/family"). */
export function answerAmounts(text: string): number[] {
  return amounts(text, MONEY);
}

/** The PUF variant's cost-sharing as the comparison needs it. */
export interface PufCostSharing {
  /** False when the variant has no row in the active catalog's plan attributes. */
  attributes: boolean;
  /** Attribute column → published text, for the PUF_QUESTION columns. */
  columns: Record<string, string>;
  /** Benefit name → network copay and coinsurance texts. */
  benefits: Map<string, { copay: string | null; coins: string | null }>;
}

/** The variant's plan attributes and benefit rows in the active catalog for the year. */
export async function pufCostSharing(
  db: SqlSession,
  variantPlanId: string,
  planYear: number,
): Promise<PufCostSharing> {
  const state = variantPlanId.slice(5, 7);
  const attributes = await db.query<{ raw: Record<string, string> }>(
    `SELECT v.raw FROM plan_variant v
     JOIN puf_import_file f ON f.snapshot_id = v.snapshot_id AND f.kind = 'plan-attributes'
     JOIN puf_active_catalog a ON a.import_id = f.import_id AND a.state = v.state AND a.plan_year = v.plan_year
     WHERE v.variant_plan_id = $1 AND v.plan_year = $2 AND v.state = $3`,
    [variantPlanId, planYear, state],
  );
  const benefits = await db.query<{
    benefit_name: string;
    copay: string | null;
    coins: string | null;
  }>(
    `SELECT b.benefit_name, b.cost_sharing_raw->>'CopayInnTier1' AS copay,
            b.cost_sharing_raw->>'CoinsInnTier1' AS coins
     FROM plan_benefit b
     JOIN puf_import_file f ON f.snapshot_id = b.snapshot_id AND f.kind = 'benefits-and-cost-sharing'
     JOIN puf_active_catalog a ON a.import_id = f.import_id AND a.state = b.state AND a.plan_year = b.plan_year
     WHERE b.published_plan_id = $1 AND b.plan_year = $2 AND b.state = $3`,
    [variantPlanId, planYear, state],
  );
  const raw = attributes.rows[0]?.raw ?? {};
  const wanted = Object.values(PUF_QUESTION).flatMap((q) => [
    ...q.individual,
    ...q.family,
  ]);
  return {
    attributes: attributes.rows.length > 0,
    columns: Object.fromEntries(
      wanted
        .filter((key) => raw[key]?.trim())
        .map((key) => [key, raw[key]!.trim()]),
    ),
    benefits: new Map(
      benefits.rows.map((row) => [
        row.benefit_name,
        { copay: row.copay, coins: row.coins },
      ]),
    ),
  };
}

export interface ItemCheck {
  status: CheckStatus;
  pufBenefit: string | null;
  pufValue: string | null;
}

/** One SBC item (a question or a chart row) as the extractor kept it. */
export interface SbcItem {
  section: "question" | "chart";
  label: string | null;
  subLabel: string | null;
  network: string;
}

/**
 * Compare one SBC item with the variant's PUF values. Only questions and chart rows with one PUF
 * counterpart are compared; a carrier sub-row ("Preferred generic") is never checked against the
 * PUF's single row. Disagreement is `conflicting`, never resolved for either side.
 */
export function checkItem(item: SbcItem, puf: PufCostSharing): ItemCheck {
  if (item.section === "question") {
    const columns = item.label ? PUF_QUESTION[item.label] : undefined;
    if (!columns)
      return { status: "no_puf_counterpart", pufBenefit: null, pufValue: null };
    // The first column that states an amount ("Not Applicable" states none).
    const first = (keys: string[]) =>
      keys
        .map((key) => puf.columns[key])
        .find((text) => text && answerAmounts(text).length) ?? null;
    const individual = first(columns.individual);
    const family = first(columns.family);
    if (individual === null && family === null)
      return { status: "puf_absent", pufBenefit: item.label, pufValue: null };
    const pufValue = [individual, family].filter(Boolean).join(" | ");
    const stated = answerAmounts(item.network);
    const published = [individual, family].map((text) =>
      text === null ? null : (answerAmounts(text)[0] ?? null),
    );
    if (stated.length !== 2 || published.includes(null))
      return { status: "not_compared", pufBenefit: item.label, pufValue };
    const agrees = stated[0] === published[0] && stated[1] === published[1];
    return {
      status: agrees ? "agrees" : "conflicting",
      pufBenefit: item.label,
      pufValue,
    };
  }
  const benefit =
    item.label && !item.subLabel ? PUF_BENEFIT[item.label] : undefined;
  if (!benefit)
    return { status: "no_puf_counterpart", pufBenefit: null, pufValue: null };
  const row = puf.benefits.get(benefit);
  const published = row ? pufCost(row.copay, row.coins) : null;
  if (!published)
    return { status: "puf_absent", pufBenefit: benefit, pufValue: null };
  const pufValue = formatCost(published);
  const stated = sbcCost(item.network);
  if (!stated) return { status: "not_compared", pufBenefit: benefit, pufValue };
  const agrees =
    stated.copay === published.copay &&
    stated.coinsurance === published.coinsurance;
  return {
    status: agrees ? "agrees" : "conflicting",
    pufBenefit: benefit,
    pufValue,
  };
}

/** True when the PUF holds any cost-sharing for the variant: benefit rows or the questions' columns. */
export function pufHasCostSharing(puf: PufCostSharing): boolean {
  return puf.benefits.size > 0 || Object.keys(puf.columns).length > 0;
}
