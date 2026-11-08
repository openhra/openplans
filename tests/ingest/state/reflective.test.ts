import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createApp } from '../../../src/api/app.js';
import { migrate } from '../../../src/db/migrate.js';
import { ingestStateRates, parseStateArtifact } from '../../../src/ingest/state/index.js';
import { stateCatalog } from '../../../src/ingest/state/catalog.js';
import { coreMigrations, testDatabase } from '../../pglite.js';

const load = async (name: string) => JSON.parse(await readFile(new URL(`../../fixtures/state/${name}`, import.meta.url), 'utf8'));
const supplement = await load('vt-reflective-2026.json');
const original = await load('vt-2026.json');
const fixture = { ...original, sources: [...original.sources, ...supplement.sources] };
const db = testDatabase(new PGlite()), token = 'synthetic-reflective-test-token';
let directory: string, core: Awaited<ReturnType<typeof coreMigrations>>, path: string;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'openplans-reflective-'));
  path = join(directory, 'vt.json');
  core = await coreMigrations(); await migrate(db, core.directory);
  await writeFile(path, JSON.stringify(fixture));
  await ingestStateRates(db, path, 'VT', { verifyRaw: false });
});
afterAll(async () => { await db.close(); await core.cleanup(); await rm(directory, { recursive: true, force: true }); });

it('reproduces all eight real factual cuts from approved 2026 cells rather than proposed 2027 cells', () => {
  const result = spawnSync('python3', ['-B', '-c', String.raw`
import json,sys
sys.path.insert(0,sys.argv[1])
from reflective import bcbs_records,mvp_records
cuts=json.load(open(sys.argv[2]))['cuts']
fixture=json.load(open(sys.argv[3]))
assert bcbs_records(cuts['BCBSVT'])==fixture['sources'][0]['records']
assert mvp_records(cuts['MVP'])==fixture['sources'][1]['records']
assert fixture['sources'][0]['records'][0]['prices']['single']=='1080.37'
assert fixture['sources'][1]['records'][0]['prices']['single']=='935.34'
# SYNTHETIC missing approved-year heading; never fall back to proposed rows.
for parse,text in [(bcbs_records,cuts['BCBSVT']),(mvp_records,cuts['MVP'])]:
    try: parse(text.replace('2026 Approved Rates','SYNTHETIC wrong year'))
    except (ValueError,IndexError): pass
    else: raise AssertionError('Missing approved-year heading was accepted')
print('PASS: 8 real designs / 32 approved cells; wrong-year negative controls fail')
`, fileURLToPath(new URL('../../../src/ingest/state/', import.meta.url)),
  fileURLToPath(new URL('../../fixtures/state/vt-reflective-source-cells.json', import.meta.url)),
  fileURLToPath(new URL('../../fixtures/state/vt-reflective-2026.json', import.meta.url))], { encoding: 'utf8' });
  expect(result.status, result.stderr).toBe(0); expect(result.stdout).toContain('PASS');
});

it('serves separately named off-exchange Silver designs with cited PDF evidence and no inferred HIOS IDs', async () => {
  const response = await createApp(db).request('/v1/plans?county=50007&year=2026');
  expect(response.status).toBe(200);
  const list = await response.json() as any;
  expect(list.total).toBe(10); // 2 unchanged original gold fixtures + 8 real new designs.
  for (const source of supplement.sources) for (const record of source.records) {
    const plan = list.plans.find((p: any) => p.plan_key === `${record.issuer}:${record.plan_name}`);
    expect(plan).toMatchObject({ metal: 'Silver', on_exchange: false, off_exchange: true, hios_id: null,
      provenance: { exchange: { source_url: source.url, source_sha256: source.sha256,
        source_record: record.source_record, source_rows: [] } } });
  }
  expect((await stateCatalog(db, 2026, 'VT')).filter(r => r.raw_record.exchange === 'On')).toHaveLength(2);
  expect(await stateCatalog(db, 2027, 'VT')).toHaveLength(0);
});

it('prices all 32 published family tiers verbatim; age and tobacco never change community rates', async () => {
  const app = createApp(db, { premiumToken: token });
  const subscriber = { age: 35, tobacco: false, relationship: 'subscriber' };
  const spouse = { age: 45, tobacco: false, relationship: 'spouse' };
  const child = { age: 24, tobacco: false, relationship: 'child' };
  const cases = { single: [subscriber], couple: [subscriber, spouse], adult_children: [subscriber, child], family: [subscriber, spouse, child] };
  for (const source of supplement.sources) for (const record of source.records) {
    for (const [tier, members] of Object.entries(cases)) {
      for (const changed of [false, true]) {
        const response = await app.request('/v1/premium-estimates', {
          method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
          body: JSON.stringify({ plan_keys: [`${record.issuer}:${record.plan_name}`], county: '50007', coverage_start: '2026-01-01',
            members: members.map(m => changed && m.relationship !== 'child' ? { ...m, age: 61, tobacco: true } : m) }),
        });
        expect(response.status).toBe(200);
        const quote = (await response.json() as any).estimates[0];
        expect(quote).toMatchObject({ status: 'rated', hios_id: null, total_cents: Math.round(Number(record.prices[tier]) * 100) });
        expect(JSON.stringify(quote)).toContain(source.sha256);
      }
    }
  }
});

it('negative control: changing both a normalized premium and its duplicated raw value still fails against source cells', () => {
  for (const sourceIndex of [0, 1]) {
    const mutant = structuredClone(supplement);
    const record = mutant.sources[sourceIndex].records[0];
    record.prices.single = record.raw.single = (Number(record.prices.single) + 0.01).toFixed(2);
    expect(() => parseStateArtifact(JSON.stringify(mutant))).toThrow('Reflective tier differs from approved source cells');
  }
  const changedPublication = structuredClone(supplement); changedPublication.sources[0].sha256 = 'a'.repeat(64);
  expect(() => parseStateArtifact(JSON.stringify(changedPublication))).toThrow('Invalid reflective identity');
  const inventedIdentity = structuredClone(supplement); inventedIdentity.sources[1].records[0].plan_id = '77566VT0040030';
  expect(() => parseStateArtifact(JSON.stringify(inventedIdentity))).toThrow();
});

it('negative controls: missing premiums and corrupt source bytes preserve the active catalog', async () => {
  const before = (await db.query('SELECT * FROM state_rate_active')).rows;
  const missing = structuredClone(fixture); delete missing.sources[1].records[0].prices.single;
  const mutantPath = join(directory, 'synthetic-missing-price.json');
  await writeFile(mutantPath, JSON.stringify(missing));
  await expect(ingestStateRates(db, mutantPath, 'VT', { verifyRaw: false })).rejects.toThrow('Missing filed community tier');
  const corrupt = structuredClone(supplement);
  const rawPath = join(directory, 'synthetic-corrupt-publication'); await writeFile(rawPath, 'synthetic corrupt source');
  for (const source of corrupt.sources) source.raw_path = rawPath;
  await writeFile(mutantPath, JSON.stringify(corrupt));
  await expect(ingestStateRates(db, mutantPath, 'VT')).rejects.toThrow('hash mismatch');
  expect((await db.query('SELECT * FROM state_rate_active')).rows).toEqual(before);
});

it('compatibility searches preserve off-market flags and do not put internal labels in HIOS fields', async () => {
  const old = process.env.OPENPLANS_COMPAT_API_KEY; process.env.OPENPLANS_COMPAT_API_KEY = token;
  try {
    const response = await createApp(db).request('/compat/v1/plans/medical/search', {
      method: 'POST', headers: { 'content-type': 'application/json', 'X-Api-Key': token },
      body: JSON.stringify({ fips_code: '50007', ids: supplement.sources.flatMap((s: any) => s.records.map((r: any) => `${r.issuer}:${r.plan_name}`)),
        applicants: [{ age: 40 }], enrollment_date: '2026-01-01' }),
    });
    expect(response.status).toBe(200);
    const plans = (await response.json() as any).plans;
    expect(plans).toHaveLength(8);
    for (const plan of plans) expect(plan).toMatchObject({ on_market: false, off_market: true, plan_market: 'off_market', hios_id: null, identifiers: [] });
  } finally {
    if (old === undefined) delete process.env.OPENPLANS_COMPAT_API_KEY; else process.env.OPENPLANS_COMPAT_API_KEY = old;
  }
});
