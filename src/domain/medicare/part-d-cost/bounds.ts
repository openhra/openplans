import { readFileSync } from "node:fs";
import type { Sharing } from "./claim.js";
import type { Rational } from "./decimal.js";
import { fromCents } from "./decimal.js";
import type { Citation } from "./program-rules.js";
import type { ChannelCost, Flag, MoneyFigure } from "./repository.js";

/**
 * Reading of the Beneficiary Cost file's COST_MIN_AMT and COST_MAX_AMT cells. The record layouts
 * (C1, C2) only label them minimum and maximum cost sharing. The rules below come from the PBP
 * data dictionary's tier cost-share structures and benefit types, and from the low-income subsidy
 * copays in Table V-2 of the Rate Announcement (C5). Each rule names its source.
 *
 * - R0: cost type 0 means the channel is not offered; its bounds are ignored.
 * - R1: a minimum of 0 and a maximum of 0 mean no bound.
 * - R2: coinsurance with a positive minimum and a zero maximum, on a plan that is not defined
 *   standard, is the "greater of coinsurance and copayment" structure: the charge per fill is the
 *   larger of the coinsurance and the minimum. The minimum is not prorated.
 * - R3: a positive maximum with a zero minimum would be "lesser of"; no plan files it, so it
 *   stays unknown.
 * - R4: on a defined standard special needs plan the bounds are the low-income subsidy copay
 *   range. They are not a charge for someone without the subsidy, and are never used to clamp one.
 * - R5: any other combination is unknown.
 */

export type BoundClass =
  | { rule: "R0"; class: "not_offered"; citations: Citation[] }
  | { rule: "R1"; class: "none"; citations: Citation[] }
  | {
      rule: "R2";
      class: "greater_of";
      minimum: Rational;
      citations: Citation[];
    }
  | {
      rule: "R3";
      class: "lesser_of";
      reason: "bound_class_unrecognised";
      citations: Citation[];
    }
  | { rule: "R4"; class: "lis_range"; citations: Citation[] }
  | {
      rule: "R5";
      class: "unrecognised";
      reason: "bound_class_unrecognised";
      citations: Citation[];
    }
  /** A fact the rules need is missing: the benefit type, the SNP status or a readable bound. */
  | { rule: null; class: "unsettled"; reason: string; citations: Citation[] };

export interface BoundRules {
  contract_year: number;
  greater_of: Citation[];
  lesser_of: Citation[];
  defined_standard: Citation[];
  special_needs_plan: Citation[];
  /** Allowed [minimum, maximum] pairs in cents; a zero minimum is the institutional $0 level. */
  lis_ranges: { minimum: number[]; maximum: number }[];
  lis_citations: Citation[];
}

export interface PlanFacts {
  /** True for a defined standard benefit; "unknown" when the caller does not know. */
  defined_standard: Flag;
  /** True for any SNP type (codes 1, 2 and 3 of the plan file). */
  special_needs_plan: Flag;
}

/** A filed bound as an amount, or null when there is none. Zero is no bound (R1). */
export type BoundAmount = (bound: MoneyFigure) => Rational | null;
export const boundAmount: BoundAmount = (bound) =>
  bound.status === "value" && bound.cents > 0 ? fromCents(bound.cents) : null;

const centsOf = (bound: MoneyFigure) =>
  bound.status === "value" ? bound.cents : 0;

/** Classifies one channel's filed bounds under R0-R5. Pure: no I/O, no arithmetic on prices. */
export function classifyBounds(
  cell: ChannelCost,
  plan: PlanFacts,
  rules: BoundRules | null,
  amount: BoundAmount = boundAmount,
): BoundClass {
  if (cell.status === "not_offered")
    return { rule: "R0", class: "not_offered", citations: [] };
  for (const bound of [cell.minimum, cell.maximum])
    if (bound.status === "unknown")
      return {
        rule: null,
        class: "unsettled",
        reason: bound.reason,
        citations: [],
      };
  const low = amount(cell.minimum);
  const high = amount(cell.maximum);
  if (!low && !high) return { rule: "R1", class: "none", citations: [] };
  if (!rules)
    return {
      rule: null,
      class: "unsettled",
      reason: "bound_rules_not_loaded",
      citations: [],
    };
  if (plan.defined_standard === "unknown")
    return {
      rule: null,
      class: "unsettled",
      reason: "benefit_type_unknown",
      citations: [],
    };
  if (plan.defined_standard) {
    if (plan.special_needs_plan === "unknown")
      return {
        rule: null,
        class: "unsettled",
        reason: "special_needs_plan_unknown",
        citations: rules.special_needs_plan,
      };
    const lo = centsOf(cell.minimum);
    const hi = centsOf(cell.maximum);
    const lis =
      plan.special_needs_plan &&
      rules.lis_ranges.some(
        (range) => range.maximum === hi && range.minimum.includes(lo),
      );
    if (lis)
      return {
        rule: "R4",
        class: "lis_range",
        citations: [
          ...rules.defined_standard,
          ...rules.special_needs_plan,
          ...rules.lis_citations,
        ],
      };
    return {
      rule: "R5",
      class: "unrecognised",
      reason: "bound_class_unrecognised",
      citations: [],
    };
  }
  if (cell.status === "coinsurance" && low && !high)
    return {
      rule: "R2",
      class: "greater_of",
      minimum: low,
      citations: [...rules.greater_of, ...rules.defined_standard],
    };
  if (cell.status === "coinsurance" && high && !low)
    return {
      rule: "R3",
      class: "lesser_of",
      reason: "bound_class_unrecognised",
      citations: rules.lesser_of,
    };
  return {
    rule: "R5",
    class: "unrecognised",
    reason: "bound_class_unrecognised",
    citations: [],
  };
}

/** How the engine applies a recognised class. Separate so tests can plant faulty readings. */
export interface BoundDeps {
  rules: (year: number) => BoundRules | null;
  amount: BoundAmount;
  /** R2: the minimum charged on one fill; per fill, never prorated by days supply. */
  fillMinimum: (minimum: Rational, daysSupply: number) => Rational;
  /** R4: the charge for someone without the subsidy; the LIS range never clamps it. */
  lisSharing: (standard: Sharing, cell: ChannelCost) => Sharing;
}

// ---------- reviewed rule file ----------

interface FileCitation extends Citation {
  quote: string;
}
interface BoundFile {
  schemaVersion: number;
  years: Record<
    string,
    {
      greaterOf: { code: string; citations: FileCitation[] };
      lesserOf: { code: string; citations: FileCitation[] };
      definedStandard: { code: string; citations: FileCitation[] };
      specialNeedsPlan: { citations: FileCitation[] };
      lisMaximumCopays: {
        genericUpTo100FplCents: number;
        otherUpTo100FplCents: number;
        genericAbove100FplCents: number;
        otherAbove100FplCents: number;
        citations: FileCitation[];
      };
    }
  >;
}
let fileCache: BoundFile | null = null;
export function loadBoundFile(): BoundFile {
  fileCache ??= JSON.parse(
    readFileSync(
      new URL(
        "../../../../data/medicare-part-d/cost-bounds.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as BoundFile;
  return fileCache;
}

const cite = (items: FileCitation[]): Citation[] =>
  items.map(({ quote: _quote, ...citation }) => citation);

/** The reviewed bound rules for 2026 and 2027 (data/medicare-part-d/cost-bounds.json). */
export function boundRules(
  year: number,
  file = loadBoundFile(),
): BoundRules | null {
  const entry = file.years[String(year)];
  if (!entry) return null;
  const lis = entry.lisMaximumCopays;
  return {
    contract_year: year,
    greater_of: cite(entry.greaterOf.citations),
    lesser_of: cite(entry.lesserOf.citations),
    defined_standard: cite(entry.definedStandard.citations),
    special_needs_plan: cite(entry.specialNeedsPlan.citations),
    lis_ranges: [
      {
        minimum: [0, lis.genericUpTo100FplCents],
        maximum: lis.genericAbove100FplCents,
      },
      {
        minimum: [0, lis.otherUpTo100FplCents],
        maximum: lis.otherAbove100FplCents,
      },
    ],
    lis_citations: cite(lis.citations),
  };
}

export const boundDeps: BoundDeps = {
  rules: boundRules,
  amount: boundAmount,
  fillMinimum: (minimum) => minimum,
  lisSharing: (standard) => standard,
};

/**
 * Pinned documents an estimate can cite beyond the year's rules: the bound rules' PBP dictionaries
 * and the CMS drug lists the classification checks. Feeds the estimate's document list.
 */
export function boundDocuments(): {
  id: string;
  url: string;
  sha256: string;
}[] {
  const read = (name: string) =>
    (
      JSON.parse(
        readFileSync(
          new URL(`../../../../data/medicare-part-d/${name}`, import.meta.url),
          "utf8",
        ),
      ) as { documents: { id: string; url: string; sha256: string }[] }
    ).documents.map(({ id, url, sha256 }) => ({ id, url, sha256 }));
  documentCache ??= [
    ...read("documents.json"),
    ...read("pbp-documents.json"),
    ...read("drug-lists.json"),
  ];
  return documentCache;
}
let documentCache: { id: string; url: string; sha256: string }[] | null = null;
