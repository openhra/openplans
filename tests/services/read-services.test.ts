import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/api/app.js';
import { findProviders, getProvider, checkProviderNetworks } from '../../src/services/providers.js';
import { searchDrugs, getDrug, checkDrugCoverages, drugTerminology } from '../../src/services/drugs.js';
import { getDataStatus, getSnapshot } from '../../src/services/provenance.js';
import { importProviders } from '../../src/ingest/qhp/provider.js';
import { importFormulary } from '../../src/ingest/qhp/formulary.js';
import * as providers from '../ingest/qhp/provider-helpers.js';
import * as drugs from '../ingest/qhp/formulary-helpers.js';

// Reuse real publisher cuts with the existing explicitly synthetic registration harness.
describe('provider read use cases preserve native preconditions without HTTP', () => {
  let h: Awaited<ReturnType<typeof providers.setup>>, plan: string;
  beforeAll(async () => {
    h = await providers.setup();
    const records = await providers.fixture('records');
    plan = records[0].plans.find((p: { plan_id: string }) => h.catalog.plans.some((c: { base_plan_id: string }) => c.base_plan_id === p.plan_id)).plan_id;
    await h.replace(records); expect((await importProviders(h.db, providers.scope)).status).toBe('ACTIVE');
  });
  afterAll(async () => h?.close());
  it('shares search and batch bytes with the native routes and retains record participation scope', async () => {
    const params = { plan_id: plan, year: '2026' };
    const result = await findProviders(h.db, params);
    const response = await createApp(h.db, {}).request(`/v1/providers?${new URLSearchParams(params)}`);
    expect(await response.text()).toBe(JSON.stringify(result));
    expect(result).toMatchObject({ status: 'available', provider_coverage: { status: 'complete' } });
    const body = { plan_ids: [plan], npis: ['1234567890'], year: 2026 };
    const native = await createApp(h.db, {}).request('/v1/provider-participation', { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    expect(await native.text()).toBe(JSON.stringify(await checkProviderNetworks(h.db, body)));
  });
  it('fails invalid plans and missing taxonomy before searching or resolving a missing ZIP', async () => {
    await expect(findProviders(h.db, { plan_id: '99999TX0100001', year: '2026' })).rejects.toMatchObject({ error: { code: 'PLAN_NOT_FOUND' } });
    await expect(findProviders(h.db, { specialty: 'Family', zip: '00000' })).rejects.toMatchObject({ error: { code: 'unsupported_without_taxonomy' } });
    await expect(getProvider(h.db, 'invalid')).rejects.toMatchObject({ field: 'npi' });
    await expect(findProviders(h.db, { taxonomy: '207Q00000X', specialty: 'Family' })).rejects.toMatchObject({ field: 'taxonomy' });
  });
  it('blocks old active positive evidence after a newer source denial', async () => {
    await h.db.exec(`INSERT INTO qhp_index(qhp_index_id,discovery_id,issuer_id,plan_year,state,registry_snapshot_id,registry_row,status,discovered_at)
      VALUES ('synthetic-denied','synthetic-denied','76589',2026,'TX','registry',1,'access_denied',clock_timestamp())`);
    const result = await findProviders(h.db, { plan_id: plan, year: '2026' });
    expect(result).toMatchObject({ status: 'unknown', reason: 'source_access_denied', providers: [] });
    expect(() => expect(result).toMatchObject({ status: 'available' })).toThrow();
  });
});

describe('drug, freshness and provenance services', () => {
  let h: Awaited<ReturnType<typeof drugs.setup>>, plan: string, rxcui: string;
  beforeAll(async () => {
    h = await drugs.setup(); const records = await drugs.fixture('drugs');
    plan = h.catalog.plans[0].base_plan_id; rxcui = records[0].rxnorm_id;
    await h.replace(records); expect((await importFormulary(h.db, drugs.scope)).status).toBe('ACTIVE');
  });
  afterAll(async () => h?.close());
  it('returns canonical RxNorm candidates and coverage without changing native bytes', async () => {
    const result = await searchDrugs(h.db, { q: 'metformin', limit: '10' });
    const response = await createApp(h.db, {}).request('/v1/drugs?q=metformin&limit=10');
    expect(await response.text()).toBe(JSON.stringify(result));
    expect(await drugTerminology(h.db)).toMatchObject({ snapshot_id: 'rx' });
    expect(await getDrug(h.db, '860975')).toMatchObject({ rxcui: '860975', patient_price: null });
    const body = { plan_ids: [plan], rxcuis: [rxcui], year: 2026 };
    const native = await createApp(h.db, {}).request('/v1/drug-coverage', { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const coverage = await checkDrugCoverages(h.db, body);
    expect(await native.text()).toBe(JSON.stringify(coverage));
    expect(coverage.results[0]).toMatchObject({ status: 'listed_covered', patient_price: null });
  });
  it('returns only public snapshot columns, tracks parent/child edges and parameterizes identifiers', async () => {
    const snapshot = await getSnapshot(h.db, 'catalog');
    expect(snapshot).toMatchObject({ snapshot_id: 'catalog', source_id: 'synthetic-harness', parent_snapshot_ids: ['catalog-import'] });
    expect(snapshot).not.toHaveProperty('raw_path'); expect(snapshot).not.toHaveProperty('approved_destinations');
    expect((await getSnapshot(h.db, 'catalog-import'))?.child_snapshot_ids).toEqual(['catalog']);
    expect(await getSnapshot(h.db, "' OR true --")).toBeNull();
    const current = await getDataStatus(h.db, { state: 'TX', year: '2026', issuer_id: '76589' });
    expect(current.entries.length).toBeGreaterThan(0); expect(current.data_generation).toMatch(/^[a-f0-9]{32}$/);
    expect((await getDataStatus(h.db, { state: 'VT' })).entries).toEqual([]);
  });
  it('does not equate an absent terminology import with no matching drug', async () => {
    await h.db.query("UPDATE snapshot SET validation_state='QUARANTINED' WHERE snapshot_id='rx'");
    expect(await drugTerminology(h.db)).toBeNull();
    expect(await searchDrugs(h.db, { q: 'metformin' })).toEqual({ candidates: [], exact_concept_required: true });
  });
});
