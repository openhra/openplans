import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../../src/api/app.js';
import { BASE, headers, searchBody, setup } from './helpers.js';
import { assertShape } from './shape.js';

let h: Awaited<ReturnType<typeof setup>>;
beforeAll(async () => { h = await setup(); });
afterAll(async () => { await h?.close(); });
const get = async (path: string) => {
  const response = await h.app.request(BASE + path, { headers }); return { response, body: await response.json() as any };
};
const search = async (body: unknown = searchBody()) => {
  const response = await h.app.request(`${BASE}/plans/medical/search`, { method: 'POST', headers, body: JSON.stringify(body) });
  return { response, body: await response.json() as any };
};

describe('public catalog facade, native repository integration', () => {
  it('quotes all 43 captured public plans from actual TX source cuts', async () => {
    const result = await search();
    expect(result.response.status).toBe(200);
    expect(result.response.headers.get('cache-control')).toBe('no-store');
    expect(result.body.meta.total).toBe(43); expect(result.body.plans).toHaveLength(43);
    expect(result.body.plans.find((p: any) => p.id === '87226TX0100013')).toMatchObject({ premium: 529.28,
      premium_subsidized: null, premiums_by_applicant: [{ age: 35, premium: 529.28, smoker: false, child: false }] });
    expect(result.body.meta).toMatchObject({ premium_tax_credit: null, eligible_for_chip_medicaid: null });
    expect(result.response.headers.get('x-openplans-gaps')).toContain('off_exchange_catalog_incomplete');
  });

  it('maps native geography and keeps Census identifiers referentially consistent', async () => {
    const { response, body } = await get('/zip_counties?zip_prefix=77002');
    expect(response.status).toBe(200);
    expect(body.counties[0]).toMatchObject({ fips_code: '48201', state_code: 'TX', state_live: null });
    expect(body.zip_counties[0].county_id).toBe(body.counties[0].id);
    expect(body.zip_counties[0].zip_code_id).toBe(body.zip_codes[0].id);
    expect(body.states[0]).toMatchObject({ name: 'Texas', code: 'TX' });
  });

  it('supports three/four-digit prefixes using only loaded exact ZCTAs', async () => {
    for (const prefix of ['770', '7700']) {
      const { body } = await get(`/zip_counties?zip_prefix=${prefix}`);
      expect(body.zip_codes.length).toBeGreaterThan(0);
      expect(body.zip_codes.every((z: any) => z.code.startsWith(prefix))).toBe(true);
      expect(body.zip_codes.map((z: any) => z.code)).not.toContain('77001');
    }
  });

  it('negative control: non-TX ZIP never borrows TX data, including when paired with Harris FIPS', async () => {
    const result = await get('/zip_counties?zip_prefix=55401');
    expect(result.body).toEqual({ counties: [], states: [], zip_counties: [], zip_codes: [] });
    expect(result.response.headers.get('x-openplans-gaps')).toContain('zip_not_in_loaded_zcta_data');
    for (const payload of [searchBody({ zip_code: '55401', fips_code: '27053' }), searchBody({ zip_code: '55401' }),
      searchBody({ zip_code: '77001' }), searchBody({ fips_code: '36061' })]) {
      const result = await search(payload);
      expect(result.body.plans).toEqual([]); expect(result.body.meta.total).toBe(0);
      expect(result.response.headers.get('x-openplans-gaps')).toBeTruthy();
    }
    expect((await search(searchBody({ zip_code: '77002', fips_code: '48085' }))).response.status).toBe(400);
  });

  it('filters IDs, sorts before pagination and leaves subsidies unresolved without filing status', async () => {
    const all = await search(searchBody({ sort: 'premium' }));
    const page = await search(searchBody({ sort: 'premium', per_page: 2, page: 2 }));
    expect(page.body.plans).toEqual(all.body.plans.slice(2, 4)); expect(page.body.meta.total).toBe(43);
    const one = await search(searchBody({ ids: ['87226TX0100013'], household_size: 1, household_income: 20000 }));
    expect(one.body.meta.total).toBe(1); expect(one.body.plans[0].premium_subsidized).toBeNull();
    expect(one.response.headers.get('x-openplans-gaps')).toContain('household_subsidies_unavailable');
    const family = await search(searchBody({ ids: ['87226TX0100013'], applicants: [{ age: 35 }, { age: 35 }] }));
    expect(family.body.plans[0].premium).toBe(1058.56); expect(family.body.plans[0].premiums_by_applicant).toHaveLength(2);
    const differentAge = await search(searchBody({ ids: ['87226TX0100013'], applicants: [{ age: 36 }] }));
    expect(differentAge.body.plans[0].premium).toBeGreaterThan(529.28);
  });

  it('retains selected variant IDs, rejects nonexistent variants, and exposes unknown quote evidence', async () => {
    const selected = await search(searchBody({ ids: ['87226TX0100013-00', '87226TX0100013-99'] }));
    expect(selected.body.plans).toHaveLength(1);
    expect(selected.body.plans[0]).toMatchObject({ id: '87226TX0100013-00', premium: 529.28 });
    expect(selected.response.headers.get('x-openplans-gaps')).toContain('public_plan_unavailable:87226TX0100013-99');
    const marker = new Error('rollback synthetic unknown-rate mutation');
    await expect(h.db.transaction(async tx => {
      await tx.query(`UPDATE rate SET individual_rate_cents=NULL WHERE snapshot_id=$1 AND base_plan_id=$2 AND age_band='35'`,
        [`${h.report.import_id}:rate`, '87226TX0100013']);
      const app = createApp(tx, { premiumToken: 'synthetic-facade-test-token' });
      const response = await app.request(`${BASE}/plans/medical/search`, { method: 'POST', headers,
        body: JSON.stringify(searchBody({ ids: ['87226TX0100013'] })) });
      const result = await response.json() as any;
      expect(result.plans[0].premium).toBeNull();
      expect(response.headers.get('x-openplans-gaps')).toContain('premium_unknown');
      throw marker;
    })).rejects.toBe(marker);
  });

  it('maps medical detail aliases, preserves variant IDs, rejects absent/dental/non-TX plans', async () => {
    for (const path of ['/plans/87226TX0100013', '/plans/medical/87226TX0100013', '/plans/87226TX0100013-00?year=2026']) {
      const result = await get(path); expect(result.response.status).toBe(200);
      expect(result.body.plan.id).toBe(path.split('/').pop()!.split('?')[0]);
      expect(result.body.plan.carrier.issuer_id).toBe('87226');
    }
    for (const id of ['57129MN0540004', 'UNKNOWN_PLAN_ID', '87226TX0100013-99']) expect((await get(`/plans/${id}`)).response.status).toBe(404);
  });

  it('maps explicit variant benefits and leaves an unrecorded standard variant unknown', async () => {
    const base = await get('/plans/87226TX0100013');
    expect(base.body.plan.primary_care_physician).toBeNull();
    expect(base.response.headers.get('x-openplans-gaps')).toContain('variant_cost_sharing_unknown');
    const variant = await get('/plans/87226TX0100013-00');
    expect(variant.body.plan.primary_care_physician).toContain('Copay: $15.00');
    expect(variant.body.plan.specialist).toContain('Copay: $35.00');
    expect(variant.body.plan.generic_drugs).toContain('Copay: $3.00');
    expect(variant.body.plan.chiropractic_services).toBe(true);
    expect(variant.body.plan.adult_dental).toBeNull();
    const selected = await search(searchBody({ ids: ['87226TX0100013-00'] }));
    expect(selected.body.plans[0].primary_care_physician).toBe(variant.body.plan.primary_care_physician);
  });

  it('preserves unknowns for unmapped metadata and never substitutes an arbitrary vendor network ID', async () => {
    const { body, response } = await get('/plans/87226TX0100013');
    expect(body.plan.network_size).toBeNull(); expect(body.plan.network_ids).toEqual([]);
    expect(body.plan.networks[0]).toMatchObject({ id: null, name: expect.any(String) });
    expect(body.plan.plan_documents).toEqual([]); expect(body.plan.adult_dental).toBeNull();
    expect(response.headers.get('x-openplans-gaps')).toContain('plan_metadata_and_benefit_summaries_unmapped');
  });

  it('maps RxNorm concepts with published NDC packages; counts concepts and keeps unknown metadata null', async () => {
    for (const term of ['lipitor', 'lisinopril', 'metformin']) {
      const result = await get(`/drugs?search_term=${term}`);
      expect(result.response.status).toBe(200); expect(result.body.meta.total).toBeGreaterThan(0);
      expect(new Set(result.body.drugs.map((d: any) => d.id)).size).toBe(result.body.drugs.length);
      for (const drug of result.body.drugs) {
        expect(drug.id).toMatch(/^rxnorm:\d+$/);
        for (const id of drug.drug_package_ids) expect(result.body.drug_packages).toContainEqual({
          id, rx_cui_id: drug.id.slice(7), med_id: null, description: null });
      }
      expect(result.response.headers.get('x-openplans-gaps')).toContain('not_ndc_products');
      const page = await get(`/drugs?search_term=${term}&per_page=1&page=1`);
      expect(page.body.drugs).toHaveLength(1); expect(page.body.meta.total).toBe(result.body.meta.total);
      const ids = page.body.drugs[0].drug_package_ids;
      expect(page.body.drug_packages.every((p: any) => ids.includes(p.id))).toBe(true);
    }
  });

  it('maps carrier/network lists with native filters and pagination', async () => {
    const carriers = await get('/carriers');
    expect(carriers.body.carriers.length).toBeGreaterThan(2);
    const limited = await get('/carriers?per_page=2&page=1');
    expect(limited.body.carriers).toEqual(carriers.body.carriers.slice(0, 2));
    expect(limited.body.meta.total).toBe(carriers.body.meta.total);
    const filtered = await get('/carriers?state=tx&market=individual&line_of_coverage=medical');
    expect(filtered.body.carriers.length).toBeGreaterThan(0);
    expect(filtered.body.carriers.every((c: any) => c.markets.includes('individual') && c.lines_of_coverage.includes('medical'))).toBe(true);
    expect((await get('/carriers?state=NY')).body.carriers).toEqual([]);
    const networks = await get('/networks?per_page=2&page=1');
    expect(networks.body.networks).toHaveLength(2);
    expect(networks.body.networks[0]).toMatchObject({ id: null, name: expect.any(String), source: 'cms_puf', last_imported_at: null });
  });

  it('requires the facade credential and validates malformed requests', async () => {
    expect((await h.app.request(`${BASE}/plans/medical/search`, { method: 'POST', body: JSON.stringify(searchBody()) })).status).toBe(401);
    const configured = process.env.OPENPLANS_COMPAT_API_KEY;
    delete process.env.OPENPLANS_COMPAT_API_KEY;
    expect((await createApp(h.db, {}).request(`${BASE}/plans/medical/search`, { method: 'POST' })).status).toBe(503);
    process.env.OPENPLANS_COMPAT_API_KEY = configured;
    expect((await h.app.request(`${BASE}/plans/medical/search`, { method: 'POST', headers, body: '{bad' })).status).toBe(400);
    for (const bad of [null, [], {}, searchBody({ fips_code: 'bad' }), searchBody({ applicants: [{ age: -1 }] }),
      searchBody({ applicants: [{ age: 35, smoker: 'false' }] }), searchBody({ per_page: -1 }),
      searchBody({ ids: ['bad'] }), searchBody({ enrollment_date: null }), searchBody({ market: null }),
      searchBody({ applicants: [{ age: 35, smoker: null }] }), searchBody({ enrollment_date: '2026-02-30' })]) expect((await search(bad)).response.status).toBe(400);
    for (const path of ['/zip_counties', '/zip_counties?zip_prefix=abc', '/drugs?search_term=a', '/carriers?page=0', '/networks?per_page=1001']) {
      expect((await get(path)).response.status, path).toBe(400);
    }
    expect((await get('/drugs?search_term=zzzznotadrug')).body).toEqual({ meta: { total: 0 }, drugs: [], drug_packages: [] });
  });

  it('negative control: extra fixture key and wrong primitive type fail the same shape checker', () => {
    const fixture = { plans: [{ id: 'synthetic-shape-only', premium: 1 }] };
    assertShape(fixture, fixture);
    assertShape({ ...fixture, _synthetic_annotation: 'capture metadata' }, fixture);
    expect(() => assertShape({ ...fixture, synthetic_required_key: 1 }, fixture)).toThrow('synthetic_required_key');
    const extra = structuredClone(fixture) as any; extra.plans[0].required_new_key = 'synthetic';
    expect(() => assertShape(extra, fixture)).toThrow('required_new_key');
    const wrong = structuredClone(fixture) as any; wrong.plans[0].premium = '1';
    expect(() => assertShape(fixture, wrong)).toThrow('wrong primitive type');
  });
});

// Ported request list from the oracle's routes.test.ts, with native public-data
// expectations. Original MN requests must be empty/404; never substitute TX data.
describe('ported covered route requests', () => {
  it('ports the captured source-header case as an explicit public-evidence gaps header', async () => {
    expect((await get('/zip_counties?zip_prefix=55401')).response.headers.get('x-openplans-gaps')).toBeTruthy();
  });
  it.each(['/zip_counties?zip_prefix=55401', '/zip_counties?zip_prefix=99999', '/carriers', '/carriers?per_page=2&page=1',
    '/drugs?search_term=lipitor', '/drugs?search_term=zzzznotadrug'])('%s', async path => {
    expect((await get(path)).response.status).toBe(200);
  });
  it.each(['/zip_counties', '/zip_counties?zip_prefix=abc', '/drugs?search_term=a'])('%s is invalid', async path => {
    expect((await get(path)).response.status).toBe(400);
  });
  it.each(['/plans/57129MN0540004', '/plans/UNKNOWN_PLAN_ID'])('%s has no public TX detail', async path => {
    expect((await get(path)).response.status).toBe(404);
  });
  it('runs the captured MN search and pagination bodies without substituting another state', async () => {
    for (const per_page of [undefined, 1]) {
      const result = await search({ zip_code: '55401', fips_code: '27053', market: 'individual',
        applicants: [{ age: 35, smoker: false, child: false }], ...(per_page ? { page: 1, per_page } : {}) });
      expect(result.response.status).toBe(200); expect(result.body.plans).toEqual([]);
    }
    expect((await search({ zip_code: '55401' })).response.status).toBe(400);
  });
});

// Synthetic, rolled-back dental mutation: this checks mapping, never claims a real medical plan is SADP.
describe('dental catalog support and rating gaps', () => {
  it('serves SADP catalog entries while preserving missing native dental evidence', async () => {
    const marker = new Error('rollback synthetic dental catalog');
    await expect(h.db.transaction(async tx => {
      await tx.query(`UPDATE plan SET dental_only=true WHERE base_plan_id='87226TX0100013'`);
      await tx.query(`UPDATE service_area_county SET dental_only=true WHERE issuer_id='87226'`);
      const app = createApp(tx, {});
      const response = await app.request(BASE + '/plans/dental/search', { method: 'POST', headers, body: JSON.stringify(searchBody()) });
      expect(response.status).toBe(200);
      const body = await response.json() as any;
      expect(body.meta.total).toBe(1); expect(body.plans[0]).toMatchObject({ id: '87226TX0100013', stand_alone: true, premium: null });
      expect(body.plans[0].benefits.oral_exam).toBeNull();
      if (process.env.OPENPLANS_REFERENCE_CAPTURES_DIR) {
        const capture = JSON.parse(await readFile(join(process.env.OPENPLANS_REFERENCE_CAPTURES_DIR, 'plans/dental/search/48201/small_group/23ee8bdcc150.json'), 'utf8'));
        assertShape(capture, body, '$', true);
      }
      expect(response.headers.get('x-openplans-gaps')).toContain('premium_unsupported_rating_method');
      expect(response.headers.get('x-openplans-gaps')).toContain('dental_premiums_unsupported_by_native_rating:87226TX0100013');
      const detail = await app.request(BASE + '/plans/dental/87226TX0100013', { headers });
      expect(detail.status).toBe(200); expect((await detail.json() as any).plan.benefits.oral_exam).toBeNull();
      expect((await app.request(BASE + '/plans/medical/87226TX0100013', { headers })).status).toBe(404);
      throw marker;
    })).rejects.toBe(marker);
  });
  it('returns empty + gap for unloaded SADP data and unsupported small group', async () => {
    for (const extra of [{}, { market: 'small_group' }]) {
      const response = await h.app.request(BASE + '/plans/dental/search', { method: 'POST', headers, body: JSON.stringify(searchBody(extra)) });
      expect(response.status).toBe(200); expect((await response.json() as any).plans).toEqual([]);
      expect(response.headers.get('x-openplans-gaps')).toBeTruthy();
    }
  });
});
