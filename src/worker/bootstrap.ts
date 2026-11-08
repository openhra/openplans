import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, readdir, writeFile, rename } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Database } from '../db/database.js';
import { migrate, migrationsDirectory } from '../db/migrate.js';
import type { SnapshotMetadata } from '../fetch/index.js';
import { parameterRegistry } from '../domain/subsidy/generated.js';
import { isSubsidyParameters } from '../domain/subsidy/parameters.js';
import { ingestRatingRules } from '../ingest/rating-rules/index.js';
import { acquirePufs, PUF_KINDS } from '../ingest/puf/acquire.js';
import type { PufManifest } from '../ingest/puf/acquire.js';
import { cachedImportFiles, importDataDirectory, verifyImportFile } from '../ingest/puf/import-source.js';
import { importPufs } from '../ingest/puf/import.js';
import { pufStates } from '../ingest/puf/import-batch.js';
import { acquireGeo, geoSources } from '../ingest/geo/sources.js';
import { ingestGeo } from '../ingest/geo/index.js';
import { STATE_FIPS } from '../ingest/geo/states.js';
import { acquireRelease as acquireRxnorm, discoverRelease as discoverRxnorm } from '../ingest/rxnorm/acquire.js';
import { importRxnorm } from '../ingest/rxnorm/import.js';
import { acquireRelease as acquireNppes, discoverCurrent, discoverReleases } from '../ingest/nppes/acquire.js';
import type { Kind } from '../ingest/nppes/acquire.js';
import { importNppes } from '../ingest/nppes/import.js';
import { acquireRelease as acquireTaxonomy, discoverRelease as discoverTaxonomy } from '../ingest/taxonomy/acquire.js';
import { importTaxonomy } from '../ingest/taxonomy/import.js';
import { cachedRegistry, verifyRegistry, readRegistry, registryWorkbook } from '../ingest/qhp/discover-registry.js';
import { discoverQhp } from '../ingest/qhp/discover.js';
import { ingestQhpBatch } from '../ingest/qhp/formulary-batch.js';
import { ingestGeocode } from '../ingest/geocode/index.js';
import { addresses, addressCursor, reused } from '../ingest/geocode/repository.js';

interface Output { out(message: string): void; error(message: string): void }
export interface BootstrapOptions { states: string[]; years: number[]; drugs: boolean; providers: boolean; nuccTaxonomy: boolean; geocode: boolean; dryRun: boolean }
export interface StepOutcome { skipped?: boolean; reason?: string; evidence?: unknown }
export interface BootstrapStep {
  id: string; depends_on: string[]; estimated_download_bytes: number | 'unknown';
  skip_reason?: string;
  run(): Promise<StepOutcome>;
}
export interface StepResult extends StepOutcome {
  id: string; status: 'completed' | 'skipped' | 'failed' | 'planned'; elapsed_ms: number; blocked_by?: string[];
}
const usage = 'Usage: worker bootstrap --states TX,FL --years 2026,2027 [--with-drugs] [--with-providers] [--with-nucc-taxonomy] [--with-geocode] [--dry-run]';
class BootstrapFailure extends Error {}
const fail = (reason: string): never => { throw new BootstrapFailure(reason); };
const digest = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const dataFile = (path: string) => fileURLToPath(new URL(`../../data/${path}`, import.meta.url));

export function parseBootstrapOptions(args: string[]): BootstrapOptions {
  const flags = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const key = args[i]!;
    if (flags.has(key) || !['--states', '--years', '--with-drugs', '--with-providers', '--with-nucc-taxonomy', '--with-geocode', '--dry-run'].includes(key)) throw new Error(usage);
    const value = key === '--states' || key === '--years' ? args[++i] : 'true';
    if (!value || value.startsWith('--')) throw new Error(usage);
    flags.set(key, value);
  }
  const states = (flags.get('--states') ?? '').split(','), years = (flags.get('--years') ?? '').split(',');
  if (states.some(state => !Object.hasOwn(STATE_FIPS, state)) || years.some(year => !/^(2026|2027)$/.test(year))) throw new Error(usage);
  return { states: [...new Set(states)], years: [...new Set(years.map(Number))], drugs: flags.has('--with-drugs'),
    providers: flags.has('--with-providers') || flags.has('--with-geocode'), nuccTaxonomy: flags.has('--with-nucc-taxonomy'), geocode: flags.has('--with-geocode'), dryRun: flags.has('--dry-run') };
}

/** The graph is ordered, but only failed prerequisites block a step. No exception text is logged. */
export async function executeBootstrap(steps: BootstrapStep[], output: Output, dryRun = false) {
  const results: StepResult[] = [];
  for (const step of steps) {
    const started = Date.now();
    const blocked = step.depends_on.filter(id => {
      const dependency = results.find(result => result.id === id);
      return !dependency || dependency.status === 'failed' || !!dependency.blocked_by?.length;
    });
    let result: StepResult;
    if (step.skip_reason) result = { id: step.id, status: 'skipped', reason: step.skip_reason, elapsed_ms: 0 };
    else if (dryRun) result = { id: step.id, status: 'planned', elapsed_ms: 0 };
    else if (blocked.length) result = { id: step.id, status: 'skipped', reason: 'dependency_failed', blocked_by: blocked, elapsed_ms: 0 };
    else {
      output.out(JSON.stringify({ bootstrap_step: step.id, status: 'starting' }));
      try {
        const outcome = await step.run();
        result = { ...outcome, id: step.id, status: outcome.skipped ? 'skipped' : 'completed', elapsed_ms: Date.now() - started };
      } catch (error) {
        result = { id: step.id, status: 'failed', reason: error instanceof BootstrapFailure ? error.message : 'step_failed_check_source_cache_and_database', elapsed_ms: Date.now() - started };
      }
    }
    results.push(result);
    output.out(JSON.stringify({ ...result, depends_on: step.depends_on, estimated_download_bytes: step.estimated_download_bytes }));
  }
  const failed = results.filter(result => result.status === 'failed').map(result => result.id);
  const blocked = results.filter(result => result.blocked_by?.length).map(result => result.id);
  const summary = { command: 'bootstrap', dry_run: dryRun, passed: !failed.length && !blocked.length, failed, blocked, steps: results };
  output.out(JSON.stringify(summary));
  return summary;
}

async function metadata(dataDir: string, source: string, url?: string | RegExp): Promise<SnapshotMetadata | undefined> {
  const root = join(dataDir, 'raw', source);
  let names: string[];
  try { names = await readdir(root); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  const values: SnapshotMetadata[] = [];
  for (const name of names.filter(name => name.endsWith('.meta.json'))) {
    const m = JSON.parse(await readFile(join(root, name), 'utf8')) as SnapshotMetadata;
    if (m.source !== source || !/^[a-f0-9]{64}$/.test(m.sha256) || !Number.isSafeInteger(m.bytes) || m.bytes < 0 || typeof m.fetched_at !== 'string') fail('invalid_cache_metadata');
    if (!url || (typeof url === 'string' ? m.url === url : url.test(m.url))) values.push(m);
  }
  return values.sort((a, b) => b.fetched_at.localeCompare(a.fetched_at))[0];
}
async function latestManifest(dataDir: string): Promise<PufManifest | undefined> {
  const root = join(dataDir, 'raw', 'cms-exchange-puf');
  let names: string[];
  try { names = await readdir(root); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  const name = names.filter(name => /^manifest-.*\.json$/.test(name)).sort().at(-1);
  if (!name) return;
  const m = JSON.parse(await readFile(join(root, name), 'utf8')) as PufManifest;
  if (m.schema_version !== 1 || m.dry_run || !Array.isArray(m.files)) fail('invalid_puf_manifest');
  return m;
}
async function verifiedCached(dataDir: string, source: string, url?: string) {
  const m = await metadata(dataDir, source, url);
  if (!m) return;
  const path = join(dataDir, 'raw', source, m.sha256, 'payload');
  const hash = createHash('sha256'); let bytes = 0;
  for await (const chunk of createReadStream(path)) { hash.update(chunk); bytes += chunk.length; }
  if (hash.digest('hex') !== m.sha256 || bytes !== m.bytes) fail('cache_integrity_failed');
  return { path, metadata: m };
}

/** Build without DB access, downloads or writes, so --dry-run works on an empty installation. */
export async function bootstrapPlan(options: BootstrapOptions, database: () => Database, dataDir: string, directory = migrationsDirectory): Promise<BootstrapStep[]> {
  if (!isAbsolute(dataDir)) fail('absolute_data_directory_required');
  const steps: BootstrapStep[] = [];
  const add = (id: string, depends_on: string[], run: BootstrapStep['run'], bytes: number | 'unknown' = 0, skip_reason?: string) => steps.push({ id, depends_on, run, estimated_download_bytes: bytes, skip_reason });
  const exists = async (sql: string, parameters: unknown[] = []) => (await database().query(sql, parameters)).rows.length > 0;
  const active = (id: string) => exists("SELECT 1 FROM snapshot WHERE snapshot_id=$1 AND validation_state='ACTIVE'", [id]);
  const current = { skipped: true, reason: 'current_active_snapshot' };
  const estimateMetadata = (source: string, url?: string | RegExp) => metadata(dataDir, source, url).catch(() => undefined);
  const publicationStates = new Map<number, string[]>();
  add('migrate', [], async () => {
    const applied = await migrate(database(), directory);
    return { skipped: !applied.length, reason: applied.length ? 'migrations_applied' : 'schema_current', evidence: { applied } };
  });
  for (const year of options.years) {
    add(`rating-rules-${year}`, ['migrate'], async () => {
      const file = dataFile(`rating-rules/${year}.json`), sha = digest(await readFile(file));
      if (await exists(`SELECT 1 FROM rating_rule_set r JOIN snapshot s USING(snapshot_id)
        WHERE r.plan_year=$1 AND s.sha256=$2 AND s.validation_state='ACTIVE'`, [year, sha])) return current;
      return { evidence: await ingestRatingRules(database(), file) };
    });
    add(`subsidy-${year}`, ['migrate'], async () => {
      const parameters = parameterRegistry[year as keyof typeof parameterRegistry];
      if (!isSubsidyParameters(parameters)) throw new BootstrapFailure('invalid_bundled_subsidy_parameters');
      return { skipped: true, reason: 'bundled_parameters_validated', evidence: { status: parameters.status } };
    });
  }
  // Each year acquires independently. Preserve other observed years in a composite manifest,
  // because the existing importers deliberately read only the newest acquired manifest.
  for (const year of options.years) {
    const m = await latestManifest(dataDir).catch(() => undefined);
    const files = m?.files.filter(file => file.year === year);
    const estimate = files?.length && files.every(file => typeof file.bytes === 'number') ? files.reduce((sum, file) => sum + file.bytes!, 0) : 'unknown';
    add(`puf-acquire-${year}`, ['migrate'], async () => {
      const previous = await latestManifest(dataDir);
      const selected = previous?.files.filter(file => file.year === year) ?? [];
      const wanted = options.drugs || options.providers ? PUF_KINDS.filter(kind => kind !== 'plan-id-crosswalk') : PUF_KINDS.filter(kind => !['plan-id-crosswalk', 'machine-readable-url'].includes(kind));
      if (wanted.every(kind => selected.filter(file => file.kind === kind && file.status === 'ok').length === 1)) {
        const cached = await cachedImportFiles(dataDir, year);
        for (const file of cached.files) await verifyImportFile(file);
        if (options.drugs || options.providers) await verifyRegistry(await cachedRegistry(dataDir, year));
        return { skipped: true, reason: 'verified_cached_publication' };
      }
      const acquired = await acquirePufs({ year, dataDir });
      const combined = { ...acquired.manifest, files: [...(previous?.files.filter(file => file.year !== year) ?? []), ...acquired.manifest.files] };
      const path = join(dataDir, 'raw', 'cms-exchange-puf', `manifest-${new Date().toISOString().replace(/:/g, '-')}-bootstrap.json`);
      await writeFile(`${path}.part`, `${JSON.stringify(combined, null, 2)}\n`, { flag: 'wx' });
      await rename(`${path}.part`, path);
      if (wanted.some(kind => combined.files.find(file => file.year === year && file.kind === kind)?.status !== 'ok')) fail('required_puf_files_unavailable');
      return { reason: 'publication_acquired' };
    }, estimate);
    for (const state of options.states) {
      add(`puf-${state}-${year}`, [`puf-acquire-${year}`], async () => {
        const { files } = await cachedImportFiles(dataDir, year);
        const rows = (await database().query<{ kind: string; sha256: string; validation_state: string }>(`SELECT f.kind,s.sha256,s.validation_state
          FROM puf_active_catalog a JOIN puf_import_file f ON f.import_id=a.import_id JOIN snapshot s ON s.snapshot_id=f.snapshot_id
          JOIN snapshot parent ON parent.snapshot_id=a.import_id AND parent.validation_state='ACTIVE' AND parent.parser_version='puf-import-v1' WHERE a.state=$1 AND a.plan_year=$2`, [state, year])).rows;
        if (rows.length === files.length && files.every(file => rows.some(row => row.kind === file.kind && row.sha256 === file.sha256 && row.validation_state === 'ACTIVE'))) return current;
        if (!publicationStates.has(year)) publicationStates.set(year, await pufStates(files, year));
        if (!publicationStates.get(year)!.includes(state)) fail('state_not_in_publication');
        const report = await importPufs(database(), { year, state, dataDir });
        if (!report.passed) fail('puf_reconciliation_failed_previous_active_preserved');
        if (!report.identifiers.base_plans) fail('state_not_in_publication');
        return { evidence: { import_id: report.import_id, base_plans: report.identifiers.base_plans, report_json: report.report_json } };
      });
      const sources = geoSources(state), sizes = await Promise.all(Object.values(sources).map(source => estimateMetadata(source.source, source.url)));
      add(`geo-${state}-${year}`, ['migrate'], async () => {
        const files = await acquireGeo({ dataDir, state });
        if (await exists(`SELECT 1 FROM geo_import g JOIN snapshot r ON r.snapshot_id=g.relationship_snapshot_id
          JOIN snapshot c ON c.snapshot_id=g.centroid_snapshot_id JOIN snapshot a ON a.snapshot_id=g.rating_snapshot_id
          WHERE g.state=$1 AND g.plan_year=$2 AND r.sha256=$3 AND c.sha256=$4 AND a.sha256=$5
          AND r.validation_state='ACTIVE' AND c.validation_state='ACTIVE' AND a.validation_state='ACTIVE'`,
        [state, year, files.relationship.metadata.sha256, files.centroids.metadata.sha256, files.ratingAreas.metadata.sha256])) return current;
        return { evidence: await ingestGeo(database(), { state, planYear: year, dataDir, files }) };
      }, sizes.every(Boolean) ? sizes.reduce((sum, value) => sum + value!.bytes, 0) : 'unknown');
    }
  }
  if (options.drugs) {
    const m = await estimateMetadata('nlm-rxnorm-prescribe');
    add('rxnorm', ['migrate'], async () => {
      const page = await verifiedCached(dataDir, 'nlm-rxnorm-files');
      const release = page ? discoverRxnorm(await readFile(page.path, 'utf8')) : undefined;
      const cached = release ? await verifiedCached(dataDir, 'nlm-rxnorm-prescribe', release.url) : undefined;
      const acquired = cached && release ? { ...release, ...cached } : await acquireRxnorm(dataDir);
      if (await active(`rxnorm-${acquired.version}-${acquired.metadata.sha256}`)) return current;
      return { evidence: await importRxnorm(database(), acquired) };
    }, m?.bytes ?? 'unknown');
  }
  if (options.providers) {
    for (const state of options.states) {
      for (const kind of ['full', 'weekly', 'deactivation'] as Kind[]) {
        const patterns = { full: /\/NPPES_Data_Dissemination_[A-Za-z]+_\d{4}_V2\.zip$/i,
          weekly: /_Weekly_V2\.zip$/i, deactivation: /\/NPPES_Deactivated_NPI_Report_[^/]+_V2\.zip$/i };
        const size = (await estimateMetadata('cms-nppes', patterns[kind]))?.bytes;
        add(`nppes-${state}-${kind}`, kind === 'full' ? ['migrate'] : [`nppes-${state}-full`], async () => {
          // Migration 680 separates membership from the shared identity. Refuse an
          // inconsistent legacy selection rather than letting another state replace it.
          if (await exists(`SELECT 1 FROM (SELECT npi,state_filter FROM npi_provider
            EXCEPT SELECT npi,state_filter FROM npi_state_scope) missing LIMIT 1`))
            fail('nppes_state_membership_missing');
          const cachedPage = await verifiedCached(dataDir, 'cms-nppes-page');
          const available = cachedPage ? discoverReleases(await readFile(cachedPage.path, 'utf8')) : await discoverCurrent(dataDir);
          const release = available.find(release => release.kind === kind);
          if (!release) fail('nppes_official_v2_link_unavailable');
          const acquired = await acquireNppes(release!, dataDir);
          if (await exists(`SELECT 1 FROM npi_import_run r JOIN snapshot s USING(snapshot_id)
            WHERE r.state_filter=$1 AND r.kind=$2 AND s.sha256=$3 AND s.validation_state='ACTIVE'
            AND s.source_id='cms-nppes' AND s.schema_version='nppes-v2'`, [state, kind, acquired.metadata.sha256])) return current;
          const report = await importNppes(database(), { ...acquired, state });
          return { skipped: report.outcome !== 'imported', reason: report.outcome, evidence: report };
        }, size ?? 'unknown');
      }
    }
  }
  if (options.providers || options.nuccTaxonomy) {
    add('taxonomy', ['migrate'], async () => {
      if (!options.nuccTaxonomy) return { skipped: true, reason: 'opt_in_required' };
      const page = await verifiedCached(dataDir, 'nucc-provider-taxonomy-page');
      const release = page ? discoverTaxonomy(await readFile(page.path, 'utf8')) : undefined;
      const cached = release ? await verifiedCached(dataDir, 'nucc-provider-taxonomy', release.url) : undefined;
      const acquired = cached && release ? { ...release, ...cached } : await acquireTaxonomy(dataDir);
      if (await exists(`SELECT 1 FROM provider_taxonomy t JOIN snapshot s USING(snapshot_id)
        WHERE s.validation_state='ACTIVE' AND s.sha256=$1 LIMIT 1`, [acquired.metadata.sha256])) return current;
      return { evidence: await importTaxonomy(database(), acquired) };
    }, options.nuccTaxonomy ? (await estimateMetadata('nucc-provider-taxonomy'))?.bytes ?? 'unknown' : 0,
    options.nuccTaxonomy ? undefined : 'opt_in_required');
  }
  if (options.drugs || options.providers) for (const year of options.years) for (const state of options.states) {
    const scope = `${state}-${year}`;
    add(`qhp-discover-${scope}`, [`puf-acquire-${year}`], async () => {
      const registry = await cachedRegistry(dataDir, year);
      await verifyRegistry(registry);
      // Discovery is observed PARSED evidence, never ACTIVE. Completeness here means
      // every registry row was attempted; denied indexes remain explicit coverage gaps.
      const expected = await readRegistry(await registryWorkbook(registry, dataDir), state);
      const rows = (await database().query<{ registry_row: number; registry_snapshot_id: string }>(`SELECT i.registry_row,i.registry_snapshot_id FROM qhp_index i
        WHERE i.state=$1 AND i.plan_year=$2 AND i.discovery_id=(SELECT discovery_id FROM qhp_index
          WHERE state=$1 AND plan_year=$2 ORDER BY discovered_at DESC,qhp_index_id DESC LIMIT 1)`, [state, year])).rows;
      if (rows.length && rows.length === expected.length && expected.every(entry => rows.some(row => row.registry_row === entry.row
        && row.registry_snapshot_id === `qhp:registry:${registry.metadata.sha256}`))) return { skipped: true, reason: 'current_observed_discovery' };
      const report = await discoverQhp(database(), { state, year, dataDir, registry });
      return { evidence: report };
    }, 'unknown');
    for (const kind of ['formulary', 'providers'] as const) {
      if (kind === 'formulary' ? !options.drugs : !options.providers) continue;
      const prerequisites = [`qhp-discover-${scope}`, `puf-${scope}`];
      if (kind === 'formulary') prerequisites.push('rxnorm');
      // Participation evidence can still import when identity enrichment is unavailable.
      add(`qhp-${kind}-${scope}`, prerequisites, async () => {
        const table = kind === 'providers' ? 'provider' : 'formulary', manifestKind = kind === 'providers' ? 'provider' : 'drug';
        const issuers = (await database().query<{ issuer_id: string; current: boolean }>(`WITH latest AS (
          SELECT DISTINCT ON (issuer_id) issuer_id,discovery_id FROM qhp_index WHERE state=$1 AND plan_year=$2
          ORDER BY issuer_id,discovered_at DESC,qhp_index_id DESC)
          SELECT l.issuer_id,(a.snapshot_id IS NOT NULL AND s.validation_state='ACTIVE' AND m.status='complete'
            AND f.discovery_id=l.discovery_id AND f.catalog_snapshot_id=pf.snapshot_id
            AND s.parser_version='${kind === 'providers' ? 'qhp-provider-v4' : 'qhp-formulary-v3'}'
            AND NOT EXISTS (SELECT 1 FROM ${table}_shard sh JOIN qhp_child_url c ON c.qhp_child_url_id=sh.child_id
              WHERE sh.source_set_id=a.snapshot_id AND (sh.status<>'complete' OR sh.raw_snapshot_id IS DISTINCT FROM c.snapshot_id))) IS TRUE AS current
          FROM latest l LEFT JOIN ${table}_active_set a ON a.issuer_id=l.issuer_id AND a.state=$1 AND a.plan_year=$2
          LEFT JOIN ${table}_source_set f ON f.snapshot_id=a.snapshot_id LEFT JOIN snapshot s ON s.snapshot_id=a.snapshot_id
          LEFT JOIN qhp_coverage_manifest m ON m.issuer_id=l.issuer_id AND m.state=$1 AND m.plan_year=$2 AND m.kind=$3 AND m.snapshot_id=a.snapshot_id
          LEFT JOIN puf_active_catalog p ON p.state=$1 AND p.plan_year=$2
          LEFT JOIN puf_import_file pf ON pf.import_id=p.import_id AND pf.kind='plan-attributes'`, [state, year, manifestKind])).rows;
        if (!issuers.length) fail('no_qhp_issuers_discovered');
        const skipIssuers = issuers.filter(issuer => issuer.current).map(issuer => issuer.issuer_id);
        if (skipIssuers.length === issuers.length) return current;
        const report = await ingestQhpBatch(database(), kind, { state, year, skipIssuers, fetchOptions: { dataDir } });
        if (report.issuers.some(issuer => issuer.completeness !== 'complete') || report.not_run.length) fail('qhp_incomplete_check_coverage_manifest');
        return { evidence: { imported: report.issuers.length, skipped_issuers: skipIssuers } };
      }, 'unknown');
    }
  }
  if (options.geocode) for (const state of options.states) {
    add(`geocode-${state}`, [`nppes-${state}-full`, ...options.years.map(year => `geo-${state}-${year}`)], async () => {
      if (state !== 'TX') fail('geocode_currently_supports_TX_only');
      let after = '', pending = false;
      for (;;) {
        const page = await addresses(database(), {}, after, 1000);
        if (!page.length) break;
        after = addressCursor(page[page.length - 1]!);
        for (const address of page) if (!await reused(database(), address)) { pending = true; break; }
        if (pending) break;
      }
      if (!pending) return { skipped: true, reason: 'all_selected_addresses_have_terminal_attempts' };
      const report = await ingestGeocode(database(), { dataDir });
      if (report.issues) fail('geocode_has_retriable_issues');
      return { evidence: report };
    }, 'unknown');
  }
  return steps;
}

export async function runBootstrap(args: string[], openDatabase: (connectionString?: string) => Database, output: Output, directory = migrationsDirectory): Promise<number> {
  let options: BootstrapOptions;
  try { options = parseBootstrapOptions(args); } catch { output.error(usage); return 1; }
  let db: Database | undefined, code = 0;
  const database = () => {
    if (!db) {
      const connection = process.env.DATABASE_URL;
      const url = connection ? new URL(connection) : undefined;
      // Populated-database index upgrades can take minutes (e.g. migration 740).
      if (url && !url.searchParams.has('query_timeout')) url.searchParams.set('query_timeout', '3600000');
      db = openDatabase(url?.href);
    }
    return db;
  };
  try {
    const steps = await bootstrapPlan(options, database, importDataDirectory(), directory);
    const summary = await executeBootstrap(steps, output, options.dryRun);
    code = summary.passed ? 0 : 1;
  } catch { output.error('worker bootstrap failed; check data cache metadata, options and database'); code = 1; }
  finally { try { await db?.close(); } catch { output.error('worker database shutdown failed'); code = 1; } }
  return code;
}
