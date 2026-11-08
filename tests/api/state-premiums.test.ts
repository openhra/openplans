import { canonicalEstimateOutput } from '../mcp/canonical-estimate.js';
import { assertHonest } from '../../src/mcp/schemas.js';
import { getPlan, estimatePremiums } from '../../src/services/catalog.js';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../src/api/app.js';
import { estimatePremium } from '../../src/api/premiums.js';
import { countyPlans, findPlan, planView, resolveLocation } from '../../src/api/repository.js';
import { householdSubsidy, withSubsidy } from '../../src/api/subsidies.js';
import { premiumRequest } from '../../src/api/validation.js';
import { migrate } from '../../src/db/migrate.js';
import type { SqlSession } from '../../src/db/database.js';
import { ingestStateRates } from '../../src/ingest/state/index.js';
import { stateRatingArea } from '../../src/ingest/state/catalog.js';
import { coreMigrations, testDatabase } from '../pglite.js';

const db = testDatabase(new PGlite()), token = 'synthetic-state-test-token';
let directory: string, core: Awaited<ReturnType<typeof coreMigrations>>;
const subscriber = { age: 40, tobacco: false, relationship: 'subscriber' };
const spouse = { age: 45, tobacco: false, relationship: 'spouse' };
const children = [{ age: 10, tobacco: false, relationship: 'child' }, { age: 17, tobacco: false, relationship: 'child' }];
const households = [[subscriber], [subscriber, spouse], [subscriber, ...children], [subscriber, spouse, ...children]];
function body(zip = '10001', members = households[0]!, id = '11177NY0220001') {
  return { zip, plan_ids: [id], coverage_start: '2026-01-01', members };
}
async function http(tx: SqlSession, input: unknown) {
  return createApp(tx, { premiumToken: token }).request('/v1/premium-estimates', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(input),
  });
}
async function ny(tx: SqlSession, input = body()) {
  const response = await http(tx, input); expect(response.status).toBe(200);
  return (await response.json() as any).estimates[0];
}
async function rollback(run: (tx: SqlSession) => Promise<void>) {
  const marker = new Error('synthetic state rollback');
  await expect(db.transaction(async tx => { await run(tx); throw marker; })).rejects.toBe(marker);
}
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'openplans-state-api-'));
  core = await coreMigrations(); await migrate(db, core.directory);
  for (const state of ['NY', 'VT'] as const) {
    const path = join(directory, `${state}.json`);
    await writeFile(path, await readFile(new URL(`../fixtures/state/${state.toLowerCase()}-2026.json`, import.meta.url)));
    await ingestStateRates(db, path, state, { verifyRaw: false });
  }
  // Unmodified real Census cuts; fixture registration metadata is test-only.
  const geo = JSON.parse(await readFile(new URL('./state-geography.json', import.meta.url), 'utf8'));
  await db.exec(`INSERT INTO source(source_id,publisher,source_kind) VALUES('state-api-census-cut','US Census Bureau','geography');
    INSERT INTO snapshot(snapshot_id,source_id,validation_state,expected_children,sha256,retrieved_at,activated_at)
      VALUES('state-api-census-cut','state-api-census-cut','ACTIVE',0,'${geo.source_sha256}',now(),now());
    INSERT INTO geo_import(state,plan_year,relationship_snapshot_id,centroid_snapshot_id,rating_snapshot_id)
      VALUES('NY',2026,'state-api-census-cut','state-api-census-cut','state-api-census-cut'),
      ('VT',2026,'state-api-census-cut','state-api-census-cut','state-api-census-cut');`);
  for (const row of geo.rows) {
    const v = row.values;
    await db.query(`INSERT INTO zcta_county VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'state-api-census-cut',$10)`,
      [v.GEOID_ZCTA5_20, v.GEOID_COUNTY_20, v.NAMELSAD_COUNTY_20,
        v.AREALAND_ZCTA5_20, v.AREAWATER_ZCTA5_20, v.AREALAND_COUNTY_20, v.AREAWATER_COUNTY_20,
        v.AREALAND_PART, v.AREAWATER_PART, row.source_row]);
  }
});
afterAll(async () => { await db.close(); await core.cleanup(); await rm(directory, { recursive: true, force: true }); });

it('NY native HTTP: four household tiers select approved source cells with no age or tobacco factors', async () => {
  for (const [i, total] of [127098, 254196, 216067, 362229].entries()) {
    const q = await ny(db, body('10001', households[i]));
    expect(q).toMatchObject({ status: 'rated', total_cents: total, hios_id: '11177NY0220001',
      quote_method: 'state_filed_tier', bindable_quote: false, on_exchange: 'unknown', rating_area_id: 'Rating Area 4',
      rule_trace: { state: 'NY', source_cell: { source_record: 'publication#Rate Table!row=20', value: (total / 100).toFixed(2) } } });
    expect(q.rule_trace.citation).toContain('3231');
    const changed = households[i]!.map(m => ({ ...m, age: m.relationship === 'child' ? 25 : 64, tobacco: true }));
    expect(await ny(db, body('10001', changed))).toMatchObject({ total_cents: total });
  }
});

it('NY plan listing exposes filed-area availability and unknown exchange eligibility without inventing variants', async () => {
  const response = await createApp(db).request('/v1/plans?zip=10001&year=2026');
  expect(response.status).toBe(200);
  const result = await response.json() as any;
  expect(result.plans).toHaveLength(3);
  expect(result.plans[0]).toMatchObject({ on_exchange: 'unknown', variant_ids: [], enrollment_eligibility: 'unknown',
    premium_availability: { status: 'available', rating_area_id: 'Rating Area 4' } });
  expect(await countyPlans(db, '36001', 2026)).toEqual([]); // no Albany rows in this real cut
});

it('VT statewide catalog and calculator retain named keys and hios_id null, including a different VT ZIP', async () => {
  const plan = (await findPlan(db, 'BCBSVT:Gold Plan', 2026))!;
  expect(await planView(db, plan)).toMatchObject({ plan_key: 'BCBSVT:Gold Plan', hios_id: null, base_plan_id: null });
  for (const zip of ['05401', '05602']) {
    const location = await resolveLocation(db, { zip });
    const offered = await countyPlans(db, location.county!, 2026, zip);
    expect(offered).toHaveLength(2);
    for (const [i, total] of [134545, 269090, 259672, 378071].entries()) {
      // Library boundary only: native validator remains HIOS-only outside this lane's lease.
      const request = premiumRequest(body(zip, households[i]));
      const q = await estimatePremium(db, plan, plan.plan_key!, request, location);
      expect(q).toMatchObject({ status: 'rated', total_cents: total, plan_key: 'BCBSVT:Gold Plan', hios_id: null,
        rule_trace: { state: 'VT', source_cell: { value: (total / 100).toFixed(2) } } });
    }
  }
  for (let fips = 1; fips <= 27; fips += 2) expect(stateRatingArea('VT', 2026, `50${String(fips).padStart(3, '0')}`)?.rating_area_id).toBe('Vermont');
  expect(stateRatingArea('VT', 2026, '50029')).toBeNull();
  expect(stateRatingArea('NY', 2026, '36061')?.rating_area_id).toBe('Rating Area 4');
  expect(stateRatingArea('NY', 2027, '36061')).toBeNull();
});

it('unsupported relationships and dependent extensions keep their reasons, without a numeric premium', async () => {
  for (const [members, reason] of [
    [[subscriber, { ...children[0]!, age: 26 }], 'DEPENDENT_EXTENSION_REQUIRES_EVIDENCE'],
    [[{ ...subscriber, age: 16 }], 'CHILD_ONLY_OR_MINOR_SUBSCRIBER_REQUIRES_EVIDENCE'],
    [[subscriber, { ...spouse, relationship: 'other' }], 'UNSUPPORTED_HOUSEHOLD_RELATIONSHIPS'],
  ] as const) {
    const q = await ny(db, body('10001', [...members]));
    expect(q).toMatchObject({ status: 'unsupported_rating_method', reason });
    expect(q).not.toHaveProperty('total_cents');
  }
});

it('NY and VT subsidy review returns requires_state_rules without credit or net price', async () => {
  const q = await ny(db, { ...body(), household_income_annual: 50000, household_size: 1, tax_filing: 'single' } as ReturnType<typeof body>);
  expect(q).toMatchObject({ status: 'rated', quote_method: 'state_filed_tier', subsidy_status: 'requires_state_rules', estimated_monthly_tax_credit_cents: null,
    estimated_net_monthly_cents: null });
  const request = premiumRequest({ ...body('05401'), household_income_annual: 50000, household_size: 1, tax_filing: 'single' });
  const location = await resolveLocation(db, request.location), plan = (await findPlan(db, 'BCBSVT:Gold Plan', 2026))!;
  const result = withSubsidy(await estimatePremium(db, plan, plan.plan_key!, request, location), await householdSubsidy(db, request, location), plan);
  expect(result).toMatchObject({ status: 'rated', subsidy_status: 'requires_state_rules', estimated_monthly_tax_credit_cents: null });
});

it('data availability exposes staged state catalogs separately from federal catalogs', async () => {
  for (const state of ['NY', 'VT']) {
    const response = await createApp(db).request(`/v1/data-availability?state=${state}&year=2026`);
    expect(response.status).toBe(200);
    const rows = await response.json() as any[];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every(r => r.catalog_status === 'available' && r.premium_status === 'available'
      && r.quote_method === 'state_filed_tier' && r.subsidy_status === 'requires_state_rules')).toBe(true);
  }
});

it('negative controls: a per-age state authorization and a missing rule never yield a premium', async () => {
  for (const mutation of [
    `UPDATE state_rate_import SET rules_document=jsonb_set(rules_document,'{rules,0,method}','"per_member"') WHERE state='NY'`,
    `UPDATE state_rate_import SET rules_document=rules_document #- '{rules,0}' WHERE state='NY'`,
  ]) await rollback(async tx => {
    await tx.exec(mutation);
    const q = await ny(tx);
    expect(q).toMatchObject({ status: 'unsupported_rating_method', reason: 'NO_APPLICABLE_COMMUNITY_RULE' });
    expect(q).not.toHaveProperty('total_cents');
  });
});

it('negative control: MetroPlus family = 2.85 times rounded single fails the exact filed-cell assertion', async () => {
  const q = await ny(db, body('10001', households[3], '11177NY0010001'));
  assert.equal(q.total_cents, 223584);
  // Synthetic response mutant only; never alter approved publication cells.
  const mutant = { ...q, total_cents: Math.round(78451 * 2.85) };
  expect(mutant.total_cents).toBe(223585);
  expect(() => assert.equal(mutant.total_cents, 223584, 'MetroPlus filed family cell')).toThrow('MetroPlus filed family cell');
});

it('conflicting state rows, changed active imports and wrong-state locations never select the first price', async () => {
  await rollback(async tx => {
    await tx.exec(`INSERT INTO state_community_rate SELECT import_id,source_index,record_index+100,publication_snapshot_id,plan_key,region,rate,raw_record
      FROM state_community_rate WHERE plan_key='11177NY0220001'`);
    expect(await ny(tx)).toMatchObject({ status: 'ambiguous', reason: 'CONFLICTING_FILED_TIER_ROWS' });
  });
  const stale = { ...(await findPlan(db, '11177NY0220001', 2026))!, snapshot_id: 'synthetic-stale-import' };
  const request = premiumRequest(body());
  expect(await estimatePremium(db, stale, stale.base_plan_id, request, await resolveLocation(db, request.location)))
    .toMatchObject({ status: 'unknown', reason: 'CATALOG_CHANGED_RETRY' });
  expect(await ny(db, body('05401'))).toMatchObject({ status: 'missing', reason: 'PLAN_NOT_OFFERED_IN_LOCATION' });
});

it('DFS county transcription agrees with all 62 Census county identifiers', async () => {
  const census = JSON.parse(await readFile(new URL('./state-geography.json', import.meta.url), 'utf8'));
  const map = JSON.parse(await readFile(new URL('../../data/rating-rules/state-geography-2026.json', import.meta.url), 'utf8'));
  expect(Object.fromEntries(map.NY.counties.map((c: any) => [c.county_fips, c.county]))).toEqual(census.ny_counties);
  expect(map.NY.counties).toHaveLength(62);
  expect(new Set(map.NY.counties.map((c: any) => c.rating_area_id)).size).toBe(8);
});

it('MCP contracts preserve state plan keys, filed totals and source cells', async () => {
  expect(await getPlan(db, 'BCBSVT:Gold Plan', { year: '2026' })).toMatchObject({ plan_key: 'BCBSVT:Gold Plan', hios_id: null });
  for (const request of [body(), { ...body('05401'), plan_ids: [], plan_keys: ['BCBSVT:Gold Plan'] }]) {
    const canonical = await estimatePremiums(db, request);
    const output = await canonicalEstimateOutput(db, canonical.estimates);
    assertHonest('estimate_premiums', output, canonical);
    expect(output.data!.estimates[0]).toMatchObject({ gross_status: 'rated', quote_method: 'state_filed_tier', members: [],
      state_rule_trace: { tier: 'single' }, rate_trace: [{ column: expect.any(String), value: expect.any(String) }] });
  }
});
