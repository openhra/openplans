import { householdMembers, householdPremium } from './household.js';
import { applicableRows } from './rate-row.js';
import type { FAMILY_RATE_FIELDS, Household, HouseholdPremium, RateRow } from './types.js';

export const DENTAL_REFERENCES = {
  exceptedBenefits: 'https://www.ecfr.gov/current/title-45/section-148.220',
  medicalRating: 'https://www.ecfr.gov/current/title-45/section-147.102',
  dentalRating: 'https://www.govinfo.gov/content/pkg/CFR-2025-title45-vol2/pdf/CFR-2025-title45-vol2-sec156-210.pdf',
  rateDictionary: 'https://www.cms.gov/files/document/rate-ratadictionary-py27.pdf',
  businessDictionary: 'https://www.cms.gov/files/document/businessrules-datadictionary-py27.pdf',
  attributeDictionary: 'https://www.cms.gov/files/document/planattributes-datadictionary-py27.pdf',
} as const;

/** Explicit publication scope, separately versioned from individual medical state policy. */
const STATES: Record<number, readonly string[]> = {
  2026: 'AK AL AR AZ DE FL HI IA IN KS LA MI MO MS MT NC ND NE NH OH OK OR SC SD TN TX UT WI WV WY'.split(' '),
  2027: 'AK AL AR AZ DE FL HI IA IN KS LA MI MO MS MT NC ND NE NH OH OK SC SD TN TX UT WI WV WY'.split(' '),
};
export function dentalRatingRule(state: string, year: number, market: string) {
  if (market !== 'Individual' || !STATES[year]?.includes(state)) return null;
  return { version: 'sadp-filed-v1', state, plan_year: year, market, coverage: 'dental' as const,
    method: 'filed_age_or_family_option', reviewed_on: '2026-11-07',
    citation: '45 CFR 148.220(b)(1): excepted limited-scope dental is exempt from Part 147; 156.210(d): age at issuance/renewal, guaranteed SADP rates. CMS Rate PUF dictionary pp. 4, 6–8; Business Rules dictionary pp. 5–6, 8.',
    references: Object.values(DENTAL_REFERENCES) };
}

export type DentalColumn = 'IndividualRate' | typeof FAMILY_RATE_FIELDS[number];
export interface DentalBusinessRule {
  readonly raw: Readonly<Record<string, string>>;
  readonly source_row: number;
}

/** Children here mean the applicant's declared child dependents; other relationships are unproved. */
export function dentalFamilyColumn(household: Household): { column: DentalColumn } | { reason: string } {
  const aged = householdMembers(household);
  const subscribers = aged.filter(m => m.member.relationship === 'subscriber');
  const spouses = aged.filter(m => m.member.relationship === 'spouse');
  if (subscribers.length !== 1 || spouses.length > 1 || aged.some(m => m.member.relationship === 'other')) {
    return { reason: 'FAMILY_OPTION_MEMBERSHIP_NOT_DEFINED_FOR_HOUSEHOLD' };
  }
  if (subscribers[0]!.age < 18 || spouses.some(m => m.age < 18)) return { reason: 'FAMILY_OPTION_MINOR_SUBSCRIBER_MEMBERSHIP_UNPROVED' };
  const dependents = aged.filter(m => m.member.relationship === 'child').length;
  if (!dependents) return { column: spouses.length ? 'Couple' : 'IndividualRate' };
  const suffix = dependents === 1 ? 'OneDependent' : dependents === 2 ? 'TwoDependents' : 'ThreeOrMoreDependents';
  return { column: `${spouses.length ? 'Couple' : 'PrimarySubscriber'}And${suffix}` as DentalColumn };
}

/** No medical rate curve, tobacco fallback or automatic federal three-child policy enters SADP pricing. */
export function dentalPremium(rows: readonly RateRow[], plan: string, area: string, household: Household,
  state: string, rules: readonly DentalBusinessRule[], market = 'Individual'): HouseholdPremium & { filedColumn?: DentalColumn } {
  const aged = householdMembers(household);
  const applicable = applicableRows(rows, plan, area, household.coverageStartDate);
  const trace = { planId: plan, ratingAreaId: area, coverageStartDate: household.coverageStartDate,
    ratingMethod: household.ratingMethod, currency: 'USD' as const, period: 'month' as const, members: [], rowsUsed: applicable };
  const failure = (status: 'unsupported_rating_method' | 'missing' | 'ambiguous' | 'unknown', reason: string) =>
    ({ ...trace, status, totalCents: null, issues: [{ memberId: null, status, reason, rateRows: applicable }] } as HouseholdPremium);
  if (!dentalRatingRule(state, Number(household.coverageStartDate.slice(0, 4)), market)) {
    return failure('unsupported_rating_method', 'NO_APPLICABLE_DENTAL_RULE');
  }
  if (applicable.some(row => row.stateCode !== state)) return failure('unsupported_rating_method', 'DENTAL_STATE_SCOPE_MISMATCH');
  if (!applicable.length) return failure('missing', 'DENTAL_RATE_MISSING');
  // The importer preserves plan-level rules. Missing/conflicting evidence never inherits medical policy.
  const agreed = (field: string) => {
    const values = new Set(rules.map(r => r.raw[field]));
    return rules.length && values.size === 1 ? [...values][0] : undefined;
  };
  if (agreed('AgeDeterminationRule') !== 'Age on effective date') return failure('unsupported_rating_method', 'DENTAL_AGE_DETERMINATION_UNPROVED');
  const children = aged.filter(m => m.member.relationship === 'child');
  if (children.length) {
    const maximumAge = agreed('DependentMaximumAgRule');
    if (!maximumAge || !/^\d+$/.test(maximumAge) || children.some(m => m.age > Number(maximumAge))) {
      return failure('unsupported_rating_method', 'DENTAL_DEPENDENT_AGE_MEMBERSHIP_UNPROVED');
    }
  }
  // Cohabitation-required relationships cannot be established by this API's household input.
  for (const relationship of new Set(aged.map(m => m.member.relationship))) {
    const name = { subscriber: 'Self', spouse: 'Spouse', child: 'Child', other: null }[relationship];
    if (!name || rules.some(r => !r.raw.CohabitationRule?.split(';').includes(`${name},${name === 'Self' ? 'Yes' : 'No'}`))) {
      return failure('unsupported_rating_method', 'DENTAL_RELATIONSHIP_OR_COHABITATION_UNPROVED');
    }
  }
  const family = applicable.filter(row => row.age === 'Family Option' && row.ratingMethod === 'family_tier');
  if (family.length) {
    if (family.length !== applicable.length) return failure('unsupported_rating_method', 'MIXED_DENTAL_RATING_METHODS');
    // Family columns are contract totals; IndividualTobaccoRate is defined only for age rows.
    // Published NH Family Option rows leave Tobacco blank. That is not a missing age-row price.
    if (family.some(r => r.tobacco === 'Tobacco User/Non-Tobacco User' || r.individualTobaccoRateCents !== null)) {
      return failure('unsupported_rating_method', 'FAMILY_OPTION_TOBACCO_MEMBERSHIP_UNPROVED');
    }
    const mapping = dentalFamilyColumn(household);
    if ('reason' in mapping) return failure('unsupported_rating_method', mapping.reason);
    if (family.length !== 1) return failure('ambiguous', 'MULTIPLE_DENTAL_FAMILY_ROWS');
    const row = family[0]!;
    const price = mapping.column === 'IndividualRate' ? row.individualRateCents : row.familyRatesCents[mapping.column];
    if (price === null) return failure('unknown', `MISSING_FILED_DENTAL_COLUMN:${mapping.column}`);
    return { ...trace, ratingMethod: 'family_tier', status: 'rated', totalCents: price, issues: [], filedColumn: mapping.column };
  }
  const capText = agreed('MaximumUnderageDependent');
  if (!capText || !/^[123]$/.test(capText)) return failure('unsupported_rating_method', 'DENTAL_CHILD_RATING_LIMIT_UNPROVED');
  return householdPremium(rows, plan, area, { ...household, ratingMethod: 'per_member' },
    { maximumRatedChildren: Number(capText), noPreferenceUsesIndividual: true });
}
