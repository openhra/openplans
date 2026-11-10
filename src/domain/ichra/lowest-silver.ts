import { lowestCostSilver, rankSilverPlans } from "../subsidy/slcsp.js";
import type {
  LcspResult,
  SlcspCandidate,
  SlcspHousehold,
} from "../subsidy/slcsp.js";

export interface LowestAgeBandLcsp {
  readonly status: LcspResult["status"];
  /** Plans tied for the lowest premium at the lowest age band. */
  readonly planIds: readonly string[];
  /** Distinct premiums of those plans at the employee's applicable age, ascending. */
  readonly pricesAtAge: readonly number[];
  /** The premium when every identified plan has the same price at the applicable age. */
  readonly lcspMonthlyCents: number | null;
  readonly ratingAreaId: string | null;
  readonly uniquePlanCount: number;
  readonly issues: readonly string[];
}

/**
 * Prop. 26 CFR 54.4980H-5(f)(7)(iii)(C): for the paragraph (f) safe harbors, the plan is the
 * lowest cost silver plan at the lowest age band, priced at the employee's applicable age.
 * Both sets must be rated over the same candidates; a plan missing at either age fails closed.
 */
export function lowestAgeBandLcsp(
  bandCandidates: readonly SlcspCandidate[],
  bandHousehold: SlcspHousehold,
  ageCandidates: readonly SlcspCandidate[],
  ageHousehold: SlcspHousehold,
): LowestAgeBandLcsp {
  const identified = lowestCostSilver(bandCandidates, bandHousehold);
  const empty = {
    planIds: [],
    pricesAtAge: [],
    lcspMonthlyCents: null,
    ratingAreaId: null,
    uniquePlanCount: 0,
  };
  if (identified.status !== "calculated")
    return { ...empty, status: identified.status, issues: identified.issues };
  const priced = rankSilverPlans(ageCandidates, ageHousehold, [
    "lcsp_self_only_premium",
  ]);
  if (priced.status !== "ranked")
    return {
      ...empty,
      status: lowestCostSilver(ageCandidates, ageHousehold).status,
      issues: priced.issues,
    };
  const bandIds = identified.ranked.map((plan) => plan.planId).sort();
  const ageIds = priced.ranked.map((plan) => plan.planId).sort();
  if (bandIds.join() !== ageIds.join())
    return {
      ...empty,
      status: "incomplete_lcsp",
      issues: ["lowest_age_band_and_applicable_age_plan_sets_differ"],
    };
  const prices = [
    ...new Set(
      identified.planIds.map(
        (id) => priced.ranked.find((plan) => plan.planId === id)!.monthlyCents,
      ),
    ),
  ].sort((a, b) => a - b);
  return {
    status: "calculated",
    planIds: identified.planIds,
    pricesAtAge: prices,
    lcspMonthlyCents: prices.length === 1 ? prices[0]! : null,
    ratingAreaId: priced.ratingAreaId,
    uniquePlanCount: priced.ranked.length,
    issues: prices.length === 1 ? [] : ["lowest_age_band_tie_prices_differ"],
  };
}
