import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, afterAll, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../src/api/app.js';
import type { SqlSession } from '../../src/db/database.js';
import { migrate } from '../../src/db/migrate.js';
import { ingestGeo } from '../../src/ingest/geo/index.js';
import { importPufs } from '../../src/ingest/puf/import.js';
import { ingestRatingRules } from '../../src/ingest/rating-rules/index.js';
import { coreMigrations, testDatabase } from '../pglite.js';
import { fixtureFiles as geoFiles } from '../ingest/geo/helpers.js';
import { fixtureFiles } from './helpers.js';

const db = testDatabase(new PGlite()), token = 'synthetic-location-test-token';
const plan = '87226TX0100013', syntheticAkPlan = plan.replace('TX', 'AK');
let directory: string, core: Awaited<ReturnType<typeof coreMigrations>>;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'openplans-location-'));
  core = await coreMigrations(); await migrate(db, core.directory);
  await ingestGeo(db, { files: await geoFiles() });
  expect((await importPufs(db, { year: 2026, state: 'TX', files: await fixtureFiles(directory), dataDir: directory })).status).toBe('ACTIVE');
  await ingestRatingRules(db);
});
afterAll(async () => { await db.close(); await core.cleanup(); await rm(directory, { recursive: true, force: true }); });
async function rollback(run: (tx: SqlSession) => Promise<void>) {
  const marker = new Error('synthetic location rollback');
  await expect(db.transaction(async tx => { await run(tx); throw marker; })).rejects.toBe(marker);
}
async function quote(tx: SqlSession, county: string, id: string, zip?: string) {
  const response = await createApp(tx, { premiumToken: token }).request('/v1/premium-estimates', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ plan_ids: [id], county, ...(zip ? { zip } : {}), coverage_start: '2026-01-01',
      members: [{ age: 35, tobacco: false, relationship: 'subscriber' }] }),
  });
  expect(response.status).toBe(200);
  return (await response.json() as any).estimates[0];
}
async function listed(tx: SqlSession, county: string, zip?: string) {
  const response = await createApp(tx).request(`/v1/plans?county=${county}&year=2026${zip ? `&zip=${zip}` : ''}`);
  expect(response.status).toBe(200);
  return (await response.json() as any).plans;
}

// Explicitly synthetic AK catalog/geography derived from TX test rows. These prices
// test routing only; the full smoke compares actual AK raw PUF rows independently.
async function syntheticAlaska(tx: SqlSession) {
  await tx.exec(`UPDATE puf_active_catalog SET state='AK'; UPDATE puf_import SET state='AK';
    UPDATE plan SET state='AK',base_plan_id=replace(base_plan_id,'TX','AK');
    UPDATE service_area_county SET state='AK',county_fips='02020';
    UPDATE state_rating_rule SET state='AK';
    UPDATE rate SET state='AK',base_plan_id=replace(base_plan_id,'TX','AK'),rating_area_id='Rating Area 1';
    UPDATE geo_import SET state='AK';
    INSERT INTO zcta_county SELECT '99501','02020','Synthetic Anchorage',arealand_zcta,areawater_zcta,
      arealand_county,areawater_county,arealand_part,areawater_part,snapshot_id,source_row
      FROM zcta_county WHERE zcta='77002';
    INSERT INTO rating_area_zip SELECT 'AK','995','Rating Area 1',plan_year,rating_snapshot_id,2 FROM geo_import;`);
}

it('county pricing and listing availability share the same published area and provenance', async () => {
  const premium = await quote(db, '48201', plan, '77002');
  const available = (await listed(db, '48201', '77002')).find((p: any) => p.base_plan_id === plan).premium_availability;
  expect(available).toEqual({ status: 'available', rating_area_id: premium.rating_area_id,
    rating_area_provenance: premium.rating_area_provenance });
});

it('manifest requires rating geography as well as supported policy and rates', async () => {
  await rollback(async tx => {
    await tx.exec('DELETE FROM geo_import');
    const response = await createApp(tx).request('/v1/data-availability?state=TX&year=2026');
    expect(response.status).toBe(200);
    const entries = await response.json() as any[];
    expect(entries.find(e => e.issuer_id === '87226')).toMatchObject({ premium_status: 'unknown',
      premium_reason: 'UNRESOLVED_RATING_AREA', rating_area_geography: null });
  });
});

it('serves a synthetic national-size manifest without exhausting database connections, retaining exact rate counts', async () => {
  let active = 0, peak = 0;
  const capped: SqlSession = {
    exec: db.exec,
    query: async <Row extends Record<string, unknown>>(sql: string, parameters?: unknown[]) => {
      active++; peak = Math.max(peak, active);
      try {
        if (active > 4) throw new Error('synthetic pool checkout timeout');
        const result = await db.query<Row>(sql, parameters);
        // Labelled synthetic fanout fixture, using unmodified real-cut evidence.
        return { rows: sql.includes('FROM data_availability') ? result.rows.flatMap(row => Array(20).fill(row) as Row[]) : result.rows };
      } finally { active--; }
    },
  };
  // Negative control proves this fixture rejects the old unbounded fanout.
  const unbounded = await Promise.allSettled(Array.from({ length: 5 }, () => capped.query('SELECT 1')));
  expect(unbounded.some(result => result.status === 'rejected')).toBe(true);
  peak = 0;
  const response = await createApp(capped).request('/v1/data-availability?state=TX&year=2026');
  expect(response.status).toBe(200);
  expect(peak).toBeLessThanOrEqual(4);
  const entries = await response.json() as any[];
  expect(entries.length).toBeGreaterThan(40);
  expect(entries.filter(e => e.issuer_id === '87226').every(e => e.rate_rows === 51)).toBe(true);
});

it('uses ZIP3 for Alaska; county-only and missing ZIP3 evidence stay unknown with reasons', async () => {
  await rollback(async tx => {
    await syntheticAlaska(tx);
    expect(await quote(tx, '02020', syntheticAkPlan, '99501')).toMatchObject({ status: 'rated', rating_area_id: 'Rating Area 1', total_cents: 52928 });
    const available = (await listed(tx, '02020', '99501')).find((p: any) => p.base_plan_id === syntheticAkPlan).premium_availability;
    expect(available).toMatchObject({ status: 'available', rating_area_id: 'Rating Area 1' });
    for (const removePrefix of [false, true]) {
      if (removePrefix) await tx.exec('DELETE FROM rating_area_zip');
      const result = await quote(tx, '02020', syntheticAkPlan, removePrefix ? '99501' : undefined);
      expect(result).toMatchObject({ status: 'unknown', reason: 'UNRESOLVED_RATING_AREA' });
      expect(result).not.toHaveProperty('total_cents');
      const p = (await listed(tx, '02020', removePrefix ? '99501' : undefined)).find((p: any) => p.base_plan_id === syntheticAkPlan);
      expect(p.premium_availability).toEqual({ status: 'unknown', reason: 'UNRESOLVED_RATING_AREA' });
    }
  });
});

it('negative control: a synthetic ZIP3 mapped to two areas is ambiguous, never priced', async () => {
  await rollback(async tx => {
    await syntheticAlaska(tx);
    // Permit conflicting evidence only in this rolled-back synthetic fixture.
    await tx.exec(`ALTER TABLE rating_area_zip DROP CONSTRAINT rating_area_zip_pkey;
      INSERT INTO rating_area_zip SELECT state,zip_prefix,'Rating Area 2',plan_year,snapshot_id,3 FROM rating_area_zip;`);
    const result = await quote(tx, '02020', syntheticAkPlan, '99501');
    expect(result).toMatchObject({ status: 'ambiguous', reason: 'UNRESOLVED_RATING_AREA', members: [], rate_rows_used: [] });
    expect(result).not.toHaveProperty('total_cents');
    const p = (await listed(tx, '02020', '99501')).find((p: any) => p.base_plan_id === syntheticAkPlan);
    expect(p.premium_availability).toEqual({ status: 'ambiguous', reason: 'UNRESOLVED_RATING_AREA' });
  });
});

it('negative control: a mutant Anchorage area fails the exact premium assertion', async () => {
  await rollback(async tx => {
    await syntheticAlaska(tx);
    await tx.exec("UPDATE rating_area_zip SET rating_area_id='Rating Area 2'");
    const result = await quote(tx, '02020', syntheticAkPlan, '99501');
    expect(() => assert.equal(result.total_cents, 52928, 'raw-row premium check')).toThrow('raw-row premium check');
    expect(result).not.toHaveProperty('total_cents');
  });
});
