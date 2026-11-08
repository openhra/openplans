import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootstrapPlan, executeBootstrap, parseBootstrapOptions } from '../src/worker/bootstrap.js';
import type { BootstrapStep } from '../src/worker/bootstrap.js';
import * as taxonomyAcquire from '../src/ingest/taxonomy/acquire.js';
import * as fetcher from '../src/fetch/index.js';
import * as geoSources from '../src/ingest/geo/sources.js';
import { fixtureFiles as geoFiles } from './ingest/geo/helpers.js';
import { runWorker } from '../src/worker/commands.js';
import { syntheticZip } from './fixtures/fetch/generate.mjs';
import { IMPORT_KINDS } from '../src/ingest/puf/import-source.js';
import { setup as providerHarness, fixture as providerFixture, scope as providerScope } from './ingest/qhp/provider-helpers.js';
import { importProviders } from '../src/ingest/qhp/provider.js';
import { coreMigrations, testDatabase } from './pglite.js';
import { readRecords } from '../src/ingest/csv/index.js';

const fixtureDirectory = fileURLToPath(new URL('./fixtures/puf/import/', import.meta.url));
const output = () => {
  const lines: string[] = [], errors: string[] = [];
  return { lines, errors, out: (line: string) => lines.push(line), error: (line: string) => errors.push(line) };
};
const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');

async function cachedPufs(directory: string) {
  const root = join(directory, 'raw', 'cms-exchange-puf');
  await mkdir(root, { recursive: true });
  const files = [];
  // Synthetic ZIP containers around unmodified, provenance-documented real CMS cuts.
  for (const kind of IMPORT_KINDS) {
    const bytes = syntheticZip([{ name: `${kind}.csv`, body: await readFile(join(fixtureDirectory, `${kind}.csv`), 'utf8') }]);
    const hash = sha(bytes), url = `https://download.cms.gov/marketplace-puf/2026/${kind}-puf.zip`;
    await mkdir(join(root, hash)); await writeFile(join(root, hash, 'payload'), bytes);
    await writeFile(join(root, `${hash}.meta.json`), JSON.stringify({ source: 'cms-exchange-puf', sha256: hash, url, bytes: bytes.length, fetched_at: '2026-11-07T00:00:00Z' }));
    files.push({ kind, year: 2026, status: 'ok', snapshot_id: hash, sha256: hash, bytes: bytes.length, url });
  }
  await writeFile(join(root, 'manifest-2026-11-07.json'), JSON.stringify({ schema_version: 1, dry_run: false, files }));
  return files;
}

describe('one-command bootstrap', () => {
  it.each([
    [], ['--states', 'TX'], ['--years', '2026'], ['--states', 'tx', '--years', '2026'],
    ['--states', 'XX', '--years', '2026'], ['--states', 'TX', '--years', '2028'],
    ['--states', 'TX,', '--years', '2026'], ['--states', 'TX', '--years', '2026', '--years', '2027'],
    ['--states', 'TX', '--years', '2026', '--with-drugs', '--with-drugs'],
  ])('rejects invalid options without opening a database: %j', async (...args) => {
    const out = output(), open = vi.fn(() => { throw new Error('must not connect'); });
    expect(await runWorker(['bootstrap', ...args], open, out)).toBe(1);
    expect(open).not.toHaveBeenCalled(); expect(out.errors[0]).toContain('Usage: worker bootstrap');
  });

  it.each([
    ['postgresql://bootstrap@127.0.0.1/bootstrap', '3600000'],
    ['postgresql://bootstrap@127.0.0.1/bootstrap?query_timeout=17', '17'],
  ])('allows long schema upgrades while preserving an explicit bootstrap timeout: %s', async (connection, timeout) => {
    const directory = await mkdtemp(join(tmpdir(), 'openplans-bootstrap-timeout-'));
    const open = vi.fn((url?: string) => {
      expect(new URL(url!).searchParams.get('query_timeout')).toBe(timeout);
      throw new Error('synthetic unavailable database');
    });
    try {
      vi.stubEnv('OPENPLANS_DATA_DIR', directory); vi.stubEnv('DATABASE_URL', connection);
      expect(await runWorker(['bootstrap', '--states', 'TX', '--years', '2026'], open, output())).toBe(1);
      expect(open).toHaveBeenCalledTimes(1);
      expect(new URL(open.mock.calls[0]![0]!).searchParams.get('query_timeout')).toBe(timeout);
    } finally { vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }); }
  });

  it('deduplicates states/years and makes geocoding include provider inputs', () => {
    expect(parseBootstrapOptions(['--states', 'TX,FL,TX', '--years', '2027,2026,2027', '--with-geocode'])).toEqual({
      states: ['TX', 'FL'], years: [2027, 2026], drugs: false, providers: true, nuccTaxonomy: false, geocode: true, dryRun: false,
    });
  });

  it('dry-run is metadata-only, reports unknown sizes, and never calls an action or database', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'openplans-bootstrap-dry-'));
    try {
      const out = output(), open = vi.fn(() => { throw new Error('must not connect'); });
      vi.stubEnv('OPENPLANS_DATA_DIR', directory);
      expect(await runWorker(['bootstrap', '--states', 'DE,TX', '--years', '2026,2027', '--with-drugs', '--with-providers', '--with-geocode', '--dry-run'], open, out)).toBe(0);
      expect(open).not.toHaveBeenCalled(); expect(await readdir(directory)).toEqual([]);
      const records = out.lines.map(line => JSON.parse(line));
      expect(records.find(row => row.id === 'puf-acquire-2026').estimated_download_bytes).toBe('unknown');
      expect(records.find(row => row.id === 'geo-DE-2026').estimated_download_bytes).toBe('unknown');
      expect(records.find(row => row.id === 'qhp-formulary-TX-2027').depends_on).toContain('rxnorm');
      expect(records.find(row => row.id === 'nppes-DE-weekly').depends_on).toContain('nppes-DE-full');
      expect(records.at(-1).passed).toBe(true);
      expect(records.find(row => row.id === 'taxonomy')).toMatchObject({ status: 'skipped', reason: 'opt_in_required', estimated_download_bytes: 0 });
      expect(records.at(-1).steps.filter((step: { id: string }) => step.id !== 'taxonomy').every((step: { status: string }) => step.status === 'planned')).toBe(true);
    } finally { vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }); }
  });

  it('requires explicit NUCC consent, never requests taxonomy by default, and imports only on opt-in', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'openplans-bootstrap-taxonomy-'));
    const db = testDatabase(new PGlite()), core = await coreMigrations();
    const request = vi.spyOn(fetcher, 'fetchToCache').mockRejectedValue(new Error('unexpected request'));
    const acquire = vi.spyOn(taxonomyAcquire, 'acquireRelease');
    try {
      const path = fileURLToPath(new URL('./fixtures/taxonomy/nucc.csv', import.meta.url));
      const bytes = await readFile(path), hash = sha(bytes), url = 'https://www.nucc.org/images/stories/CSV/nucc_taxonomy_261.csv';
      acquire.mockResolvedValue({ path, url, version: '26.1', metadata: {
        snapshot_id: hash, source: 'nucc-provider-taxonomy', url, final_url: url, redirect_chain: [], status: 200,
        content_type: 'text/csv', etag: null, last_modified: null, sha256: hash, bytes: bytes.length, fetched_at: '2026-11-07T00:00:00Z',
      } });
      const args = ['--states', 'TX', '--years', '2026', '--with-providers'];
      const plan = await bootstrapPlan(parseBootstrapOptions(args), () => db, directory, core.directory);
      const selected = plan.filter(step => ['migrate', 'taxonomy'].includes(step.id));
      const contract = (result: Awaited<ReturnType<typeof executeBootstrap>>) => {
        expect(result.steps.find(step => step.id === 'taxonomy')).toMatchObject({ status: 'skipped', reason: 'opt_in_required' });
        expect(acquire).not.toHaveBeenCalled(); expect(request).not.toHaveBeenCalled();
      };
      contract(await executeBootstrap(selected, output()));
      expect(await selected.find(step => step.id === 'taxonomy')!.run()).toMatchObject({ skipped: true, reason: 'opt_in_required' });
      expect((await db.query('SELECT * FROM provider_taxonomy')).rows).toEqual([]);
      const optedIn = (await bootstrapPlan(parseBootstrapOptions([...args, '--with-nucc-taxonomy']), () => db, directory, core.directory))
        .find(step => step.id === 'taxonomy')!;
      expect((await executeBootstrap([optedIn], output(), true)).steps[0]?.status).toBe('planned');
      expect(acquire).not.toHaveBeenCalled();
      // Executed graph mutant: enable the import action by default and remove its skip guard.
      const mutant = selected.map(step => step.id === 'taxonomy' ? optedIn : step);
      const imported = await executeBootstrap(mutant, output());
      expect(() => contract(imported)).toThrow();
      expect(imported.steps.find(step => step.id === 'taxonomy')).toMatchObject({ status: 'completed', evidence: { codes: 3 } });
      expect(acquire).toHaveBeenCalledTimes(1);
      expect((await db.query('SELECT code FROM provider_taxonomy')).rows).toHaveLength(3);
      vi.stubEnv('OPENPLANS_DATA_DIR', directory);
      for (const flags of [[], ['--wrong'], ['--accept-nucc-terms', '--accept-nucc-terms']]) {
        const open = vi.fn(() => db), out = output();
        expect(await runWorker(['ingest', 'taxonomy', ...flags], open, out, core.directory)).toBe(1);
        expect(open).not.toHaveBeenCalled(); expect(out.errors[0]).toContain('--accept-nucc-terms');
      }
      expect(await runWorker(['ingest', 'taxonomy', '--accept-nucc-terms'], () => ({ ...db, close: async () => {} }), output(), core.directory)).toBe(0);
      expect(acquire).toHaveBeenCalledTimes(2); expect(request).not.toHaveBeenCalled();
    } finally { acquire.mockRestore(); request.mockRestore(); vi.unstubAllEnvs(); await db.close(); await core.cleanup(); await rm(directory, { recursive: true, force: true }); }
  });

  it('negative control: forced step failure skips transitive dependants, runs independents and names the failure', async () => {
    const ran: string[] = [], out = output();
    const steps: BootstrapStep[] = [
      { id: 'migrate', depends_on: [], estimated_download_bytes: 0, run: async () => ({}) },
      { id: 'acquire', depends_on: ['migrate'], estimated_download_bytes: 'unknown', run: async () => { ran.push('acquire'); return {}; } },
      { id: 'catalog', depends_on: ['acquire'], estimated_download_bytes: 0, run: async () => { ran.push('catalog'); return {}; } },
      { id: 'providers', depends_on: ['catalog'], estimated_download_bytes: 'unknown', run: async () => { ran.push('providers'); return {}; } },
      { id: 'geography', depends_on: ['migrate'], estimated_download_bytes: 20, run: async () => { ran.push('geography'); return {}; } },
    ];
    // A temporary mutant, not a source edit; it deliberately contains a secret-shaped error.
    const mutant = steps.map(step => step.id === 'acquire' ? { ...step, run: async () => { throw new Error('postgresql://private:secret@host/db'); } } : step);
    const result = await executeBootstrap(mutant, out);
    expect(result.passed ? 0 : 1).toBe(1);
    expect(result.failed).toEqual(['acquire']); expect(result.blocked).toEqual(['catalog', 'providers']);
    expect(ran).toEqual(['geography']); expect(out.lines.join('\n')).not.toContain('secret');
    expect(result.steps.find(step => step.id === 'catalog')).toMatchObject({ status: 'skipped', reason: 'dependency_failed' });
    // The same graph succeeds without the mutant.
    expect((await executeBootstrap(steps, output())).passed).toBe(true);
  });

  it('worker returns exit 1 on corrupt acquisition while real independent geography still activates', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'openplans-bootstrap-failed-cli-'));
    const pg = new PGlite(), db = testDatabase(pg), core = await coreMigrations();
    const acquire = vi.spyOn(geoSources, 'acquireGeo').mockResolvedValue(await geoFiles());
    try {
      const files = await cachedPufs(directory);
      await writeFile(join(directory, 'raw', 'cms-exchange-puf', files[0]!.sha256, 'payload'), 'synthetic corrupt acquisition');
      vi.stubEnv('OPENPLANS_DATA_DIR', directory);
      const out = output();
      const code = await runWorker(['bootstrap', '--states', 'TX', '--years', '2026'], () => ({ ...db, close: async () => {} }), out, core.directory);
      expect(code).toBe(1);
      const summary = JSON.parse(out.lines.at(-1)!);
      expect(summary.failed).toEqual(['puf-acquire-2026']); expect(summary.blocked).toEqual(['puf-TX-2026']);
      expect(summary.steps.find((step: { id: string }) => step.id === 'geo-TX-2026').status).toBe('completed');
      expect((await db.query('SELECT state FROM geo_import')).rows).toEqual([{ state: 'TX' }]);
      expect((await db.query('SELECT * FROM puf_active_catalog')).rows).toEqual([]);
    } finally { acquire.mockRestore(); vi.unstubAllEnvs(); await db.close(); await core.cleanup(); await rm(directory, { recursive: true, force: true }); }
  });

  it('rejects a state absent from the publication before activation and still imports its sibling', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'openplans-bootstrap-absent-state-'));
    const pg = new PGlite(), db = testDatabase(pg), core = await coreMigrations();
    try {
      await cachedPufs(directory);
      const options = parseBootstrapOptions(['--states', 'CA,TX', '--years', '2026']);
      const plan = (await bootstrapPlan(options, () => db, directory, core.directory)).filter(step => !step.id.startsWith('geo-'));
      const result = await executeBootstrap(plan, output());
      expect(result.failed).toEqual(['puf-CA-2026']);
      expect(result.steps.find(step => step.id === 'puf-TX-2026')?.status).toBe('completed');
      expect((await db.query('SELECT state FROM puf_active_catalog')).rows).toEqual([{ state: 'TX' }]);
    } finally { await db.close(); await core.cleanup(); await rm(directory, { recursive: true, force: true }); }
  });

  it('skips complete issuer evidence only for the current catalog/discovery and retries incomplete manifests', async () => {
    const h = await providerHarness();
    try {
      // Existing real Cigna cuts in a labelled synthetic catalog/discovery harness.
      await h.replace(await providerFixture('records'));
      const initial = await importProviders(h.db, providerScope);
      expect(initial.completeness).toBe('complete');
      const options = parseBootstrapOptions(['--states', 'TX', '--years', '2026', '--with-providers']);
      const plan = await bootstrapPlan(options, () => h.db, h.directory, h.core.directory);
      const providers = plan.find(step => step.id === 'qhp-providers-TX-2026')!;
      expect(await providers.run()).toMatchObject({ skipped: true, reason: 'current_active_snapshot' });
      // A failed replacement manifest must not be hidden by historical ACTIVE evidence.
      await h.db.query("UPDATE qhp_coverage_manifest SET status='partial' WHERE kind='provider'");
      expect(await providers.run()).toMatchObject({ evidence: { imported: 1 } });
      expect(await providers.run()).toMatchObject({ skipped: true });
      // New discovery identity requires a new publication even with identical bytes.
      await h.replace(await providerFixture('records'));
      expect(await providers.run()).toMatchObject({ evidence: { imported: 1 } });
      expect(await providers.run()).toMatchObject({ skipped: true });
    } finally { await h.close(); }
  });

  it('bootstraps FL beside existing TX using state memberships and preserves every TX checksum', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'openplans-bootstrap-nppes-'));
    const db = testDatabase(new PGlite()), core = await coreMigrations();
    const fixtures = fileURLToPath(new URL('./fixtures/nppes/', import.meta.url));
    const provenance = JSON.parse(await readFile(join(fixtures, 'provenance.json'), 'utf8'));
    try {
      // Labelled synthetic FL primary locations on public fixture rows. One also has
      // a real TX secondary practice: both states must observe that shared identity.
      const records: string[][] = [];
      async function* input() { yield await readFile(join(fixtures, 'providers-v2.csv')); }
      for await (const record of readRecords(input())) records.push(record.fields);
      const stateColumn = records[0]!.indexOf('Provider Business Practice Location Address State Name');
      for (const row of records.slice(1)) if ([provenance.labels.out_of_state, provenance.labels.secondary_tx_only].includes(row[0])) row[stateColumn] = 'FL';
      const main = records.map(row => row.map(value => `"${value.replaceAll('"', '""')}"`).join(',')).join('\r\n') + '\r\n';
      const bytes = syntheticZip([
        { name: 'npidata_pfile_20050523-20261102.csv', body: main },
        { name: 'pl_pfile_20050523-20261102.csv', body: await readFile(join(fixtures, 'practice-locations.csv'), 'utf8') },
        { name: 'readme_v2.pdf', body: '' },
      ]);
      async function cache(source: string, url: string, body: Buffer | string) {
        const hash = sha(body), root = join(directory, 'raw', source);
        await mkdir(join(root, hash), { recursive: true }); await writeFile(join(root, hash, 'payload'), body);
        const metadata = JSON.stringify({ source, url, final_url: url,
          snapshot_id: hash, sha256: hash, bytes: Buffer.byteLength(body), fetched_at: '2026-11-07T00:00:00Z',
          redirect_chain: [], status: 200, content_type: source === 'cms-nppes' ? 'application/zip' : 'text/html', etag: null, last_modified: null });
        await writeFile(join(root, `${hash}.meta.json`), metadata);
        await writeFile(join(root, hash, 'meta.json'), metadata);
      }
      await cache('cms-nppes', provenance.source, bytes);
      await cache('cms-nppes-page', 'https://download.cms.gov/nppes/NPI_Files.html',
        `<a href="${provenance.source}">monthly</a><a href="${provenance.deactivation_source}">deactivation</a>`);
      const graph = async (states: string) => bootstrapPlan(parseBootstrapOptions(['--states', states, '--years', '2026', '--with-providers']), () => db, directory, core.directory);
      const initial = (await graph('TX')).filter(step => ['migrate', 'nppes-TX-full'].includes(step.id));
      expect((await executeBootstrap(initial, output())).passed).toBe(true);
      async function txChecksums() {
        const tables = [
          `SELECT to_jsonb(p) row FROM npi_provider p WHERE p.state_filter='TX' ORDER BY npi`,
          `SELECT to_jsonb(a) row FROM npi_address a JOIN npi_provider p USING(npi) WHERE p.state_filter='TX' ORDER BY a.npi,kind,ordinal`,
          `SELECT to_jsonb(t) row FROM npi_taxonomy t JOIN npi_provider p USING(npi) WHERE p.state_filter='TX' ORDER BY t.npi,ordinal`,
          `SELECT to_jsonb(s) row FROM npi_state_scope s WHERE state_filter='TX' ORDER BY npi`,
          `SELECT to_jsonb(r) row FROM npi_import_run r WHERE state_filter='TX' ORDER BY snapshot_id`,
        ];
        return Promise.all(tables.map(async sql => sha(JSON.stringify((await db.query(sql)).rows))));
      }
      const before = await txChecksums();
      const both = (await graph('TX,FL')).filter(step => ['migrate', 'nppes-TX-full', 'nppes-FL-full'].includes(step.id));
      const result = await executeBootstrap(both, output());
      expect(result.passed).toBe(true);
      expect(result.steps.find(step => step.id === 'nppes-TX-full')).toMatchObject({ status: 'skipped', reason: 'current_active_snapshot' });
      expect(result.steps.find(step => step.id === 'nppes-FL-full')).toMatchObject({ status: 'completed', evidence: { state: 'FL', outcome: 'imported' } });
      expect(await txChecksums()).toEqual(before);
      expect((await db.query('SELECT DISTINCT state_filter FROM npi_import_run ORDER BY state_filter')).rows).toEqual([{ state_filter: 'FL' }, { state_filter: 'TX' }]);
      expect((await db.query('SELECT state_filter FROM npi_state_scope WHERE npi=$1 ORDER BY state_filter', [provenance.labels.secondary_tx_only])).rows).toEqual([{ state_filter: 'FL' }, { state_filter: 'TX' }]);
      expect((await db.query('SELECT state_filter FROM npi_state_scope WHERE npi=$1', [provenance.labels.out_of_state])).rows).toEqual([{ state_filter: 'FL' }]);
      const replay = await executeBootstrap(both, output());
      expect(replay.passed).toBe(true); expect(replay.steps.every(step => step.status === 'skipped')).toBe(true);
      expect(await txChecksums()).toEqual(before);
      // A database whose original membership was removed must fail closed before
      // attempting to reuse evidence or import another state's national release.
      await db.query("DELETE FROM npi_state_scope WHERE state_filter='TX'");
      const malformed = await executeBootstrap(both, output());
      expect(malformed.failed).toEqual(['nppes-TX-full', 'nppes-FL-full']);
      expect(malformed.steps.filter(step => step.status === 'failed').every(step => step.reason === 'nppes_state_membership_missing')).toBe(true);
    } finally { await db.close(); await core.cleanup(); await rm(directory, { recursive: true, force: true }); }
  });

  it('reports the existing optional-state limits before using unsupported inputs', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'openplans-bootstrap-limits-'));
    const forbidden = () => { throw new Error('must not connect'); };
    try {
      const de = await bootstrapPlan(parseBootstrapOptions(['--states', 'DE', '--years', '2026', '--with-geocode']), forbidden, directory);
      await expect(de.find(step => step.id === 'geocode-DE')!.run()).rejects.toThrow('geocode_currently_supports_TX_only');
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('imports real CMS cuts, skips current ACTIVE files, and detects a changed pointer/hash and corrupted cache', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'openplans-bootstrap-current-'));
    const pg = new PGlite(), db = testDatabase(pg), core = await coreMigrations();
    try {
      const files = await cachedPufs(directory);
      const options = parseBootstrapOptions(['--states', 'TX', '--years', '2026']);
      // Geography has its own real-cut suite; select only the graph's core DB+PUF steps here.
      const plan = async () => (await bootstrapPlan(options, () => db, directory, core.directory)).filter(step => !step.id.startsWith('geo-'));
      const first = await executeBootstrap(await plan(), output());
      expect(first.passed).toBe(true);
      expect(first.steps.find(step => step.id === 'puf-TX-2026')?.status).toBe('completed');
      const before = (await db.query('SELECT count(*)::int AS n FROM snapshot')).rows[0];
      const second = await executeBootstrap(await plan(), output());
      expect(second.passed).toBe(true); expect(second.steps.every(step => step.status === 'skipped')).toBe(true);
      expect((await db.query('SELECT count(*)::int AS n FROM snapshot')).rows[0]).toEqual(before);
      const acquire = (await plan()).find(step => step.id === 'puf-acquire-2026')!;
      expect(acquire.estimated_download_bytes).toBe(files.reduce((sum, file) => sum + file.bytes, 0));
      // A quarantined child must not be accepted merely because the catalog pointer exists.
      await db.query("UPDATE snapshot SET validation_state='QUARANTINED' WHERE snapshot_id=(SELECT import_id||':rate' FROM puf_active_catalog WHERE state='TX')");
      const third = await executeBootstrap(await plan(), output());
      expect(third.passed).toBe(true); expect(third.steps.find(step => step.id === 'puf-TX-2026')?.status).toBe('completed');
      await writeFile(join(directory, 'raw', 'cms-exchange-puf', files[0]!.sha256, 'payload'), 'synthetic corrupt ZIP');
      const fourth = await executeBootstrap(await plan(), output());
      expect(fourth.passed).toBe(false); expect(fourth.failed).toEqual(['puf-acquire-2026']);
      expect(fourth.blocked).toEqual(['puf-TX-2026']);
    } finally { await db.close(); await core.cleanup(); await rm(directory, { recursive: true, force: true }); }
  });
});
