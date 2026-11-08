import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createApp } from '../../../src/api/app.js';
import { orderPlans, pageWindow } from '../../../src/compat/v1/search.js';
import { ingestGeoNames } from '../../../src/ingest/geo/geonames.js';
import { BASE, headers, searchBody, setup } from './helpers.js';

let h: Awaited<ReturnType<typeof setup>>, directory: string;
beforeAll(async () => {
  h = await setup(); directory = await mkdtemp(join(tmpdir(), 'openplans-fidelity-controls-'));
  const manifest = JSON.parse(await readFile(new URL('../../fixtures/geo/geonames-manifest.json', import.meta.url), 'utf8'));
  const path = new URL('../../fixtures/geo/geonames-us-cut.tsv', import.meta.url);
  const bytes = await readFile(path);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), manifest.fixture_sha256);
  await ingestGeoNames(h.db, { file: { path: path.pathname, metadata: { ...manifest.original_snapshot,
    sha256: manifest.fixture_sha256, bytes: bytes.length } } });
});
afterAll(async () => { await h?.close(); if (directory) await rm(directory, { recursive: true, force: true }); });

it('caps medical pages at 50, advances by the effective size and counts the filtered catalog before pagination', async () => {
  const marker = new Error('rollback synthetic pagination-only catalog');
  await expect(h.db.transaction(async tx => {
    // These are labelled synthetic catalog entries, never exported fixtures or fabricated rate evidence.
    // Their premiums remain unknown; the real source-backed plan/issuer/service area supplies only the schema.
    await tx.exec(`INSERT INTO plan SELECT snapshot_id,source_row,plan_year,state,issuer_id,
      '87226TX' || n::text,market,metal,dental_only,network_id,service_area_id,
      'Synthetic pagination-only plan',exchange_status,on_exchange,off_exchange
      FROM plan CROSS JOIN generate_series(9000000,9000059) n WHERE base_plan_id='87226TX0100013'`);
    const app = createApp(tx);
    const search = async (extra: Record<string, unknown>) => {
      const response = await app.request(BASE + '/plans/medical/search', { method: 'POST', headers,
        body: JSON.stringify(searchBody(extra)) });
      expect(response.status).toBe(200);
      return { body: await response.json() as any, gaps: response.headers.get('x-openplans-gaps')! };
    };
    const first = await search({ per_page: 100 }), second = await search({ per_page: 100, page: 2 });
    const third = await search({ per_page: 100, page: 3 }), beyond = await search({ per_page: 100, page: 4 });
    for (const result of [first, second, third, beyond]) expect(result.body.meta.total).toBe(103);
    expect(first.body.plans).toHaveLength(50); expect(second.body.plans).toHaveLength(50);
    expect(third.body.plans).toHaveLength(3); expect(beyond.body.plans).toEqual([]);
    const ids = [...first.body.plans, ...second.body.plans, ...third.body.plans].map(p => p.id);
    expect(new Set(ids).size).toBe(103); expect(ids).toEqual([...ids].sort());
    expect(first.gaps).toContain('default_plan_order_unverified');
    const defaults = await search({ per_page: undefined });
    expect(defaults.body.plans).toEqual(first.body.plans.slice(0, 10));
    const small = await search({ per_page: 2, page: 2 });
    expect(small.body.plans).toEqual(first.body.plans.slice(2, 4));
    const filtered = await search({ ids: ids.slice(0, 3).reverse(), per_page: 2, page: 2 });
    expect(filtered.body.meta.total).toBe(3); expect(filtered.body.plans.map((p: any) => p.id)).toEqual([ids[2]]);
    const sorted = await search({ sort: 'premium' });
    expect(sorted.gaps).not.toContain('default_plan_order_unverified');
    throw marker;
  })).rejects.toBe(marker);
});

it('sorts equal premiums and unknowns by public ID consistently, even with descending sort', () => {
  const rows = [{ id: 'd', premium: null }, { id: 'c', premium: 2 }, { id: 'b', premium: 2 },
    { id: 'e', premium: null }, { id: 'a', premium: 1 }];
  expect(orderPlans(structuredClone(rows), 'premium').map(p => p.id)).toEqual(['a', 'b', 'c', 'd', 'e']);
  expect(orderPlans(structuredClone(rows).reverse(), 'premium').map(p => p.id)).toEqual(['a', 'b', 'c', 'd', 'e']);
  expect(orderPlans(structuredClone(rows), '-premium').map(p => p.id)).toEqual(['b', 'c', 'a', 'd', 'e']);
});

it('negative controls: removing the cap, skipping page records, reverting the default and removing the tie breaker fail', async () => {
  const source = await readFile(new URL('../../../src/compat/v1/search.ts', import.meta.url), 'utf8');
  const paginationContract = (fn: typeof pageWindow) => {
    assert.deepEqual(fn(1, 100, 50), { start: 0, size: 50 });
    assert.deepEqual(fn(2, 100, 50), { start: 50, size: 50 });
    assert.deepEqual(fn(3, 2, 50), { start: 4, size: 2 });
  };
  const orderingContract = (fn: typeof orderPlans) => {
    assert.deepEqual(fn([{ id: 'b', premium: 1 }, { id: 'a', premium: 2 }]).map(p => p.id), ['a', 'b']);
    assert.deepEqual(fn([{ id: 'b', premium: 1 }, { id: 'a', premium: 1 }], 'premium').map(p => p.id), ['a', 'b']);
  };
  paginationContract(pageWindow); orderingContract(orderPlans);
  for (const [name, from, to, contract, entry] of [
    ['cap', 'Math.min(requestedSize, maximumSize)', 'requestedSize', paginationContract, 'pageWindow'],
    ['offset', '(page - 1) * size', '(page - 1) * requestedSize', paginationContract, 'pageWindow'],
    ['default', "sort = 'id'", "sort = 'premium'", orderingContract, 'orderPlans'],
    ['tie', '|| compareId(a, b)', '|| 0', orderingContract, 'orderPlans'],
  ] as const) {
    const mutant = source.replace(from, to); expect(mutant).not.toBe(source);
    const path = join(directory, `synthetic-${name}-mutant.cjs`);
    await writeFile(path, ts.transpileModule(mutant, { compilerOptions: { module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022 } }).outputText);
    const fn = createRequire(import.meta.url)(path)[entry];
    expect(() => (contract as (fn: any) => void)(fn), name).toThrow();
  }
});

it('uses public Census display labels for postal fallback counties and retains sourced public joins', async () => {
  const contract = (body: any, fips: string, name: string, zip: string) => {
    assert.deepEqual(body.counties[0], { id: Number(fips), fips_code: fips, name, state_code: 'TX', state_id: 48,
      state_live: null, state_live_for_business: null });
    assert.equal(body.states[0].id, 48); assert.equal(body.states[0].fips_number, '48');
    assert.deepEqual(body.zip_codes[0], { code: zip, id: Number(zip) });
    assert.equal(body.zip_counties[0].id, null); assert.equal(body.zip_counties[0].county_id, Number(fips));
    assert.equal(body.zip_counties[0].zip_code_id, Number(zip));
  };
  for (const [zip, fips, name] of [['77001', '48201', 'Harris County'], ['75001', '48113', 'Dallas County'],
    ['78002', '48029', 'Bexar County']]) {
    const response = await h.app.request(`${BASE}/zip_counties?zip_prefix=${zip}`, { headers });
    expect(response.status).toBe(200);
    const body = await response.json() as any;
    contract(body, fips!, name!, zip!);
    expect(response.headers.get('x-openplans-gaps')).toContain('vendor_geography_ids_unavailable');
    // Revert the label in a response copy; the positive contract must reject the old rule.
    const label = structuredClone(body); label.counties[0].name = name!.replace(/ County$/, '');
    expect(() => contract(label, fips!, name!, zip!)).toThrow();
    if (zip === '77001') expect(body.zip_counties[0]).toMatchObject({ source: 'geonames', attribution: expect.any(Object) });
  }
});
