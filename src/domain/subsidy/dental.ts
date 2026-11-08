import { ageOnDate, selectRateRow } from '../rating/index.js';
import type { Household, RateRow } from '../rating/index.js';
import { checkedCents } from '../rating/rate-row.js';
import { parse_hios } from '../hios/index.js';

/** CMS Plan Attributes PUF dictionary: decimal fraction, including nine-place SADP filings. */
export function allocatePremium(cents: number, value: unknown): number | null {
  checkedCents(cents);
  if (typeof value !== 'string' || !/^(0(?:\.\d{1,12})?|1(?:\.0{1,12})?)$/.test(value.trim())) return null;
  const [whole, digits = ''] = value.trim().split('.');
  const denominator = 10n ** BigInt(digits.length);
  const numerator = BigInt(whole!) * denominator + BigInt(digits || '0');
  // Currency serialization: keep the filed fraction exact, round only the resulting monthly cents.
  return checkedCents(Number((2n * BigInt(cents) * numerator + denominator) / (2n * denominator)));
}

export interface DentalCandidate {
  readonly planId: string;
  /** Complete applicable on-Exchange SADP set, filtered for location/date/enrollment availability. */
  readonly rows: readonly RateRow[];
  /** EHBPediatricDentalApportionmentQuantity (percentage in PY2017 onward), never medical EHB%. */
  readonly pediatricEhbFraction: unknown;
}

/**
 * 26 CFR 1.36B-3(f)(3), (5), (8), (9) Example 3; (k)(2): rank pediatric EHB allocations,
 * not gross dental prices. https://www.ecfr.gov/current/title-26/section-1.36B-3
 * Only members under 19 contribute pediatric premiums; adult dental is not an EHB.
 * Each child's self-only rate is summed (f)(5)(ii); no medical three-child premium cap.
 */
export function pediatricDentalBenchmark(candidates: readonly DentalCandidate[], household: Household, ratingArea: string) {
  const empty = { monthlyCents: null, planIds: [] as string[], offers: [] as { planId: string; pediatricGrossCents: number; ehbCents: number }[],
    issues: [] as string[] };
  const children = household.members.filter(m => (m.age ?? ageOnDate(m.dateOfBirth!, household.coverageStartDate)) < 19);
  if (!children.length) return { ...empty, monthlyCents: 0 };
  if (!candidates.length) return { ...empty, issues: ['standalone_dental_offers_missing'] };
  const offers = new Map<string, { planId: string; pediatricGrossCents: number; ehbCents: number }>();
  for (const candidate of candidates) {
    const planId = parse_hios(candidate.planId).base;
    let gross = 0;
    for (const child of children) {
      const age = child.age ?? ageOnDate(child.dateOfBirth!, household.coverageStartDate);
      const selected = selectRateRow(candidate.rows, planId, ratingArea, age, false, household.coverageStartDate);
      if (selected.status !== 'selected' || selected.row.individualRateCents === null) {
        return { ...empty, issues: [`${planId}: pediatric_dental_rate_missing_or_unsupported`] };
      }
      gross = checkedCents(gross + selected.row.individualRateCents);
    }
    const ehbCents = allocatePremium(gross, candidate.pediatricEhbFraction);
    if (ehbCents === null) return { ...empty, issues: [`${planId}: EHBPediatricDentalApportionmentQuantity_missing_or_conflicting`] };
    const previous = offers.get(planId);
    if (previous && previous.ehbCents !== ehbCents) return { ...empty, issues: [`${planId}: conflicting_dental_prices`] };
    offers.set(planId, { planId, pediatricGrossCents: gross, ehbCents });
  }
  const ranked = [...offers.values()].sort((a, b) => a.ehbCents - b.ehbCents || a.planId.localeCompare(b.planId));
  const monthlyCents = ranked[Math.min(1, ranked.length - 1)]!.ehbCents;
  return { monthlyCents, planIds: ranked.filter(p => p.ehbCents === monthlyCents).map(p => p.planId), offers: ranked, issues: [] };
}
