import { canonicalEstimateOutput } from '../mcp/canonical-estimate.js';
import { assertHonest } from '../../src/mcp/schemas.js';
import { estimatePremiums } from '../../src/services/catalog.js';
import assert from 'node:assert/strict';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/api/app.js';
import { householdSubsidy } from '../../src/api/subsidies.js';
import { premiumRequest } from '../../src/api/validation.js';
import * as subsidyDomain from '../../src/domain/subsidy/index.js';
import type { SqlSession } from '../../src/db/database.js';
import { setup, TOKEN, headers, searchBody } from '../compat/v1/helpers.js';

// SYNTHETIC household, real CMS Harris source cuts reused from the facade suite.
let h: Awaited<ReturnType<typeof setup>>;
beforeAll(async () => { h = await setup(); });
afterAll(async () => { await h?.close(); });
const body = (extra = {}) => ({ plan_ids: ['87226TX0100013'], zip: '77002', coverage_start: '2026-01-01',
  members: [{ age: 40, tobacco: false, relationship: 'subscriber' }],
  household_income_annual: 31_300, household_size: 1, tax_filing: 'single', ...extra });
const nativeHeaders = { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` };
async function quote(payload = body(), db: SqlSession = h.db) {
  const response = await createApp(db, { premiumToken: TOKEN }).request('/v1/premium-estimates', {
    method: 'POST', headers: nativeHeaders, body: JSON.stringify(payload),
  });
  return { response, json: await response.json() as any };
}
async function benchmark(query = 'zip=77002&year=2026&ages=40', db: SqlSession = h.db) {
  const response = await createApp(db, { premiumToken: TOKEN }).request(`/v1/benchmark?${query}`, { headers: nativeHeaders });
  return { response, json: await response.json() as any };
}
async function rollback(run: (tx: SqlSession) => Promise<void>) {
  const marker = new Error('synthetic subsidy mutation rollback');
  await expect(h.db.transaction(async tx => { await run(tx); throw marker; })).rejects.toBe(marker);
}
function assertWorkedExample(result: any) {
  assert.equal(result.total_cents, 55_354, 'gross stays the published age-40 $553.54');
  // Lowest silver: $614.43 × filed EHB fraction .9631 = $591.757533 → $591.76.
  // Second silver: $592.05 × 1 = $592.05. Distinct base plans, no CSR selection.
  assert.equal(result.slcsp_monthly_cents, 59_205, 'second-lowest silver household benchmark');
  // $31,300 / $15,650 = 200% FPL. Applicable percentage = 6.60%.
  // $31,300 × .066 = $2,065.80 → $2,066 annual; /12 → $172 monthly.
  // $592.05 - $172 = $420.05 credit; $553.54 - $420.05 = $133.49 net.
  assert.equal(result.subsidy.fpl_percent, 200);
  assert.equal(result.subsidy.applicable_percentage, .066);
  assert.equal(result.subsidy.expected_contribution_annual_cents, 206_600);
  assert.equal(result.subsidy.expected_contribution_monthly_cents, 17_200);
  assert.equal(result.estimated_monthly_tax_credit_cents, 42_005, 'worked credit');
  assert.equal(result.estimated_net_monthly_cents, 13_349, 'worked net');
}

describe('native subsidy and benchmark wiring', () => {
  it('shows the Harris age-40 single 200% FPL calculation step by step', async () => {
    const { response, json } = await quote();
    expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
    assertWorkedExample(json.estimates[0]);
    expect(json.estimates[0]).toMatchObject({ status: 'rated', subsidy_status: 'estimated',
      quote_method: 'puf_calculation', bindable_quote: false, csr_eligibility_status: 'not_evaluated' });
    expect(json.estimates[0]).not.toHaveProperty('csr_eligible');
    const b = await benchmark();
    expect(b.response.status).toBe(200); expect(b.response.headers.get('cache-control')).toBe('no-store');
    expect(b.json).toMatchObject({ status: 'calculated', slcsp_monthly_cents: 59_205, rating_area_id: 'Rating Area 10',
      benchmark_plan_ids: ['87226TX0100011'], lowest_silver_plans: [
        { plan_id: '87226TX0140004', gross_monthly_cents: 61_443, ehb_monthly_cents: 59_176, ehb_fraction: '0.9631' },
        { plan_id: '87226TX0100011', gross_monthly_cents: 59_205, ehb_monthly_cents: 59_205, ehb_fraction: '1' },
      ] });
    expect(b.json.lowest_silver_plans[0].provenance.ehb_attribute_rows.length).toBeGreaterThan(0);
    expect((await benchmark('county=48201&year=2026&ages=40')).json.slcsp_monthly_cents).toBe(59_205);
  });

  it('maps the exact >400% cliff to over_income_limit and keeps net equal to gross', async () => {
    for (const income of [62_600.01, 90_000]) {
      const result = (await quote(body({ household_income_annual: income }))).json.estimates[0];
      expect(result).toMatchObject({ subsidy_status: 'over_income_limit', slcsp_monthly_cents: 59_205,
        estimated_monthly_tax_credit_cents: 0, estimated_net_monthly_cents: 55_354 });
    }
    expect((await quote(body({ household_income_annual: 62_600 }))).json.estimates[0].subsidy_status).toBe('estimated');
  });

  it('rates smokers gross as filed while keeping the benchmark tobacco-free', async () => {
    const result = (await quote(body({ members: [{ age: 40, tobacco: true, relationship: 'subscriber' }] }))).json.estimates[0];
    expect(result.slcsp_monthly_cents).toBe(59_205);
    expect(result.total_cents).toBeGreaterThan(55_354);
    expect(result.estimated_monthly_tax_credit_cents).toBe(42_005);
  });

  it('uses all silver offers, not the requested plans, and retains explicit variant identity', async () => {
    const result = (await quote(body({ plan_ids: ['87226TX0100013-00', '87226TX0100011', '20069TX0100006'] }))).json;
    expect(result.estimates).toHaveLength(3);
    expect(result.estimates.every((e: any) => e.slcsp_monthly_cents === 59_205)).toBe(true);
    expect(result.estimates[0].plan_id).toBe('87226TX0100013-00');
  });

  it('missing rate for any silver member blocks the benchmark, even for an unrequested expensive plan', async () => {
    await rollback(async tx => {
      await tx.query(`DELETE FROM rate WHERE base_plan_id='20069TX0100025' AND age_band='40'`);
      const result = (await quote(body(), tx)).json.estimates[0];
      expect(result).toMatchObject({ status: 'rated', subsidy_status: 'incomplete_benchmark', total_cents: 55_354,
        slcsp_monthly_cents: null, estimated_monthly_tax_credit_cents: null, estimated_net_monthly_cents: null });
      expect(result.subsidy.benchmark.issues).toContain('20069TX0100025: missing');
    });
  });

  it('NY is unsupported before any catalog fallback; no benchmark or credit escapes', async () => {
    const result = await benchmark('county=36061&year=2026&ages=40');
    expect(result.json).toMatchObject({ status: 'unsupported_rating_method', slcsp_monthly_cents: null, lowest_silver_plans: [] });
    // A TX requested plan in a NY household must not borrow the TX benchmark.
    const q = (await quote(body({ zip: undefined, county: '36061' }))).json.estimates[0];
    expect(q.slcsp_monthly_cents).toBeNull(); expect(q.estimated_monthly_tax_credit_cents).toBeNull();
    expect(q.subsidy.benchmark.status).toBe('unsupported_rating_method');
    expect(q.subsidy_status).toBe('unsupported_rating_method');
  });

  it('leaves state review, filing review, unknown parameters and pediatric adjustments explicitly unresolved', async () => {
    for (const [extra, status] of [
      [{ household_income_annual: 20_000 }, 'requires_state_rules'],
      [{ tax_filing: undefined }, 'requires_tax_filing_review'],
      [{ tax_filing: 'married_filing_separately' }, 'requires_tax_filing_review'],
      [{ household_size: 2, members: [{ age: 40, tobacco: false, relationship: 'subscriber' },
        { age: 10, tobacco: false, relationship: 'child' }] }, 'requires_benchmark_adjustments'],
    ] as const) {
      const q = (await quote(body(extra))).json.estimates[0];
      expect(q.subsidy_status).toBe(status); expect(q.estimated_monthly_tax_credit_cents).toBeNull();
    }
    expect((await benchmark('zip=75034&year=2026&ages=40')).json.status).toBe('ambiguous');
    expect((await benchmark('zip=77001&year=2026&ages=40')).json.status).toBe('unknown');
  });

  it('unknown parameter years keep credit null, and missing plan years return 404', async () => {
    const request = premiumRequest(body({ zip: undefined, county: '48201', coverage_start: '2028-01-01' }));
    expect(await householdSubsidy(h.db, request, { status: 'available', county: '48201', counties: [] }))
      .toMatchObject({ status: 'parameters_unconfirmed', estimated_monthly_tax_credit_cents: null });
    expect((await quote(body({ coverage_start: '2028-01-01' }))).response.status).toBe(404);
  });

  it('rates the complete adult coverage family independently of tax family size', async () => {
    const q = (await quote(body({ household_size: 2, household_income_annual: 42_300,
      members: [{ age: 40, tobacco: false, relationship: 'subscriber' },
        { age: 40, tobacco: false, relationship: 'spouse' }], tax_filing: 'married_filing_jointly' }))).json.estimates[0];
    expect(q).toMatchObject({ total_cents: 110_708, slcsp_monthly_cents: 118_410,
      estimated_monthly_tax_credit_cents: 95_110, estimated_net_monthly_cents: 15_598,
      subsidy: { fpl_percent: 200, expected_contribution_annual_cents: 279_200, expected_contribution_monthly_cents: 23_300 } });
  });

  it('never applies a credit to an off-exchange or catastrophic plan', async () => {
    for (const mutation of ["on_exchange=false", "metal='Catastrophic'"]) await rollback(async tx => {
      // SYNTHETIC eligibility mutation of only the selected gold plan; silver is unchanged.
      await tx.exec(`UPDATE plan SET ${mutation} WHERE base_plan_id='87226TX0100013'`);
      expect((await quote(body(), tx)).json.estimates[0]).toMatchObject({ total_cents: 55_354,
        subsidy_status: 'plan_ineligible_for_tax_credit', estimated_monthly_tax_credit_cents: null, estimated_net_monthly_cents: null });
    });
  });

  it('an unloaded catalog is unknown, rather than evidence that no silver plans exist', async () => {
    await rollback(async tx => {
      await tx.exec("DELETE FROM puf_active_catalog WHERE state='TX' AND plan_year=2026");
      expect((await benchmark('zip=77002&year=2026&ages=40', tx)).json).toMatchObject({
        status: 'unknown', slcsp_monthly_cents: null, issues: ['catalog_not_loaded'] });
    });
  });

  it('unknown EHB allocation fails closed instead of assuming all gross is EHB', async () => {
    await rollback(async tx => {
      await tx.exec(`UPDATE plan_attribute SET raw=raw-'EHBPercentTotalPremium' WHERE base_plan_id='87226TX0140004'`);
      expect((await quote(body(), tx)).json.estimates[0]).toMatchObject({ subsidy_status: 'requires_benchmark_adjustments',
        slcsp_monthly_cents: null, estimated_monthly_tax_credit_cents: null });
    });
  });

  it('caps the applied credit at gross', async () => {
    await rollback(async tx => {
      // SYNTHETIC $100 selected gold rate; source fixture stays untouched. Silver is unchanged.
      await tx.exec(`UPDATE rate SET individual_rate_cents=10000 WHERE base_plan_id='87226TX0100013' AND age_band='40'`);
      const q = (await quote(body(), tx)).json.estimates[0];
      expect(q).toMatchObject({ total_cents: 10_000, estimated_monthly_tax_credit_cents: 10_000, estimated_net_monthly_cents: 0 });
      expect(q.subsidy.estimated_monthly_tax_credit_cents).toBe(42_005);
    });
  });

  it('caps credit at the enrollment EHB premium; non-EHB benefits remain payable', async () => {
    await rollback(async tx => {
      // SYNTHETIC selected gold $100 gross, 90% EHB. Silver benchmark unchanged.
      await tx.exec(`UPDATE rate SET individual_rate_cents=10000 WHERE base_plan_id='87226TX0100013' AND age_band='40'`);
      await tx.exec(`UPDATE plan_attribute SET raw=raw || '{"EHBPercentTotalPremium":"0.9"}'::jsonb WHERE base_plan_id='87226TX0100013'`);
      expect((await quote(body(), tx)).json.estimates[0]).toMatchObject({ total_cents: 10000,
        estimated_monthly_tax_credit_cents: 9000, estimated_net_monthly_cents: 1000,
        subsidy: { enrollment_ehb_monthly_cents: 9000 } });
    });
  });

  it('missing enrollment EHB fraction keeps the gross quote and null applied credit', async () => {
    await rollback(async tx => {
      await tx.exec(`UPDATE plan_attribute SET raw=raw-'EHBPercentTotalPremium' WHERE base_plan_id='87226TX0100013'`);
      expect((await quote(body(), tx)).json.estimates[0]).toMatchObject({ total_cents: 55354,
        estimated_monthly_tax_credit_cents: null, estimated_net_monthly_cents: null,
        subsidy_status: 'requires_premium_adjustments' });
    });
  });

  it('negative control: lowest-silver selector fails the same hand-computed HTTP assertion', async () => {
    const original = subsidyDomain.slcsp;
    const spy = vi.spyOn(subsidyDomain, 'slcsp').mockImplementation((candidates, household) => {
      const result = original(candidates, household);
      const lowest = Math.min(...candidates.filter(c => c.premium.status === 'rated').map(c => c.premium.totalCents!));
      return { ...result, slcspMonthlyCents: lowest };
    });
    try {
      const q = (await quote()).json.estimates[0];
      expect(q.slcsp_monthly_cents).toBe(59_176);
      expect(() => assertWorkedExample(q)).toThrow('second-lowest silver household benchmark');
    } finally { spy.mockRestore(); }
  });

  it('negative control: removing the credit cap fails the applied-credit assertion', async () => {
    const spy = vi.spyOn(subsidyDomain, 'netPremium').mockImplementation((gross, credit) => ({
      grossMonthlyPremiumCents: gross, estimatedMonthlyCreditCents: credit, estimatedNetMonthlyPremiumCents: gross - credit,
      quote_method: 'puf_calculation', bindable_quote: false,
    }));
    try {
      await rollback(async tx => {
        await tx.exec(`UPDATE rate SET individual_rate_cents=10000 WHERE base_plan_id='87226TX0100013' AND age_band='40'`);
        const q = (await quote(body(), tx)).json.estimates[0];
        expect(q.estimated_monthly_tax_credit_cents).toBe(42_005);
        expect(q.estimated_net_monthly_cents).toBe(-32_005);
        expect(() => assert.equal(q.estimated_monthly_tax_credit_cents, q.total_cents, 'credit must be capped at gross')).toThrow('credit must be capped at gross');
      });
    } finally { spy.mockRestore(); }
  });

  it('validates subsidy inputs, benchmark ages and location, requires auth and bounds requests', async () => {
    for (const extra of [{ household_income_annual: -1 }, { household_income_annual: 31_300.001 },
      { household_income_annual: '31300' }, { household_size: 0 }, { household_size: 101 }, { tax_filing: true },
      { household_size: undefined }]) expect((await quote(body(extra))).response.status).toBe(400);
    for (const query of ['zip=77002&year=2026', 'zip=77002&year=2026&ages=-1', 'zip=77002&year=2026&ages=121',
      'zip=77002&year=2026&ages=40,', 'zip=77002&ages=40', 'year=2026&ages=40',
      'zip=77002&county=36061&year=2026&ages=40']) expect((await benchmark(query)).response.status).toBe(400);
    expect((await h.app.request('/v1/benchmark?zip=77002&year=2026&ages=40')).status).toBe(401);
  });

  it('facade uses only captured subsidy fields, maps dollars and sorts by net before pagination', async () => {
    const response = await h.app.request('/compat/v1/plans/medical/search', { method: 'POST', headers,
      body: JSON.stringify(searchBody({ applicants: [{ age: 40 }], household_income: 31_300, household_size: 1,
        tax_filing: 'single', sort: 'premium_subsidized' })),
    });
    const data = await response.json() as any;
    expect(response.status).toBe(200);
    expect(data.meta).toMatchObject({ premium_tax_credit: 420.05, eligible_for_chip_medicaid: null, state_subsidy: null });
    expect(data.plans.find((p: any) => p.id === '87226TX0100013')).toMatchObject({ premium: 553.54, premium_subsidized: 133.49 });
    expect(data.plans.every((p: any, i: number) => !i || data.plans[i - 1].premium_subsidized <= p.premium_subsidized)).toBe(true);
    expect(response.headers.get('x-openplans-gaps')?.split(', ')).not.toContain('subsidies_unavailable');
    expect(response.headers.get('x-openplans-gaps')).toContain('csr_eligibility_not_evaluated');
    expect(data.plans[0]).not.toHaveProperty('estimated_monthly_tax_credit_cents');
  });
});

it('MCP contract preserves the real full-catalog benchmark, credit and net trace', async () => {
  const canonical = await estimatePremiums(h.db, body());
  const output = await canonicalEstimateOutput(h.db, canonical.estimates);
  assertHonest('estimate_premiums', output, canonical);
  expect(output.data!.estimates[0]).toMatchObject({ gross_monthly_cents: 55354, estimated_credit_cents: 42005,
    estimated_net_cents: 13349, benchmark_cents: 59205, subsidy: { benchmark: { silver_plan_count: expect.any(Number) } } });
  const changed = structuredClone(output); changed.data!.estimates[0]!.subsidy!.benchmark.lowest_silver_plans[0]!.ehb_monthly_cents++;
  expect(() => assertHonest('estimate_premiums', changed, canonical)).toThrow('changed benchmark ranking');
});
