import { parse_hios } from "../hios/index.js";
import { ageOnDate } from "../rating/index.js";
import { checkedCents, dateParts } from "../rating/rate-row.js";
import type { Household, HouseholdPremium } from "../rating/index.js";
import { QUOTE_METADATA } from "./aptc.js";

export type SilverPremiumBasis =
  | "ehb_only_no_dental_adjustment_required"
  | "lcsp_self_only_premium"
  | "requires_adjustment";
export interface SlcspCandidate {
  readonly planId: string;
  readonly metalLevel: string;
  readonly onExchange: boolean;
  /** Caller resolves county/service area, Exchange, coverage family and enrollment availability. */
  readonly availableToHousehold: boolean;
  /** Own rating engine output, rated with all tobaccoUse flags false. */
  readonly premium: HouseholdPremium;
  /**
   * Explicit attestation of what `premium` holds. The PTC benchmark accepts only the EHB portion
   * with no missing pediatric-dental adjustment; the ICHRA lowest cost silver plan accepts a
   * self-only premium on the basis its caller chose (gross or EHB portion).
   */
  readonly benchmarkBasis: SilverPremiumBasis;
}
export interface SlcspHousehold extends Household {
  /** Other policy/location combinations need a benchmark adapter, never a guessed sum. */
  readonly benchmarkScope: "single_location_single_policy" | "requires_adapter";
}
export interface SlcspResult {
  readonly status:
    | "calculated"
    | "no_silver_plans"
    | "incomplete_benchmark"
    | "ambiguous_benchmark"
    | "requires_benchmark_adjustments";
  readonly slcspMonthlyCents: number | null;
  readonly planIds: readonly string[];
  readonly uniquePlanCount: number;
  readonly issues: readonly string[];
  readonly quote_method: "puf_calculation";
  readonly bindable_quote: false;
}

export type SilverRankingStatus =
  | "ranked"
  | "no_silver_plans"
  | "incomplete"
  | "ambiguous"
  | "requires_adjustments";
export interface RankedSilverPlan {
  /** Base HIOS plan ID; CSR variants and duplicate rows of one plan are one entry. */
  readonly planId: string;
  readonly monthlyCents: number;
}
export interface SilverRanking {
  readonly status: SilverRankingStatus;
  /** Ascending by premium, then plan ID; empty unless status is ranked. */
  readonly ranked: readonly RankedSilverPlan[];
  readonly ratingAreaId: string | null;
  readonly issues: readonly string[];
}
const PTC_BENCHMARK_BASIS: readonly SilverPremiumBasis[] = [
  "ehb_only_no_dental_adjustment_required",
];

/**
 * Shared silver ranking for the PTC benchmark and the ICHRA lowest cost silver plan.
 * Duplicate input rows/CSR variants of one base HIOS plan are one plan, not extra offers
 * (26 CFR 1.36B-3(f)(1)–(3); plan identity is the existing base HIOS identity).
 * Conflicting duplicate prices fail closed. Full candidate-set completeness is caller evidence.
 */
export function rankSilverPlans(
  planCandidates: readonly SlcspCandidate[],
  household: SlcspHousehold,
  acceptedBasis: readonly SilverPremiumBasis[] = PTC_BENCHMARK_BASIS,
): SilverRanking {
  const empty = { ranked: [], ratingAreaId: null, issues: [] };
  const coverageYear = dateParts(household.coverageStartDate).year;
  if (
    !household.members.length ||
    new Set(household.members.map((member) => member.id)).size !==
      household.members.length
  ) {
    throw new RangeError(
      "A nonempty coverage family with unique member IDs is required",
    );
  }
  if (household.benchmarkScope !== "single_location_single_policy") {
    return {
      ...empty,
      status: "requires_adjustments",
      issues: ["multiple_policy_or_location_adapter_required"],
    };
  }
  const eligible = planCandidates.filter(
    (candidate) =>
      candidate.metalLevel.toLowerCase() === "silver" &&
      candidate.onExchange &&
      candidate.availableToHousehold,
  );
  if (!eligible.length) return { ...empty, status: "no_silver_plans" };
  const premiums = new Map<string, number>();
  const ratingAreas = new Set<string>();
  let ratingAreaId: string | null = null;
  for (const candidate of eligible) {
    const base = parse_hios(candidate.planId).base;
    const premium = candidate.premium;
    if (!acceptedBasis.includes(candidate.benchmarkBasis)) {
      return {
        ...empty,
        status: "requires_adjustments",
        issues: [`${base}: ehb_or_dental_adjustment_required`],
      };
    }
    if (premium.status !== "rated") {
      return {
        ...empty,
        status: "incomplete",
        issues: [`${base}: ${premium.status}`],
      };
    }
    const membersMatch =
      premium.members.length === household.members.length &&
      new Set(premium.members.map((member) => member.memberId)).size ===
        premium.members.length &&
      household.members.every((member) => {
        const rated = premium.members.find(
          (item) => item.memberId === member.id,
        );
        const age =
          member.age ??
          ageOnDate(member.dateOfBirth!, household.coverageStartDate);
        return (
          rated &&
          rated.age === age &&
          rated.relationship === member.relationship &&
          !rated.tobaccoUse
        );
      });
    if (
      parse_hios(premium.planId).base !== base ||
      premium.coverageStartDate !== household.coverageStartDate ||
      premium.ratingMethod !== household.ratingMethod ||
      !membersMatch ||
      premium.rowsUsed.some(
        (row) =>
          row.businessYear !== coverageYear ||
          row.stateCode !== base.slice(5, 7),
      )
    ) {
      return {
        ...empty,
        status: "incomplete",
        issues: [`${base}: household_or_non_tobacco_rating_mismatch`],
      };
    }
    ratingAreas.add(`${base.slice(5, 7)}:${premium.ratingAreaId}`);
    ratingAreaId = premium.ratingAreaId;
    if (ratingAreas.size > 1)
      return {
        ...empty,
        status: "incomplete",
        issues: ["mixed_rating_areas"],
      };
    checkedCents(premium.totalCents);
    const previous = premiums.get(base);
    if (previous !== undefined && previous !== premium.totalCents) {
      return {
        ...empty,
        status: "ambiguous",
        issues: [`${base}: conflicting_duplicate_prices`],
      };
    }
    premiums.set(base, premium.totalCents);
  }
  const ranked = [...premiums]
    .sort(([a, pa], [b, pb]) => pa - pb || a.localeCompare(b))
    .map(([planId, monthlyCents]) => ({ planId, monthlyCents }));
  return { status: "ranked", ranked, ratingAreaId, issues: [] };
}

/** Every plan at the selected price; tied distinct plans are all listed. */
function plansAt(ranking: SilverRanking, cents: number): string[] {
  return ranking.ranked
    .filter((plan) => plan.monthlyCents === cents)
    .map((plan) => plan.planId);
}

/**
 * IRS PTC FAQ Q25: distinct tied plans both count; a sole silver plan is the benchmark.
 * https://www.irs.gov/affordable-care-act/individuals-and-families/questions-and-answers-on-the-premium-tax-credit
 */
export function slcsp(
  planCandidates: readonly SlcspCandidate[],
  household: SlcspHousehold,
): SlcspResult {
  const ranking = rankSilverPlans(planCandidates, household);
  if (ranking.status !== "ranked")
    return {
      ...QUOTE_METADATA,
      status: SLCSP_STATUS[ranking.status],
      slcspMonthlyCents: null,
      planIds: [],
      uniquePlanCount: 0,
      issues: ranking.issues,
    };
  const ranked = ranking.ranked;
  const selected = ranked[Math.min(1, ranked.length - 1)]!.monthlyCents;
  return {
    ...QUOTE_METADATA,
    status: "calculated",
    slcspMonthlyCents: selected,
    planIds: plansAt(ranking, selected),
    uniquePlanCount: ranked.length,
    issues: [],
  };
}
const SLCSP_STATUS = {
  no_silver_plans: "no_silver_plans",
  incomplete: "incomplete_benchmark",
  ambiguous: "ambiguous_benchmark",
  requires_adjustments: "requires_benchmark_adjustments",
} as const;

export interface LcspResult {
  readonly status:
    | "calculated"
    | "no_silver_plans"
    | "incomplete_lcsp"
    | "ambiguous_lcsp"
    | "requires_premium_adjustments";
  readonly lcspMonthlyCents: number | null;
  readonly planIds: readonly string[];
  readonly uniquePlanCount: number;
  readonly ratingAreaId: string | null;
  readonly ranked: readonly RankedSilverPlan[];
  readonly issues: readonly string[];
}
const LCSP_STATUS = {
  no_silver_plans: "no_silver_plans",
  incomplete: "incomplete_lcsp",
  ambiguous: "ambiguous_lcsp",
  requires_adjustments: "requires_premium_adjustments",
} as const;

/**
 * Lowest cost silver plan for self-only coverage (26 CFR 1.36B-2(c)(5)(ii)(A)): the first plan
 * of the same ranking the benchmark uses. Candidates carry `lcsp_self_only_premium`.
 */
export function lowestCostSilver(
  planCandidates: readonly SlcspCandidate[],
  household: SlcspHousehold,
): LcspResult {
  const ranking = rankSilverPlans(planCandidates, household, [
    "lcsp_self_only_premium",
  ]);
  if (ranking.status !== "ranked")
    return {
      status: LCSP_STATUS[ranking.status],
      lcspMonthlyCents: null,
      planIds: [],
      uniquePlanCount: 0,
      ratingAreaId: null,
      ranked: [],
      issues: ranking.issues,
    };
  const lowest = ranking.ranked[0]!.monthlyCents;
  return {
    status: "calculated",
    lcspMonthlyCents: lowest,
    planIds: plansAt(ranking, lowest),
    uniquePlanCount: ranking.ranked.length,
    ratingAreaId: ranking.ratingAreaId,
    ranked: ranking.ranked,
    issues: [],
  };
}
