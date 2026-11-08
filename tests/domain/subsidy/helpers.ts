import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { AptcEstimate, AptcInput, SubsidyParameters } from '../../../src/domain/subsidy/index.js';

export const parameters2026: SubsidyParameters = JSON.parse(readFileSync(new URL('../../../data/subsidy/2026.json', import.meta.url), 'utf8'));
export const parameters2027: SubsidyParameters = JSON.parse(readFileSync(new URL('../../../data/subsidy/2027.json', import.meta.url), 'utf8'));
/** SYNTHETIC household and benchmark; these are worked arithmetic examples, not a real quote. */
export const alaskaExample: AptcInput = {
  householdIncome: 39_100, householdSize: 1, state: 'AK', year: 2026, slcspMonthlyCents: 60_000,
};
export function assertAlaskaExample(result: AptcEstimate): void {
  // 39,100 / HHS 2025 AK 19,550 = 200%; 39,100 × .066 = 2,580.60 → $2,581/year;
  // $2,581 / 12 = $215.083… → $215/month; $600 − $215 = $385 credit.
  assert.equal(result.status, 'estimated');
  assert.equal(result.fplPercent, 200);
  assert.equal(result.applicablePercentage, 0.066);
  assert.equal(result.annualExpectedContributionCents, 258_100);
  assert.equal(result.expectedContributionCents, 21_500);
  assert.equal(result.estimatedMonthlyCreditCents, 38_500);
}
