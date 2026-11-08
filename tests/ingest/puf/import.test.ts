import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { coreMigrations, testDatabase } from '../../pglite.js';
import { migrate } from '../../../src/db/migrate.js';
import { importPufs, plansForCounty } from '../../../src/ingest/puf/import.js';
import type { ImportFile, PufImportReport } from '../../../src/ingest/puf/import.js';
import { IMPORT_KINDS } from '../../../src/ingest/puf/import-source.js';
import { Readable } from 'node:stream';
import { readCsv } from '../../../src/ingest/csv/index.js';
import { runWorker } from '../../../src/worker/commands.js';

const fixtures = fileURLToPath(new URL('../../fixtures/puf/import/', import.meta.url));
async function fixtureFiles(): Promise<ImportFile[]> {
  const provenance = JSON.parse(await readFile(join(fixtures, 'provenance.json'), 'utf8'));
  return Promise.all(IMPORT_KINDS.map(async kind => {
    const path = join(fixtures, `${kind}.csv`), data = await readFile(path);
    return { kind, path, format: 'csv', sha256: createHash('sha256').update(data).digest('hex'), bytes: data.length,
      retrievedAt: '2026-11-07T07:33:40.115Z', url: provenance.files.find((f: { kind: string }) => f.kind === kind).url };
  }));
}
async function mutate(files: ImportFile[], directory: string, kind: ImportFile['kind'], change: (rows: Record<string, string>[]) => void) {
  const original = files.find(file => file.kind === kind)!;
  const rows = [];
  for await (const row of readCsv(Readable.from([await readFile(original.path)]))) rows.push(row.values);
  change(rows);
  const keys = Object.keys(rows[0]!);
  const quote = (value: string) => `"${value.replace(/"/g, '""')}"`;
  const data = Buffer.from([keys.map(quote).join(','), ...rows.map(row => keys.map(key => quote(row[key]!)).join(','))].join('\n') + '\n');
  const path = join(directory, `synthetic-mutant-${kind}.csv`);
  await writeFile(path, data);
  return files.map(file => file.kind === kind ? { ...file, path, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') } : file);
}

describe('PUF catalog import — real CMS TX 2026 cuts and labelled synthetic mutants', () => {
  const pg = new PGlite(), db = testDatabase(pg);
  let directory: string, core: Awaited<ReturnType<typeof coreMigrations>>, files: ImportFile[], baseline: PufImportReport;
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'openplans-puf-import-'));
    core = await coreMigrations();
    await migrate(db, core.directory);
    files = await fixtureFiles();
    baseline = await importPufs(db, { year: 2026, state: 'TX', files, dataDir: directory });
  });
  afterAll(async () => { await db.close(); await core?.cleanup(); await rm(directory, { recursive: true, force: true }); });

  it('reconciles exact selected-state rows, separates base/variant keys and preserves raw evidence', async () => {
    expect(baseline.status, JSON.stringify(baseline)).toBe('ACTIVE');
    expect(baseline.files.map(file => [file.kind, file.input_rows, file.stored_rows])).toEqual([
      ['plan-attributes', 3, 3], ['service-area', 40, 40], ['network', 3, 3], ['business-rules', 3, 3], ['rate', 153, 153], ['benefits-and-cost-sharing', 15, 15],
    ]);
    expect(baseline.identifiers).toEqual({ attribute_14: 0, attribute_17: 3, base_plans: 3, variants: 3, rate_14: 153, rate_17: 0 });
    expect((await db.query('SELECT DISTINCT state FROM rate')).rows).toEqual([{ state: 'TX' }]);
    const rate = (await db.query('SELECT *,effective_date::text AS effective_date,expiration_date::text AS expiration_date FROM rate ORDER BY source_row LIMIT 1')).rows[0]!;
    expect(rate).toMatchObject({ effective_date: expect.any(String), expiration_date: expect.any(String), age_band: '0-14', source_row: expect.any(Number) });
    expect(Number(rate.individual_rate_cents)).toBe(Math.round(Number((rate.raw as Record<string, string>).IndividualRate) * 100));
    expect((await db.query('SELECT raw,cost_sharing_raw,cost_sharing_parsed FROM plan_benefit LIMIT 1')).rows[0]).toBeTruthy();
    expect(JSON.parse(await readFile(baseline.report_json, 'utf8')).passed).toBe(true);
    expect(await readFile(baseline.report_md, 'utf8')).toContain('| rate | 153 | 153 | 0 |');
    expect((await db.query('SELECT validation_state FROM snapshot')).rows.every(r => r.validation_state === 'ACTIVE')).toBe(true);
  });

  it('D3: includes a real statewide area with blank county, without crossing state/year/market', async () => {
    const plans = await plansForCounty(db, '48201', 2026, 'Individual');
    expect(plans.find(p => p.issuer_id === '12846')).toMatchObject({ zip_restricted: false, zip_codes: [], dental_only: true });
    expect(await plansForCounty(db, '36061', 2026, 'Individual')).toEqual([]);
    expect(await plansForCounty(db, '48201', 2027, 'Individual')).toEqual([]);
    expect(await plansForCounty(db, '48201', 2026, 'SHOP (Small Group)')).toEqual([]);
  });

  it('D4: returns the real partial-county ZIP restrictions', async () => {
    const plans = await plansForCounty(db, '48209', 2026, 'Individual');
    expect(plans.find(p => p.issuer_id === '66252')).toMatchObject({ zip_restricted: true, zip_codes: ['78666'], raw_zip_codes: ['78666'] });
  });

  it('negative control: ten missing rate rows quarantine the entire replacement and preserve ACTIVE service', async () => {
    const broken = await mutate(files, directory, 'rate', rows => {
      const index = rows.findIndex(r => r.StateCode === 'TX');
      rows.splice(index, 10);
    });
    const report = await importPufs(db, { year: 2026, state: 'TX', files: broken, dataDir: directory });
    expect(report.status).toBe('QUARANTINED');
    expect(report.checks.find(c => c.code === 'incomplete_rate_age_bands')?.count).toBe(1);
    expect(report.files.find(f => f.kind === 'rate')).toMatchObject({ input_rows: 143, stored_rows: 143 });
    expect((await db.query('SELECT import_id FROM puf_active_catalog')).rows).toEqual([{ import_id: baseline.import_id }]);
    expect((await db.query('SELECT validation_state FROM snapshot WHERE snapshot_id=$1', [baseline.import_id])).rows[0]!.validation_state).toBe('ACTIVE');
    expect((await plansForCounty(db, '48201', 2026, 'Individual')).every(p => p.snapshot_id.startsWith(baseline.import_id))).toBe(true);
    expect((await db.query('SELECT validation_state FROM snapshot WHERE snapshot_id LIKE $1', [`${report.import_id}%`])).rows.every(r => r.validation_state === 'QUARANTINED')).toBe(true);
  });

  it('negative control: rejects a 13-character HIOS ID with a row-addressed quality issue', async () => {
    const broken = await mutate(files, directory, 'plan-attributes', rows => { rows.find(r => r.StateCode === 'TX')!.PlanId = '11718TX014001'; });
    const report = await importPufs(db, { year: 2026, state: 'TX', files: broken, dataDir: directory });
    expect(report.status).toBe('QUARANTINED');
    const issues = (await db.query('SELECT source_record,issue_code FROM quality_issue WHERE snapshot_id=$1', [`${report.import_id}:plan-attributes`])).rows;
    expect(issues).toContainEqual({ source_record: '3', issue_code: 'invalid_source_row' });
    expect(report.files.find(f => f.kind === 'plan-attributes')).toMatchObject({ input_rows: 3, stored_rows: 2, rejected_rows: 1 });
  });

  it('negative control: an uncited NY mutant never acquires a computed rating method', async () => {
    let mutant = files;
    for (const kind of IMPORT_KINDS) mutant = await mutate(mutant, directory, kind, rows => {
      for (const row of rows) if (row.StateCode === 'TX') {
        row.StateCode = 'NY';
        for (const key of ['StandardComponentId', 'PlanId', 'ProductId', 'NetworkId', 'ServiceAreaId']) if (row[key]) row[key] = row[key]!.replace('TX', 'NY');
      }
    });
    const report = await importPufs(db, { year: 2026, state: 'NY', files: mutant, dataDir: directory });
    expect(report.status).toBe('ACTIVE');
    expect((await db.query('SELECT DISTINCT method,citation FROM state_rating_rule WHERE state=$1', ['NY'])).rows).toEqual([{ method: 'unsupported', citation: null }]);
  });

  it('negative control: hash corruption and a missing critical header cannot replace the catalog', async () => {
    const corrupted = files.map(file => file.kind === 'rate' ? { ...file, sha256: '0'.repeat(64) } : file);
    const report = await importPufs(db, { year: 2026, state: 'TX', files: corrupted, dataDir: directory });
    expect(report.status).toBe('QUARANTINED');
    expect(report.files.find(f => f.kind === 'rate')!.stored_rows).toBe(0);
    const broken = await mutate(files, directory, 'service-area', rows => { for (const row of rows) delete row.CoverEntireState; });
    expect((await importPufs(db, { year: 2026, state: 'TX', files: broken, dataDir: directory })).status).toBe('QUARANTINED');
    expect((await db.query("SELECT import_id FROM puf_active_catalog WHERE state='TX'")).rows).toEqual([{ import_id: baseline.import_id }]);
  });

  it('D6: stores every synthetic family-tier amount and preserves conditional cost-sharing text', async () => {
    // Labelled synthetic mutation of real rows exercises rare family-tier columns.
    let family = await mutate(files, directory, 'rate', rows => {
      const first = rows.find(row => row.StateCode === 'TX')!;
      const plan = first.PlanId;
      for (let index = rows.length - 1; index >= 0; index--) {
        if (rows[index]!.StateCode === 'TX' && rows[index]!.PlanId === plan && rows[index] !== first) rows.splice(index, 1);
      }
      Object.assign(first, { Age: 'Family Option', RateEffectiveDate: '2026-02-01', RateExpirationDate: '2026-11-30',
        Couple: '100.01', PrimarySubscriberAndOneDependent: '200.02', PrimarySubscriberAndTwoDependents: '300.03',
        PrimarySubscriberAndThreeOrMoreDependents: '400.04', CoupleAndOneDependent: '500.05', CoupleAndTwoDependents: '600.06', CoupleAndThreeOrMoreDependents: '700.07' });
    });
    family = await mutate(family, directory, 'benefits-and-cost-sharing', rows => {
      Object.assign(rows.find(row => row.StateCode === 'TX')!, { CopayInnTier1: '$30 after deductible', CoinsInnTier1: '30% coinsurance', CopayOutofNet: '$12.34' });
    });
    const report = await importPufs(db, { year: 2026, state: 'TX', files: family, dataDir: directory });
    expect(report.status).toBe('ACTIVE');
    const rate = (await db.query(`SELECT *,effective_date::text AS effective_date,expiration_date::text AS expiration_date
      FROM rate WHERE snapshot_id=$1 AND age_band='Family Option'`, [`${report.import_id}:rate`])).rows[0]!;
    expect(rate).toMatchObject({ effective_date: '2026-02-01', expiration_date: '2026-11-30', rating_method: 'family_tier' });
    expect(['couple_cents', 'primary_subscriber_and_one_dependent_cents', 'primary_subscriber_and_two_dependents_cents',
      'primary_subscriber_and_three_or_more_dependents_cents', 'couple_and_one_dependent_cents', 'couple_and_two_dependents_cents',
      'couple_and_three_or_more_dependents_cents'].map(key => Number(rate[key]))).toEqual([10001, 20002, 30003, 40004, 50005, 60006, 70007]);
    const benefit = (await db.query('SELECT cost_sharing_raw,cost_sharing_parsed FROM plan_benefit WHERE snapshot_id=$1 ORDER BY source_row LIMIT 1',
      [`${report.import_id}:benefits-and-cost-sharing`])).rows[0]!;
    expect(benefit.cost_sharing_raw).toMatchObject({ CopayInnTier1: '$30 after deductible', CoinsInnTier1: '30% coinsurance' });
    expect(benefit.cost_sharing_parsed).toMatchObject({ CopayInnTier1: null, CoinsInnTier1: null, CopayOutofNet: { cents: 1234 } });
  });

  it('dispatches the import branch and rejects bad CLI flags before connecting', async () => {
    const errors: string[] = [];
    expect(await runWorker(['ingest', 'puf', 'import', '--year', '2026', '--state', 'TX', '--extra'], () => { throw new Error('must not open'); },
      { out: () => {}, error: message => errors.push(message) }, core.directory)).toBe(1);
    expect(errors[0]).toContain('Usage: worker ingest puf import');
  });
});
