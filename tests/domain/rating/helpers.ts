import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseRateRow } from '../../../src/domain/rating/index.js';
import type { CmsRateRow, Household, HouseholdPremium, RateRow } from '../../../src/domain/rating/index.js';

interface Fixture {
  sourceFile: string;
  sourceSha256: string;
  planIds: string[];
  rows: { sourceRowNumber: number; raw: CmsRateRow }[];
}
export const fixture: Fixture = JSON.parse(readFileSync(new URL('../../fixtures/rating/tx-2026-area-10.json', import.meta.url), 'utf8'));
export const rows = fixture.rows.map(({ raw, sourceRowNumber }) => parseRateRow(raw, {
  snapshotId: `sha256:${fixture.sourceSha256}`, sourceFile: fixture.sourceFile, sourceRowNumber,
}));
export const PLAN = '20069TX0100006';
export const AREA = 'Rating Area 10';
export const DATE = '2026-01-01';

export function rowFor(age: RateRow['age']): RateRow {
  const row = rows.find(row => row.planId === PLAN && row.age === age);
  assert.ok(row, `Fixture must contain ${PLAN} age ${age}`);
  return row;
}

/** All overridden rows represent SYNTHETIC scenarios, never source evidence. */
export function syntheticRow(overrides: Partial<CmsRateRow> = {}, age: RateRow['age'] = 35): RateRow {
  return parseRateRow({ ...rowFor(age).raw, ...overrides }, {
    snapshotId: 'synthetic-rating-test', sourceFile: 'synthetic.csv', sourceRowNumber: 2,
  });
}

/** SYNTHETIC household; every price comes from the real fixture. Deliberately unsorted. */
export const fourChildren: Household = {
  coverageStartDate: DATE, ratingMethod: 'per_member', members: [
    { id: 'adult1', age: 35, relationship: 'subscriber', tobaccoUse: false },
    { id: 'youngest', age: 10, relationship: 'child', tobaccoUse: false },
    { id: 'middle1', age: 18, relationship: 'child', tobaccoUse: false },
    { id: 'adult2', age: 40, relationship: 'spouse', tobaccoUse: false },
    { id: 'eldest', age: 20, relationship: 'child', tobaccoUse: false },
    { id: 'middle2', age: 15, relationship: 'child', tobaccoUse: false },
  ],
};

/** Shared by the real-engine test and the all-children source mutant. */
export function assertFourChildPremium(result: HouseholdPremium): void {
  assert.equal(result.status, 'rated');
  // Published adult 35 + adult 40 + child 20 + child 18 + child 15; child 10 waived.
  assert.equal(result.totalCents, 72_549 + 75_874 + 57_588 + 54_204 + 49_455);
  assert.deepEqual(result.members.filter(member => member.charged).map(member => member.memberId),
    ['adult1', 'middle1', 'adult2', 'eldest', 'middle2']);
  assert.deepEqual(result.members.find(member => member.memberId === 'youngest'), {
    memberId: 'youngest', age: 10, relationship: 'child', tobaccoUse: false,
    charged: false, status: 'not_charged', premiumCents: 0, rateRows: [],
  });
}
