import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { coreMigrations, testDatabase } from '../../pglite.js';
import { migrate } from '../../../src/db/migrate.js';
import { importRxnorm } from '../../../src/ingest/rxnorm/import.js';
import { createRxnormRepository } from '../../../src/ingest/rxnorm/repository.js';
import { runWorker } from '../../../src/worker/commands.js';
import * as acquisition from '../../../src/ingest/rxnorm/acquire.js';
import { runRxnorm } from '../../../src/ingest/rxnorm/command.js';
import { fixture, input, metadata, zip } from './helpers.js';
import type { Fixture } from './helpers.js';
import type { ImportOptions } from '../../../src/ingest/rxnorm/import.js';

describe('RxNorm CPC import and exact concept helpers', () => {
  const pg = new PGlite(), db = testDatabase(pg), repo = createRxnormRepository(db);
  let directory: string, options: ImportOptions, files: Fixture;
  beforeAll(async () => {
    const migrations = await coreMigrations();
    try { await migrate(db, migrations.directory); } finally { await migrations.cleanup(); }
    directory = await mkdtemp(join(tmpdir(), 'rxnorm-import-'));
    files = await fixture();
    const bytes = zip(files), path = join(directory, 'fixture.zip'); await writeFile(path, bytes);
    options = { version: '2026-11-02', path, metadata: metadata(bytes) };
  });
  afterAll(async () => { await db.close(); await rm(directory, { recursive: true, force: true }); });
  it('imports all three streamed files with provenance and reimports as a no-op', async () => {
    const report = await importRxnorm(db, options);
    expect(report.outcome).toBe('imported');
    expect(report.concepts).toBeGreaterThan(10); expect(report.relations).toBeGreaterThan(10); expect(report.ndcs).toBeGreaterThan(5);
    expect(await importRxnorm(db, options)).toMatchObject({ ...report, outcome: 'noop', elapsed_ms: expect.any(Number) });
    expect((await db.query('SELECT validation_state,fetched_children,expected_children FROM snapshot')).rows)
      .toEqual([{ validation_state: 'ACTIVE', fetched_children: 3, expected_children: 3 }]);
    expect((await db.query('SELECT count(*)::int AS n FROM rx_concept WHERE snapshot_id IS NULL OR source_record<1')).rows).toEqual([{ n: 0 }]);
  });
  it('returns case-insensitive literal substring candidates with TTY, SCD/SBD first, and no implicit fuzzy resolution', async () => {
    for (const name of ['metformin','lisinopril','lipitor']) {
      const found = await repo.searchDrugs(name.toUpperCase());
      expect(found.length).toBeGreaterThan(1); expect(['SCD','SBD']).toContain(found[0]?.tty);
      expect(found.every(row => row.name.toLowerCase().includes(name))).toBe(true);
      for (const row of found) {
        const source = files['RXNCONSO.RRF'].split('\n')[row.source_record - 1]!.split('|');
        expect(source[0]).toBe(row.rxcui); expect(source[14]).toBe(row.name); expect(source[12]).toBe(row.tty);
      }
      expect((await repo.searchDrugs(name.slice(2))).length).toBe(found.length);
      expect((await repo.conceptByRxcui(found[0]!.rxcui)).some(row => row.name === found[0]!.name)).toBe(true);
    }
    expect(await repo.searchDrugs('lipitro')).toEqual([]);
    expect(await repo.searchDrugs('%')).toEqual([]);
    expect(await repo.searchDrugs(' ')).toEqual([]);
    expect(await repo.conceptByRxcui('999999999999999')).toEqual([]);
    await expect(repo.conceptByRxcui('Lipitor')).rejects.toThrow('exact');
  });
  async function assertNdcRoundtrip() {
    const mapping = (await db.query<{ rxcui: string; ndc: string }>("SELECT rxcui,ndc FROM rx_ndc WHERE ndc='00071015523' AND suppress='N' LIMIT 1")).rows[0]!;
    expect(mapping).toBeDefined(); expect(mapping.ndc).toMatch(/^0\d{10}$/);
    expect(await repo.rxcuisForNdc(mapping.ndc)).toContain(mapping.rxcui);
    expect(await repo.ndcsForRxcui(mapping.rxcui)).toContain(mapping.ndc);
  }
  it('negative control: parsing published NDC strings as numbers breaks leading-zero roundtrip', async () => {
    await assertNdcRoundtrip();
    const original = repo.ndcsForRxcui;
    repo.ndcsForRxcui = async rxcui => (await original(rxcui)).map(ndc => String(Number(ndc)));
    try { await expect(assertNdcRoundtrip()).rejects.toThrow(); } finally { repo.ndcsForRxcui = original; }
    await expect(repo.rxcuisForNdc('71015523')).rejects.toThrow('11-digit');
  });
  it('negative control: a suppressed real concept is hidden unless explicitly requested', async () => {
    const bn = (await repo.searchDrugs('lipitor')).find(row => row.tty === 'BN')!;
    // Synthetic mutant of real CPC rows: the public subset itself excludes suppressed concepts.
    await db.query("UPDATE rx_concept SET suppress='Y' WHERE rxcui=$1", [bn.rxcui]);
    try {
      expect((await repo.searchDrugs('lipitor')).some(row => row.rxcui === bn.rxcui)).toBe(false);
      expect((await repo.searchDrugs('lipitor', { includeSuppressed: true })).some(row => row.rxcui === bn.rxcui && row.suppress === 'Y')).toBe(true);
      const check = async (includeSuppressed: boolean) => expect((await repo.searchDrugs('lipitor', { includeSuppressed })).every(row => row.suppress === 'N')).toBe(true);
      await check(false); await expect(check(true)).rejects.toThrow();
    } finally { await db.query("UPDATE rx_concept SET suppress='N' WHERE rxcui=$1", [bn.rxcui]); }
  });
  async function assertBrandIngredients() {
    const candidates = await repo.searchDrugs('lipitor');
    expect(candidates.some(row => row.tty === 'SBD')).toBe(true);
    const brand = candidates.find(row => row.tty === 'BN')!;
    expect(brand).toBeDefined();
    const links = (await db.query(`SELECT r.target_rxcui FROM rx_relation r JOIN rx_concept c
      ON c.snapshot_id=r.snapshot_id AND c.rxcui=r.target_rxcui
      WHERE r.source_rxcui=$1 AND r.rela='tradename_of' AND c.tty='IN' AND lower(c.name)='atorvastatin'`, [brand.rxcui])).rows;
    expect(links.length).toBeGreaterThan(0);
    expect((await repo.ingredientsOf(brand.rxcui)).some(row => row.name.toLowerCase() === 'atorvastatin' && row.tty === 'IN')).toBe(true);
    const sbd = candidates.find(row => row.tty === 'SBD')!;
    expect((await repo.ingredientsOf(sbd.rxcui)).some(row => row.name.toLowerCase() === 'atorvastatin')).toBe(true);
  }
  it('negative control: dropping tradename_of breaks Lipitor → atorvastatin resolution', async () => {
    await assertBrandIngredients();
    const removed = (await db.query('DELETE FROM rx_relation WHERE rela=$1 RETURNING *', ['tradename_of'])).rows;
    try { await expect(assertBrandIngredients()).rejects.toThrow(); } finally {
      for (const r of removed) await db.query('INSERT INTO rx_relation(snapshot_id,source_rxcui,target_rxcui,rela,suppress,source_record) VALUES($1,$2,$3,$4,$5,$6)',
        [r.snapshot_id,r.source_rxcui,r.target_rxcui,r.rela,r.suppress,r.source_record]);
    }
  });
  it('quarantines a malformed later release atomically and keeps the last active terminology', async () => {
    const before = await repo.searchDrugs('lipitor');
    const mutated = { ...files, 'RXNSAT.RRF': files['RXNSAT.RRF'].replace(/\|NDC\|RXNORM\|\d+\|/, '|NDC|RXNORM|123|') };
    const bytes = zip(mutated), path = join(directory, 'mutant.zip'); await writeFile(path, bytes);
    await expect(importRxnorm(db, { version: '2026-12-07', path, metadata: metadata(bytes), input: input(mutated) })).rejects.toThrow('11 published');
    expect(await repo.searchDrugs('lipitor')).toEqual(before);
    expect((await db.query("SELECT validation_state FROM snapshot WHERE validation_state='QUARANTINED'")).rows).toHaveLength(1);
    expect((await db.query('SELECT * FROM rx_release')).rows).toHaveLength(1);
    await expect(importRxnorm(db, { ...options, metadata: { ...options.metadata, sha256: '0'.repeat(64) } })).rejects.toThrow('hash mismatch');
  });
  it('dispatches worker ingest rxnorm and closes its database after a cached import', async () => {
    const spy = vi.spyOn(acquisition, 'acquireRelease').mockResolvedValue({ version: options.version, url: options.metadata.url, path: options.path, metadata: options.metadata });
    const migrations = await coreMigrations(), messages: string[] = [];
    const close = vi.fn(async () => {});
    try {
      expect(await runWorker(['ingest','rxnorm'], () => ({ ...db, close }), { out: text => messages.push(text), error: text => messages.push(text) }, migrations.directory)).toBe(0);
      expect(JSON.parse(messages[0]!)).toMatchObject({ outcome: 'noop', source_version: options.version });
      expect(close).toHaveBeenCalledOnce();
    } finally { spy.mockRestore(); await migrations.cleanup(); }
  });
  it('validates worker arguments and returns a safe database failure', async () => {
    const errors: string[] = [], out = { out: () => {}, error: (text: string) => errors.push(text) };
    let opened = false;
    expect(await runRxnorm(['--state','TX'], () => { opened = true; return db; }, out)).toBe(1);
    expect(opened).toBe(false);
    expect(await runRxnorm([], () => { throw new Error('synthetic credential must be hidden'); }, out)).toBe(1);
    expect(errors.join(' ')).not.toContain('synthetic credential');
  });
});
