import { expect, it } from 'vitest';
import { dentalFamilyColumn, dentalPremium, dentalRatingRule, parseRateRow } from '../../../src/domain/rating/index.js';
import type { Household, RateRow } from '../../../src/domain/rating/index.js';
import { AREA, DATE, PLAN, fourChildren, rows, syntheticRow } from './helpers.js';

// Explicitly synthetic dental rules/tiers, derived from the real medical cut only for domain testing.
const business = [{ source_row: 2, raw: { AgeDeterminationRule: 'Age on effective date', MaximumUnderageDependent: '3',
  DependentMaximumAgRule: '25', CohabitationRule: 'Self,Yes;Spouse,No;Child,No' } }];
const ageRows = rows.filter(r => r.planId === PLAN).map(r => ({ ...r, tobacco: 'No Preference' as const, individualTobaccoRateCents: null }));
const tier = syntheticRow({ Age: 'Family Option', Tobacco: 'No Preference', IndividualRate: '10', IndividualTobaccoRate: '',
  Couple: '20', PrimarySubscriberAndOneDependent: '30', PrimarySubscriberAndTwoDependents: '40',
  PrimarySubscriberAndThreeOrMoreDependents: '50', CoupleAndOneDependent: '60', CoupleAndTwoDependents: '70', CoupleAndThreeOrMoreDependents: '80' });
function household(children: number, spouse = false): Household {
  return { coverageStartDate: DATE, ratingMethod: 'family_tier', members: [
    { id: 's', age: 35, relationship: 'subscriber', tobaccoUse: false },
    ...(spouse ? [{ id: 'p', age: 36, relationship: 'spouse' as const, tobaccoUse: true }] : []),
    ...Array.from({ length: children }, (_, i) => ({ id: `c${i}`, age: 10 + i, relationship: 'child' as const, tobaccoUse: false })),
  ] };
}
const price = (r: readonly RateRow[], h: Household, state = 'TX', b = business) => dentalPremium(r, PLAN, AREA, h, state, b);

it('maps every dictionary family column by subscriber, spouse and declared dependent count, including 3+', () => {
  const expected = [['IndividualRate','PrimarySubscriberAndOneDependent','PrimarySubscriberAndTwoDependents','PrimarySubscriberAndThreeOrMoreDependents'],
    ['Couple','CoupleAndOneDependent','CoupleAndTwoDependents','CoupleAndThreeOrMoreDependents']];
  for (const spouse of [false,true]) for (const count of [0,1,2,3,4,10]) {
    const h = household(count, spouse), column = expected[Number(spouse)]![Math.min(3,count)]!;
    expect(dentalFamilyColumn(h)).toEqual({ column });
    expect(price([tier], h)).toMatchObject({ status: 'rated', filedColumn: column,
      totalCents: (spouse ? [2000,6000,7000,8000] : [1000,3000,4000,5000])[Math.min(3,count)], members: [] });
  }
});
it('uses filed child cap and No Preference individual rates without changing medical defaults', () => {
  const h = { ...fourChildren, members: fourChildren.members.map(m => ({ ...m, tobaccoUse: true })) };
  expect(price(ageRows,h)).toMatchObject({ status: 'rated', totalCents: 309670 });
  const rules = [{ source_row: 2, raw: { ...business[0]!.raw, MaximumUnderageDependent: '2' } }];
  const result = price(ageRows,h,'TX',rules);
  expect(result).toMatchObject({ status: 'rated', totalCents: 260215 });
  expect(result.members.filter(m => !m.charged).map(m => m.memberId)).toEqual(['youngest','middle2']);
});
it('preserves date, duplicate, missing and unknown failures without partial totals', () => {
  const h = household(0);
  // NH files leave Tobacco blank on Family Option; the column still defines a contract total.
  expect(price([parseRateRow({ ...tier.raw, Tobacco: '' }, tier.provenance)],household(2))).toMatchObject({ status:'rated',totalCents:4000 });
  expect(price([parseRateRow({ ...tier.raw, Tobacco: 'Tobacco User/Non-Tobacco User' }, tier.provenance)],h)).toMatchObject({ status:'unsupported_rating_method',totalCents:null });
  expect(price([tier,tier],h)).toMatchObject({ status: 'ambiguous', totalCents: null });
  expect(price([tier],{ ...h, coverageStartDate: '2027-01-01' })).toMatchObject({ status: 'missing', totalCents: null });
  expect(price([parseRateRow({ ...tier.raw, Couple: '' }, tier.provenance)],household(0,true))).toMatchObject({ status: 'unknown', totalCents: null });
  expect(price([tier],h,'TX',[])).toMatchObject({ status: 'unsupported_rating_method', totalCents: null });
});
it('rejects unproved household membership, required cohabitation, adult dependent extension and mixed shapes', () => {
  for (const h of [
    { ...household(0), members: [{ id: 'o', age: 40, relationship: 'other' as const, tobaccoUse: false }] },
    { ...household(0), members: [{ id: 's', age: 10, relationship: 'subscriber' as const, tobaccoUse: false }] },
    { ...household(1), members: household(1).members.map(m => m.relationship === 'child' ? { ...m, age: 26, dateOfBirth: undefined } : m) },
  ]) expect(price([tier],h)).toMatchObject({ status: 'unsupported_rating_method', totalCents: null });
  expect(price([tier],household(1),'TX',[{ source_row: 2, raw: { ...business[0]!.raw, CohabitationRule: 'Self,Yes;Child,Yes' } }])).toMatchObject({ status: 'unsupported_rating_method' });
  expect(price([tier,...ageRows],household(0))).toMatchObject({ status: 'unsupported_rating_method', totalCents: null });
});
it('NY/VT dental cannot acquire federal pricing even from a deliberately mislabelled row', () => {
  for (const state of ['NY','VT']) {
    expect(dentalRatingRule(state,2026,'Individual')).toBeNull();
    expect(price([{ ...tier,stateCode:state }],household(2),state)).toMatchObject({ status: 'unsupported_rating_method', totalCents: null });
  }
});
