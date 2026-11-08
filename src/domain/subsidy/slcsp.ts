import { parse_hios } from '../hios/index.js';
import { ageOnDate } from '../rating/index.js';
import { checkedCents, dateParts } from '../rating/rate-row.js';
import type { Household, HouseholdPremium } from '../rating/index.js';
import { QUOTE_METADATA } from './aptc.js';

export interface SlcspCandidate {
  readonly planId: string;
  readonly metalLevel: string;
  readonly onExchange: boolean;
  /** Caller resolves county/service area, Exchange, coverage family and enrollment availability. */
  readonly availableToHousehold: boolean;
  /** Own rating engine output, rated with all tobaccoUse flags false. */
  readonly premium: HouseholdPremium;
  /** Explicit attestation: no missing EHB allocation or pediatric-dental adjustment. */
  readonly benchmarkBasis: 'ehb_only_no_dental_adjustment_required' | 'requires_adjustment';
}
export interface SlcspHousehold extends Household {
  /** Other policy/location combinations need a benchmark adapter, never a guessed sum. */
  readonly benchmarkScope: 'single_location_single_policy' | 'requires_adapter';
}
export interface SlcspResult {
  readonly status: 'calculated' | 'no_silver_plans' | 'incomplete_benchmark' | 'ambiguous_benchmark' | 'requires_benchmark_adjustments';
  readonly slcspMonthlyCents: number | null;
  readonly planIds: readonly string[];
  readonly uniquePlanCount: number;
  readonly issues: readonly string[];
  readonly quote_method: 'puf_calculation';
  readonly bindable_quote: false;
}

/**
 * IRS PTC FAQ Q25: distinct tied plans both count; a sole silver plan is the benchmark.
 * https://www.irs.gov/affordable-care-act/individuals-and-families/questions-and-answers-on-the-premium-tax-credit
 * Duplicate input rows/CSR variants of one base HIOS plan are one plan, not extra offers
 * (26 CFR 1.36B-3(f)(1)–(3); plan identity is the existing base HIOS identity).
 * Conflicting duplicate prices fail closed. Full candidate-set completeness is caller evidence.
 */
export function slcsp(planCandidates: readonly SlcspCandidate[], household: SlcspHousehold): SlcspResult {
  const empty = { slcspMonthlyCents: null, planIds: [], uniquePlanCount: 0, issues: [], ...QUOTE_METADATA };
  const coverageYear = dateParts(household.coverageStartDate).year;
  if (!household.members.length || new Set(household.members.map(member => member.id)).size !== household.members.length) {
    throw new RangeError('A nonempty coverage family with unique member IDs is required');
  }
  if (household.benchmarkScope !== 'single_location_single_policy') {
    return { ...empty, status: 'requires_benchmark_adjustments', issues: ['multiple_policy_or_location_adapter_required'] };
  }
  const eligible = planCandidates.filter(candidate => candidate.metalLevel.toLowerCase() === 'silver'
    && candidate.onExchange && candidate.availableToHousehold);
  if (!eligible.length) return { ...empty, status: 'no_silver_plans' };
  const premiums = new Map<string, number>();
  const ratingAreas = new Set<string>();
  for (const candidate of eligible) {
    const base = parse_hios(candidate.planId).base;
    const premium = candidate.premium;
    if (candidate.benchmarkBasis !== 'ehb_only_no_dental_adjustment_required') {
      return { ...empty, status: 'requires_benchmark_adjustments', issues: [`${base}: ehb_or_dental_adjustment_required`] };
    }
    if (premium.status !== 'rated') {
      return { ...empty, status: 'incomplete_benchmark', issues: [`${base}: ${premium.status}`] };
    }
    const membersMatch = premium.members.length === household.members.length
      && new Set(premium.members.map(member => member.memberId)).size === premium.members.length
      && household.members.every(member => {
        const rated = premium.members.find(item => item.memberId === member.id);
        const age = member.age ?? ageOnDate(member.dateOfBirth!, household.coverageStartDate);
        return rated && rated.age === age && rated.relationship === member.relationship && !rated.tobaccoUse;
      });
    if (parse_hios(premium.planId).base !== base || premium.coverageStartDate !== household.coverageStartDate
      || premium.ratingMethod !== household.ratingMethod || !membersMatch
      || premium.rowsUsed.some(row => row.businessYear !== coverageYear || row.stateCode !== base.slice(5, 7))) {
      return { ...empty, status: 'incomplete_benchmark', issues: [`${base}: household_or_non_tobacco_rating_mismatch`] };
    }
    ratingAreas.add(`${base.slice(5, 7)}:${premium.ratingAreaId}`);
    if (ratingAreas.size > 1) return { ...empty, status: 'incomplete_benchmark', issues: ['mixed_rating_areas'] };
    checkedCents(premium.totalCents);
    const previous = premiums.get(base);
    if (previous !== undefined && previous !== premium.totalCents) {
      return { ...empty, status: 'ambiguous_benchmark', issues: [`${base}: conflicting_duplicate_prices`] };
    }
    premiums.set(base, premium.totalCents);
  }
  const ranked = [...premiums].sort(([a, pa], [b, pb]) => pa - pb || a.localeCompare(b));
  const selected = ranked[Math.min(1, ranked.length - 1)]![1];
  return { ...QUOTE_METADATA, status: 'calculated', slcspMonthlyCents: selected,
    planIds: ranked.filter(([, cents]) => cents === selected).map(([id]) => id),
    uniquePlanCount: premiums.size, issues: [] };
}
