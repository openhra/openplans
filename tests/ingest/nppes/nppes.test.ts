import { PGlite } from '@electric-sql/pglite';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { migrate } from '../../../src/db/migrate.js';
import type { Database } from '../../../src/db/database.js';
import { coreMigrations, testDatabase } from '../../pglite.js';
import { importNppes } from '../../../src/ingest/nppes/import.js';
import type { ImportOptions } from '../../../src/ingest/nppes/import.js';
import { providerByNpi, providersNearZip } from '../../../src/ingest/nppes/lookup.js';
import { deactivationCsv } from '../../../src/ingest/nppes/input.js';
import { discoverReleases, sourceId } from '../../../src/ingest/nppes/acquire.js';
import { validNpi } from '../../../src/ingest/nppes/parse.js';
import { readRecords } from '../../../src/ingest/csv/index.js';
import { runNppes } from '../../../src/ingest/nppes/command.js';

const fixtures = fileURLToPath(new URL('../../fixtures/nppes/', import.meta.url));
const provenance = JSON.parse(await readFile(join(fixtures, 'provenance.json'), 'utf8')) as {
  source: string; deactivation_source: string; data_date: string; labels: Record<string, string>;
};
const main = await readFile(join(fixtures, 'providers-v2.csv'), 'utf8');
const secondary = await readFile(join(fixtures, 'practice-locations.csv'), 'utf8');
async function* textInput(value: string) { const bytes = Buffer.from(value); for (let i = 0; i < bytes.length; i += 79) yield bytes.subarray(i, i + 79); }
async function mutateMain(npi: string, changes: Record<string, string>, content = main): Promise<string> {
  const records = [];
  for await (const record of readRecords(textInput(content))) records.push(record.fields);
  const header = records[0]!;
  for (const fields of records.slice(1)) if (fields[0] === npi) {
    for (const [key, value] of Object.entries(changes)) fields[header.indexOf(key)] = value;
  }
  return records.map(fields => fields.map(s => `"${s.replaceAll('"', '""')}"`).join(',')).join('\r\n') + '\r\n';
}
let db: Database, directory: string, cleanup: () => Promise<void>;
async function options(content = main, extra: Partial<ImportOptions> = {}): Promise<ImportOptions> {
  const path = join(directory, `${createHash('sha256').update(content).digest('hex')}.csv`);
  await writeFile(path, content);
  return { kind: 'full', state: 'TX', path, url: provenance.source, metadata: {
    snapshot_id: 'fixture', source: sourceId, url: provenance.source, final_url: provenance.source,
    redirect_chain: [], status: 200, content_type: 'text/csv', etag: null, last_modified: null,
    sha256: createHash('sha256').update(content).digest('hex'), bytes: Buffer.byteLength(content), fetched_at: '2026-11-07T00:00:00Z',
  }, fixture: { dataDate: provenance.data_date, input: { main: () => createReadStream(path), secondary: () => textInput(secondary) } }, ...extra };
}
beforeEach(async () => {
  db = testDatabase(new PGlite()); const core = await coreMigrations(); cleanup = core.cleanup;
  await migrate(db, core.directory); directory = await mkdtemp(join(tmpdir(), 'openplans-nppes-test-')); vi.stubEnv('OPENPLANS_DATA_DIR', directory);
});
afterEach(async () => { vi.unstubAllEnvs(); await db?.close(); await cleanup?.(); if (directory) await rm(directory, { recursive: true, force: true }); });

describe('NPPES V2 public identity import', () => {
  it('imports real individual/organization identities, ZIP+4, taxonomy and every practice; idempotent', async () => {
    const config = await options(), report = await importNppes(db, config);
    expect(report.outcome).toBe('imported'); expect(report.kept).toBeGreaterThanOrEqual(3);
    expect(report.skipped).toBeGreaterThan(0);
    const individual = await providerByNpi(db, provenance.labels.individual!);
    expect(individual?.entity_type).toBe('1'); expect(individual?.taxonomies.length).toBeGreaterThan(0);
    expect((await providerByNpi(db, provenance.labels.organization!))?.entity_type).toBe('2');
    expect(await providerByNpi(db, provenance.labels.out_of_state!)).toBeNull();
    // D7 negative control: taking only the primary location would fail this exact assertion.
    const multi = await providerByNpi(db, provenance.labels.three_practices!);
    expect(multi?.addresses.filter(a => a.kind === 'practice')).toHaveLength(3);
    expect(multi?.addresses.every(a => a.snapshot_id === report.snapshot_id)).toBe(true);
    const zipAddress = multi!.addresses.find(a => a.kind === 'practice' && a.zip5);
    expect(zipAddress).toBeTruthy();
    expect(multi?.addresses.find(a => a.kind === 'practice' && a.ordinal === 0)).toMatchObject({
      postal_code: '758016901', zip5: '75801', zip4: '6901', phone: '9037232311',
    });
    const nearby = await providersNearZip(db, zipAddress!.zip5 as string);
    expect(nearby.map(p => p.npi)).toContain(multi!.npi);
    expect(new Set(nearby.map(p => p.npi)).size).toBe(nearby.length);
    expect(await providersNearZip(db, zipAddress!.zip5 as string, '0000000000')).toEqual([]);
    expect(await providersNearZip(db, zipAddress!.zip5 as string, multi!.taxonomies[0]!.code as string))
      .toEqual(expect.arrayContaining([expect.objectContaining({ npi: multi!.npi })]));
    expect(multi).not.toHaveProperty('latitude'); expect(multi).not.toHaveProperty('participating');
    expect((await importNppes(db, config)).outcome).toBe('noop');
    expect((await db.query('SELECT * FROM npi_import_run')).rows).toHaveLength(1);
  });

  it('streams the real cuts through synthetic ZIP containers and the nested deactivation XLSX reader', async () => {
    async function archive(hex: string, kind: 'full' | 'deactivation') {
      const bytes = Buffer.from((await readFile(join(fixtures, hex), 'utf8')).trim(), 'hex');
      const config = await options('', { kind, url: kind === 'full' ? provenance.source : provenance.deactivation_source });
      config.path = join(directory, `${kind}.zip`); await writeFile(config.path, bytes);
      config.metadata.url = config.url; config.metadata.final_url = config.url;
      config.metadata.sha256 = createHash('sha256').update(bytes).digest('hex'); config.metadata.bytes = bytes.length;
      delete config.fixture; return config;
    }
    const full = await importNppes(db, await archive('synthetic-bundle-v2.zip.hex', 'full'));
    expect((await providerByNpi(db, provenance.labels.three_practices!))?.addresses.filter(a => a.kind === 'practice')).toHaveLength(3);
    const deactivation = await importNppes(db, await archive('synthetic-deactivation-v2.zip.hex', 'deactivation'));
    expect(deactivation.providers).toBe(full.providers);
    expect((await providerByNpi(db, provenance.labels.deactivated!))?.deactivated).toBe(true);
  });

  it('keeps an out-of-state primary identity when a secondary practice is TX; mailing alone does not qualify', async () => {
    await importNppes(db, await options());
    const provider = await providerByNpi(db, provenance.labels.secondary_tx_only!);
    expect(provider?.addresses.find(a => a.kind === 'practice' && a.ordinal === 0)?.state).not.toBe('TX');
    expect(provider?.addresses.some(a => a.kind === 'practice' && a.state === 'TX')).toBe(true);
    const mailingMutant = await mutateMain(provenance.labels.out_of_state!, { 'Provider Business Mailing Address State Name': 'TX' });
    await importNppes(db, await options(mailingMutant));
    expect(await providerByNpi(db, provenance.labels.out_of_state!)).toBeNull();
  });

  it('negative control: a synthetic deactivation event flags, retains and returns a real identity with separate status provenance', async () => {
    await importNppes(db, await options()); const npi = provenance.labels.individual!;
    const before = await providerByNpi(db, npi);
    // Explicit synthetic mutant of the real report shape, not a claim about this person's status.
    const mutant = `"NPI","NPPES Deactivation Date"\n"${npi}","11/06/2026"\n`;
    const config = await options(mutant, { kind: 'deactivation', url: provenance.deactivation_source });
    config.metadata.url = config.url; config.metadata.final_url = config.url;
    config.fixture = { dataDate: '2026-11-06', input: { deactivations: () => deactivationCsv(textInput(mutant)) } };
    const result = await importNppes(db, config);
    const after = await providerByNpi(db, npi);
    expect(after?.deactivated).toBe(true); expect(after?.deactivation_date).toBe('2026-11-06');
    expect(after?.snapshot_id).toBe(before?.snapshot_id); expect(after?.status_snapshot_id).toBe(result.snapshot_id);
    expect(after?.addresses).toEqual(before?.addresses); expect(after?.taxonomies).toEqual(before?.taxonomies);
    expect(result.providers).toBe((await db.query('SELECT * FROM npi_provider')).rows.length);
  });

  it('reads the real public deactivation cut without fabricating state for redacted NPIs', async () => {
    await importNppes(db, await options());
    const content = await readFile(join(fixtures, 'deactivations.csv'), 'utf8');
    const config = await options(content, { kind: 'deactivation', url: provenance.deactivation_source });
    config.metadata.url = config.url; config.metadata.final_url = config.url;
    config.fixture = { dataDate: provenance.data_date, input: { deactivations: () => deactivationCsv(textInput(content)) } };
    expect((await importNppes(db, config)).kept).toBeGreaterThan(0);
    const deactivated = await providerByNpi(db, provenance.labels.deactivated!);
    expect(deactivated?.deactivated).toBe(true); expect(deactivated?.entity_type).toBeNull();
    expect(deactivated?.addresses.some(a => a.kind === 'practice' && a.state === 'TX')).toBe(true);
  });

  it('negative control: bad 80840-prefixed Luhn check digit becomes quality_issue and is not imported', async () => {
    const npi = provenance.labels.individual!, bad = npi.slice(0, -1) + ((Number(npi.at(-1)) + 1) % 10);
    expect(validNpi(npi)).toBe(true); expect(validNpi(bad)).toBe(false);
    const report = await importNppes(db, await options(main.replaceAll(`"${npi}"`, `"${bad}"`)));
    expect(report.invalid).toBeGreaterThan(0); expect(await providerByNpi(db, npi)).toBeNull();
    expect((await db.query("SELECT * FROM quality_issue WHERE issue_code='invalid_npi_checksum'")).rows.length).toBeGreaterThan(0);
  });

  it('negative control: legacy V1 header layout is rejected and the snapshot quarantined atomically', async () => {
    const config = await options(main.replace('Provider Sex Code', 'Provider Gender Code'));
    await expect(importNppes(db, config)).rejects.toThrow('Wrong NPPES version/layout');
    expect((await db.query('SELECT * FROM npi_provider')).rows).toEqual([]);
    expect((await db.query("SELECT validation_state FROM snapshot WHERE source_id='cms-nppes'")).rows)
      .toEqual([{ validation_state: 'QUARANTINED' }]);
    config.url = config.url.replace('_V2.zip', '.zip'); config.metadata.url = config.url;
    await expect(importNppes(db, config)).rejects.toThrow('Wrong NPPES version/provenance');
  });

  it('negative control: truncated weekly CSV rolls back and preserves the last good identities', async () => {
    await importNppes(db, await options());
    const before = (await db.query('SELECT * FROM npi_provider ORDER BY npi')).rows;
    const corrupt = `${main}\n"unterminated`;
    const config = await options(corrupt, { kind: 'weekly' });
    config.fixture = { dataDate: '2026-11-09', input: { main: () => textInput(corrupt), secondary: () => textInput(secondary) } };
    await expect(importNppes(db, config)).rejects.toThrow();
    expect((await db.query('SELECT * FROM npi_provider ORDER BY npi')).rows).toEqual(before);
  });

  it('applies synthetic weekly movement and same-day reactivation, then ignores a superseded weekly bundle', async () => {
    await importNppes(db, await options()); const npi = provenance.labels.individual!;
    const deactivation = `"NPI","NPPES Deactivation Date"\n"${npi}","11/06/2026"\n`;
    const d = await options(deactivation, { kind: 'deactivation', url: provenance.deactivation_source });
    d.metadata.url = d.url; d.metadata.final_url = d.url;
    d.fixture = { dataDate: '2026-11-06', input: { deactivations: () => deactivationCsv(textInput(deactivation)) } };
    await importNppes(db, d);
    const changed = await mutateMain(npi, { 'NPI Reactivation Date': '11/06/2026', 'Last Update Date': '11/06/2026',
      'Provider Business Practice Location Address State Name': 'CA' });
    const weekly = await options(changed, { kind: 'weekly' });
    weekly.fixture = { dataDate: '2026-11-09', input: { main: () => textInput(changed), secondary: () => textInput(secondary) } };
    await importNppes(db, weekly);
    const updated = await providerByNpi(db, npi);
    expect(updated?.deactivated).toBe(false);
    expect(updated?.addresses.find(a => a.kind === 'practice' && a.ordinal === 0)?.state).toBe('CA');
    const before = (await db.query('SELECT * FROM npi_provider ORDER BY npi')).rows;
    const stale = await options(changed, { kind: 'weekly' });
    stale.fixture = { dataDate: '2026-11-01', input: { main: () => textInput(main), secondary: () => textInput(secondary) } };
    // Distinct hash gives a distinct source snapshot from the newer weekly replay.
    stale.metadata.sha256 = createHash('sha256').update(main).digest('hex');
    stale.path = join(directory, `${stale.metadata.sha256}.csv`); stale.metadata.bytes = Buffer.byteLength(main);
    expect((await importNppes(db, stale)).outcome).toBe('superseded');
    expect((await db.query('SELECT * FROM npi_provider ORDER BY npi')).rows).toEqual(before);
  });

  it('rejects malformed CLI arguments without opening a database', async () => {
    const errors: string[] = [];
    expect(await runNppes([], () => { throw new Error('must not connect'); }, { out: () => {}, error: s => errors.push(s) })).toBe(1);
    expect(errors[0]).toContain('--state TX');
  });

  it('loads TX and FL from the same release without changing any TX identity, address, taxonomy or scope row', async () => {
    // Labelled synthetic state mutation of a public NPPES row. TX and FL read identical bytes.
    const floridaOnly = await mutateMain(provenance.labels.out_of_state!, {
      'Provider Business Practice Location Address State Name': 'FL',
    });
    const content = await mutateMain(provenance.labels.secondary_tx_only!, {
      'Provider Business Practice Location Address State Name': 'FL',
    },floridaOnly);
    const tx = await options(content); await importNppes(db,tx);
    const before = await checksumTx();
    const fl = await options(content,{ state: 'FL' });
    const report = await importNppes(db,fl);
    expect(report.snapshot_id).not.toBe(`nppes-full-TX-${fl.metadata.sha256}`);
    expect(await checksumTx()).toBe(before);
    expect((await providerByNpi(db,provenance.labels.out_of_state!))?.state_filter).toBe('FL');
    expect((await db.query('SELECT DISTINCT state_filter FROM npi_state_scope ORDER BY state_filter')).rows)
      .toEqual([{ state_filter: 'FL' },{ state_filter: 'TX' }]);
    // The old single-state importer cannot satisfy these independent membership assertions.
    expect((await db.query(`SELECT in_scope FROM npi_state_scope WHERE npi=$1 AND state_filter='TX'`,
      [provenance.labels.individual!])).rows).toEqual([{ in_scope: true }]);
    expect((await db.query(`SELECT * FROM npi_state_scope WHERE npi=$1 AND state_filter='FL'`,
      [provenance.labels.individual!])).rows).toEqual([]);
    expect((await importNppes(db,fl)).outcome).toBe('noop');
    async function checksumTx() {
      const evidence = await db.query(`SELECT p.npi,to_jsonb(p) identity,
        (SELECT jsonb_agg(to_jsonb(a) ORDER BY kind,ordinal) FROM npi_address a WHERE a.npi=p.npi) addresses,
        (SELECT jsonb_agg(to_jsonb(t) ORDER BY ordinal) FROM npi_taxonomy t WHERE t.npi=p.npi) taxonomies,
        (SELECT to_jsonb(s) FROM npi_state_scope s WHERE s.npi=p.npi AND s.state_filter='TX') scope
        FROM npi_provider p WHERE EXISTS(SELECT 1 FROM npi_state_scope s WHERE s.npi=p.npi AND s.state_filter='TX') ORDER BY p.npi`);
      return createHash('sha256').update(JSON.stringify(evidence.rows)).digest('hex');
    }
  });

  it('keeps shared NPI membership separate by state and uses a state-scoped monthly cutoff', async () => {
    const npi = provenance.labels.secondary_tx_only!;
    const content = await mutateMain(npi,{ 'Provider Business Practice Location Address State Name': 'FL' });
    await importNppes(db,await options(content));
    await importNppes(db,await options(content,{ state: 'FL' }));
    expect((await db.query('SELECT state_filter,in_scope FROM npi_state_scope WHERE npi=$1 ORDER BY state_filter',[npi])).rows)
      .toEqual([{ state_filter: 'FL',in_scope: true },{ state_filter: 'TX',in_scope: true }]);
    // A newer TX monthly cutoff must not supersede FL's earlier weekly update.
    const later = await options(content+'\n');
    later.fixture = { dataDate: '2026-11-15',input: { main: () => textInput(content),secondary: () => textInput(secondary) } };
    await importNppes(db,later);
    const movement = await mutateMain(npi,{ 'Provider Business Practice Location Address State Name': 'CA' });
    const weekly = await options(movement,{ kind: 'weekly',state: 'FL' });
    weekly.fixture = { dataDate: '2026-11-09',input: { main: () => textInput(movement),secondary: () => textInput(secondary) } };
    expect((await importNppes(db,weekly)).outcome).toBe('imported');
    expect((await db.query('SELECT state_filter,in_scope FROM npi_state_scope WHERE npi=$1 ORDER BY state_filter',[npi])).rows)
      .toEqual([{ state_filter: 'FL',in_scope: false },{ state_filter: 'TX',in_scope: true }]);
    // A national identity newer than this FL observation must not be overwritten.
    expect((await providerByNpi(db,npi))?.data_date).toBe('2026-11-15');
    expect(await providersNearZip(db,'75801',undefined,'FL')).toEqual([]);
  });
});

describe('NPPES source discovery', () => {
  it('selects only official V2 monthly, weekly and deactivation links, ignoring V1 and foreign URLs', () => {
    const html = `<a href='./NPPES_Data_Dissemination_November_2026_V2.zip'>monthly</a>
      <a href='./NPPES_Data_Dissemination_102626_110126_Weekly_V2.zip'>weekly</a>
      <a href='./NPPES_Deactivated_NPI_Report_110226_V2.zip'>deactivation</a>
      <a href='./NPPES_Data_Dissemination_November_2026.zip'>V1</a>
      <a href='https://evil.invalid/NPPES_Data_Dissemination_November_2026_V2.zip'>foreign</a>`;
    expect(discoverReleases(html).map(r => r.kind)).toEqual(['full','weekly','deactivation']);
    expect(() => discoverReleases(html.replaceAll('_V2.zip', '.zip'))).toThrow('Missing CMS V2');
  });
});
