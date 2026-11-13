/**
 * Unknown and refusal reason codes that more than one surface can produce, with the form each
 * surface gives them. This list is the single source of truth: the compatibility API translates
 * native codes through `compatReasonGap`, the MCP output schemas list the codes in their field
 * descriptions, and `tests/api/reason-codes.test.ts` checks every surface and doc against it.
 */
export type ReasonSurface = "native" | "compat" | "mcp";

export interface ReasonCode {
  readonly code: string;
  /** What the answer cannot say, and why. */
  readonly situation: string;
  /** Where the native REST API puts the code. */
  readonly native: string;
  /**
   * The `x-openplans-gaps` entry the compatibility API adds, or null when the compatibility API
   * has no route that can reach the situation.
   */
  readonly compat: string | null;
  /** Where the MCP tools put the code. */
  readonly mcp: string;
  /** The public doc that explains the code, relative to the openplans folder. */
  readonly doc: string;
}

export const REASON_CODES: readonly ReasonCode[] = [
  {
    code: "location_requires_zip",
    situation:
      "A county-only request where a plan serves part of the county or a rating area splits it",
    native: "subsidy.status, subsidy_status, benchmark status, ICHRA status",
    compat: "subsidy_location_requires_zip",
    mcp: "quote_premiums subsidy_status; check_ichra_affordability status (envelope ambiguous)",
    doc: "src/api/README.md",
  },
  {
    code: "zip_limited_service_area",
    situation:
      "A county-only request where a plan serves only some of the county's ZIP codes",
    native:
      "subsidy.reason, benchmark issues, ICHRA reason, plan search and quote issues",
    compat: "zip_limited_service_area",
    mcp: "quote_premiums subsidy.reason; check_ichra_affordability reason; search_plans and quote_plans location_issues",
    doc: "src/api/README.md",
  },
  {
    code: "zip_not_in_loaded_geography",
    situation: "The ZIP has no row in the loaded geography",
    native: "subsidy.reason, benchmark issues",
    compat: "zip_not_in_loaded_geography",
    mcp: "quote_premiums subsidy.reason and benchmark issues",
    doc: "src/api/README.md",
  },
  {
    code: "state_catalog_not_loaded",
    situation:
      "A county whose state has no active catalog for the plan year, including a New York or Vermont county whose filed state rate catalog is not loaded",
    native: "subsidy.reason, benchmark issues, plan search and quote issues",
    compat: "state_catalog_not_loaded",
    mcp: "quote_premiums subsidy.reason and benchmark issues; search_plans and quote_plans location_issues",
    doc: "src/api/README.md",
  },
  {
    code: "template_saved_before_submission",
    situation:
      "A New York approved-rates template was refused, so that issuer's plans have no price",
    native:
      "ICHRA reason, data-availability ichra_reason, plan search and quote issues",
    compat: "template_saved_before_submission",
    mcp: "check_ichra_affordability reason; get_data_status ichra_reason; search_plans and quote_plans location_issues",
    doc: "docs/ichra.md",
  },
  {
    code: "pricing_not_loaded",
    situation:
      "A plan-average Medicare estimate whose release has no pricing table",
    native: "drug-cost estimate reason and figure reasons",
    compat: null,
    mcp: "estimate_medicare_drug_costs reason and figure reasons",
    doc: "docs/medicare.md",
  },
  {
    code: "dispensing_fees_not_loaded",
    situation:
      "A plan-average Medicare estimate whose release has no dispensing fee ranges",
    native: "drug-cost estimate reason",
    compat: null,
    mcp: "estimate_medicare_drug_costs reason",
    doc: "docs/medicare.md",
  },
  {
    code: "dispensing_fee_unknown",
    situation:
      "A Medicare fill amount that depends on a dispensing fee the files do not settle; bounded figures carry it",
    native: "figure reasons (unknown and bounded)",
    compat: null,
    mcp: "estimate_medicare_drug_costs figure reasons",
    doc: "docs/medicare.md",
  },
  {
    code: "maximum_fair_price_not_in_effect",
    situation:
      "A selected Medicare drug with no maximum fair price in effect on the fill date",
    native: "figure reasons",
    compat: null,
    mcp: "estimate_medicare_drug_costs figure reasons",
    doc: "docs/medicare.md",
  },
];

/** Why a code has no compatibility form. */
export const COMPAT_NOT_EXPOSED =
  "The compatibility API has no Medicare routes.";

const COMPAT_GAPS: ReadonlyMap<string, string> = new Map(
  REASON_CODES.flatMap((entry) =>
    entry.compat === null ? [] : [[entry.code, entry.compat] as const],
  ),
);

/** The compatibility gap for a native reason code, or undefined when it has none. */
export function compatReasonGap(code: string): string | undefined {
  return COMPAT_GAPS.get(code);
}

const CODES: ReadonlySet<string> = new Set(REASON_CODES.map((e) => e.code));
/** True for a code in this list; a plan-scoped issue such as `<plan>: <code>` is not one. */
export function isReasonCode(value: string): boolean {
  return CODES.has(value);
}

/** The codes one MCP field can carry, as a sentence for its schema description. */
export function reasonCodeList(codes: readonly string[]): string {
  return `Known reason codes include ${codes.map((c) => `\`${c}\``).join(", ")}.`;
}

export const LOCATION_REASON_CODES = [
  "location_requires_zip",
  "zip_limited_service_area",
  "zip_not_in_loaded_geography",
  "state_catalog_not_loaded",
] as const;
export const MEDICARE_REASON_CODES = [
  "pricing_not_loaded",
  "dispensing_fees_not_loaded",
  "dispensing_fee_unknown",
  "maximum_fair_price_not_in_effect",
] as const;
