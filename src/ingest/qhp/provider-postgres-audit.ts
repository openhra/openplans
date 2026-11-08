#!/usr/bin/env node
import { homedir } from 'node:os';
/** Read-only HTTP and attribution checks against the isolated, consolidated developer DB. */
import pg from 'pg';
import { serve } from '@hono/node-server';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createDatabase } from '../../db/database.js';
import { createApp } from '../../api/app.js';
import { synchronizeProviderReport, comparePriorProviderIdentity } from './provider-postgres-report-data.js';
import { catalogPlans } from './provider-repository.js';
import type { SqlSession } from '../../db/database.js';

const cache = process.env.OPENPLANS_DATA_DIR ?? join(homedir(), '.local', 'share', 'openplans');
const prefix = process.env.OPENPLANS_QHP_REPORT_PREFIX ?? 'p6c';
const url = process.env.OPENPLANS_QHP_DATABASE_URL;
try {
  if (!url || new URL(url).hostname !== '127.0.0.1' || !['postgres:','postgresql:'].includes(new URL(url).protocol)
    || !/^[a-z0-9-]+$/.test(prefix)) throw new Error();
} catch { throw new Error('Explicit loopback developer database and safe report prefix required'); }
const pool = new pg.Pool({ connectionString: url,max: 3,statement_timeout: 120_000,options: '-c max_parallel_workers_per_gather=0' });
pool.on('error',() => {});
const db: SqlSession = { query: (q,a) => pool.query(q,a),exec: async q => { await pool.query(q); } };
// Match the factory's client timeout on the server so a timed-out audit query cannot
// keep consuming resources after its HTTP request has already failed.
const apiUrl = new URL(url);
apiUrl.searchParams.set('options',`${apiUrl.searchParams.get('options') ?? ''} -c statement_timeout=5000`);
const apiDatabase = createDatabase(apiUrl.href);
let apiQueryTimes: number[] = [];
const api: SqlSession = {
  query: async <Row extends Record<string,unknown>>(sql: string,args?: unknown[]) => {
    const start = Date.now();
    try { return await apiDatabase.query<Row>(sql,args); }
    finally { apiQueryTimes.push(Date.now()-start); }
  },
  exec: sql => apiDatabase.exec(sql),
};
const server = serve({ fetch: createApp(api).fetch,hostname: '127.0.0.1',port: 0 });
try {
  if (!server.listening) await new Promise<void>(resolve => server.once('listening',resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing loopback listener');
  const base = `http://127.0.0.1:${address.port}`;
  const checks: Record<string,unknown>[] = [];
  const issuers = (await db.query<{ issuer_id: string; drug: boolean; provider: boolean }>(`WITH issuers AS (
    SELECT issuer_id FROM formulary_active_set UNION SELECT issuer_id FROM provider_active_set)
    SELECT i.issuer_id,EXISTS(SELECT 1 FROM formulary_active_set a WHERE a.issuer_id=i.issuer_id
      AND a.plan_year=2026 AND a.state='TX') AS drug,
    EXISTS(SELECT 1 FROM provider_active_set a WHERE a.issuer_id=i.issuer_id
      AND a.plan_year=2026 AND a.state='TX') AS provider FROM issuers i ORDER BY i.issuer_id`)).rows;
  for (const { issuer_id: issuer,drug: activeDrug,provider: activeProvider } of issuers) {
    const drug = (await db.query<{ base_hios_id: string; rxcui: string }>(`SELECT e.base_hios_id,e.rxcui
      FROM formulary_active_set a JOIN formulary_shard s ON s.source_set_id=a.snapshot_id
      JOIN formulary_edge e ON e.snapshot_id=s.snapshot_id WHERE a.issuer_id=$1 AND a.plan_year=2026 AND a.state='TX'
      AND EXISTS(SELECT 1 FROM rx_concept c JOIN snapshot snap USING(snapshot_id)
        WHERE c.rxcui=e.rxcui AND c.suppress='N' AND snap.validation_state='ACTIVE') LIMIT 1`,[issuer])).rows[0];
    const provider = (await db.query<{ base_hios_id: string; npi: string; name: string }>(`SELECT e.base_hios_id,r.npi,
      coalesce(nullif(n.organization_name,''),nullif(n.last_name,''),nullif(n.first_name,'')) AS name FROM provider_active_set a
      JOIN provider_shard s ON s.source_set_id=a.snapshot_id JOIN qhp_provider_plan e ON e.snapshot_id=s.snapshot_id
      JOIN qhp_provider_record r ON r.snapshot_id=e.snapshot_id AND r.record_id=e.record_id JOIN npi_provider n ON n.npi=r.npi
      WHERE a.issuer_id=$1 AND a.plan_year=2026 AND a.state='TX'
      AND coalesce(nullif(n.organization_name,''),nullif(n.last_name,''),nullif(n.first_name,'')) IS NOT NULL LIMIT 1`,[issuer])).rows[0];
    const row: Record<string,unknown> = { issuer };
    const fallbackPlan = (await catalogPlans(db,{ issuer,year: 2026,state: 'TX' }))[0]?.base_plan_id;
    const knownCode = (await db.query<{ rxcui: string }>(`SELECT c.rxcui FROM rx_concept c
      JOIN snapshot s USING(snapshot_id) WHERE s.validation_state='ACTIVE' AND c.suppress='N' LIMIT 1`)).rows[0]?.rxcui;
    if (!fallbackPlan || !knownCode) throw new Error('Active issuer lacks catalog or RxNorm prerequisite');
    const drugPlan = drug?.base_hios_id ?? fallbackPlan, code = drug?.rxcui ?? knownCode;
    {
      apiQueryTimes = []; const started = Date.now();
      const response = await fetch(`${base}/v1/plans/${drugPlan}/drugs/${code}?year=2026`);
      const body = await response.json() as Record<string,unknown>;
      const expected = activeDrug ? 'listed_covered' : 'unknown';
      row.drug = { elapsed_ms: Date.now()-started,max_query_ms: Math.max(0,...apiQueryTimes),plan: drugPlan,rxcui: code,http_status: response.status,status: body.status,expected,
        pass: response.ok && body.status === expected };
    }
    {
      const plan = provider?.base_hios_id ?? fallbackPlan;
      apiQueryTimes = []; const started = Date.now();
      const response = await fetch(`${base}/v1/providers?plan_id=${plan}&year=2026${provider?.name ? `&name=${encodeURIComponent(provider.name)}` : ''}`);
      const body = await response.json() as { status?: string; providers?: { participation?: string; nppes_snapshot_id?: string }[]; total?: number };
      const enriched = body.providers?.some(p => Boolean(p.nppes_snapshot_id));
      row.provider = { elapsed_ms: Date.now()-started,max_query_ms: Math.max(0,...apiQueryTimes),plan,http_status: response.status,status: body.status,total: body.total,
        nppes_enriched: enriched,expected: activeProvider ? 'positive_enriched_results' : 'unknown_empty',
        pass: response.ok && (activeProvider ? Number(body.total) > 0 && enriched
          && body.providers?.every(p => p.participation === 'listed_participating') : body.total === 0 && body.status === 'unknown') };
    }
    checks.push(row); console.log(JSON.stringify(row));
    await mkdir(join(cache,'reports'),{ recursive: true });
    await writeFile(join(cache,'reports',`${prefix}-audit.json`),JSON.stringify({ checks,audit_incomplete: true },null,2)+'\n');
  }
  const storage = (await db.query(`SELECT (SELECT count(*)::int FROM provider_plan_group) AS shared_lists,
    (SELECT count(*)::int FROM provider_plan_group_edge) AS shared_list_edges,
    (SELECT count(*)::int FROM provider_record_plan_group) AS record_links,
    (SELECT count(*)::int FROM qhp_provider_plan_legacy) AS sparse_edges,
    (SELECT coalesce(sum(l.n*e.n),0)::text FROM
      (SELECT group_id,count(*)::bigint n FROM provider_record_plan_group GROUP BY group_id) l JOIN
      (SELECT group_id,count(*)::bigint n FROM provider_plan_group_edge GROUP BY group_id) e USING(group_id)) AS expanded_shared_edges,
    pg_total_relation_size('provider_plan_group_edge')::text AS shared_edges_bytes,
    pg_total_relation_size('provider_record_plan_group')::text AS record_links_bytes,
    pg_total_relation_size('qhp_provider_plan_legacy')::text AS sparse_edges_bytes`)).rows[0];
  const identities = (await db.query(`SELECT (SELECT count(*)::int FROM npi_provider) AS nppes,
    (SELECT count(*)::int FROM npi_taxonomy) AS taxonomies,(SELECT count(*)::int FROM npi_address) AS npi_addresses,
    (SELECT count(*)::int FROM rx_concept) AS rxnorm_atoms,(SELECT postgis_version()) AS postgis,
    version() AS postgres,pg_database_size(current_database())::text AS database_bytes`)).rows[0];
  // Count dense repeated lists by multiplicity rather than expanding hundreds of millions of rows.
  // Legacy per-record overrides and tombstones are subtracted from the shared-list contribution.
  const attribution = (await db.query(`WITH packed AS (
    SELECT f.source_set_id,l.group_id,count(*)::bigint AS weight FROM provider_record_plan_group l
    JOIN provider_shard f USING(snapshot_id) GROUP BY f.source_set_id,l.group_id
  ), hidden AS (
    SELECT l.snapshot_id,l.record_id,l.group_id,e.source_plan_index FROM provider_plan_override e
    JOIN provider_record_plan_group l USING(snapshot_id,record_id)
    UNION
    SELECT l.snapshot_id,l.record_id,l.group_id,e.source_plan_index FROM provider_plan_suppressed e
    JOIN provider_record_plan_group l USING(snapshot_id,record_id)
  ), counts AS (
    SELECT f.source_set_id,count(*)::bigint AS n,
      count(*) FILTER(WHERE left(e.base_hios_id,5)<>s.issuer_id)::bigint AS wrong_issuer,
      count(*) FILTER(WHERE substring(e.base_hios_id,6,2)<>s.state)::bigint AS wrong_state,
      count(*) FILTER(WHERE e.plan_year<>s.plan_year)::bigint AS wrong_year
    FROM qhp_provider_plan_legacy e JOIN provider_shard f USING(snapshot_id)
    JOIN provider_source_set s ON s.snapshot_id=f.source_set_id GROUP BY f.source_set_id
    UNION ALL
    SELECT p.source_set_id,sum(p.weight)::bigint,
      sum(p.weight) FILTER(WHERE left(e.base_hios_id,5)<>s.issuer_id)::bigint,
      sum(p.weight) FILTER(WHERE substring(e.base_hios_id,6,2)<>s.state)::bigint,
      sum(p.weight) FILTER(WHERE e.plan_year<>s.plan_year)::bigint
    FROM packed p JOIN provider_source_set s ON s.snapshot_id=p.source_set_id
    JOIN provider_plan_group_edge e USING(group_id) GROUP BY p.source_set_id
    UNION ALL
    SELECT f.source_set_id,-count(*)::bigint,
      -count(*) FILTER(WHERE left(e.base_hios_id,5)<>s.issuer_id)::bigint,
      -count(*) FILTER(WHERE substring(e.base_hios_id,6,2)<>s.state)::bigint,
      -count(*) FILTER(WHERE e.plan_year<>s.plan_year)::bigint
    FROM hidden h JOIN provider_plan_group_edge e USING(group_id,source_plan_index)
    JOIN provider_shard f ON f.snapshot_id=h.snapshot_id JOIN provider_source_set s ON s.snapshot_id=f.source_set_id
    GROUP BY f.source_set_id
  ), actual AS (SELECT source_set_id,sum(n)::bigint n,sum(wrong_issuer) AS wrong_issuer,
    sum(wrong_state) AS wrong_state,sum(wrong_year) AS wrong_year FROM counts GROUP BY source_set_id),
  declared AS (SELECT source_set_id,sum(edge_count)::bigint n FROM provider_shard GROUP BY source_set_id)
  SELECT (SELECT count(*)::int FROM actual a FULL JOIN declared d USING(source_set_id)
      WHERE coalesce(a.n,0)<>coalesce(d.n,0)) AS logical_edge_mismatches,
    coalesce(sum(wrong_issuer),0)::int AS wrong_issuer,coalesce(sum(wrong_state),0)::int AS wrong_state,
    coalesce(sum(wrong_year),0)::int AS wrong_year FROM actual`)).rows[0];
  const matches = (await db.query(`SELECT s.issuer_id,count(*)::int AS records,
    count(*) FILTER(WHERE r.npi IS NOT NULL)::int AS with_npi,
    count(*) FILTER(WHERE r.npi IS NOT NULL AND n.npi IS NULL)::int AS npi_absent_from_nppes,
    count(DISTINCT r.npi)::int AS distinct_npis,count(DISTINCT n.npi)::int AS nppes_matches
    FROM provider_source_set s JOIN provider_shard f ON f.source_set_id=s.snapshot_id
    JOIN qhp_coverage_manifest m ON m.snapshot_id=s.snapshot_id AND m.kind='provider'
    JOIN qhp_provider_record r ON r.snapshot_id=f.snapshot_id LEFT JOIN npi_provider n ON n.npi=r.npi
    GROUP BY s.issuer_id ORDER BY s.issuer_id`)).rows;
  let txMatchesReason: string | undefined;
  const txMatches = await db.query(`WITH eligible AS (
    SELECT a.issuer_id,e.snapshot_id,e.record_id FROM provider_active_set a
    JOIN provider_shard s ON s.source_set_id=a.snapshot_id JOIN qhp_provider_plan_legacy e ON e.snapshot_id=s.snapshot_id
    WHERE a.plan_year=2026 AND a.state='TX' GROUP BY a.issuer_id,e.snapshot_id,e.record_id
    UNION
    SELECT a.issuer_id,l.snapshot_id,l.record_id FROM provider_active_set a
    JOIN provider_shard s ON s.source_set_id=a.snapshot_id JOIN provider_record_plan_group l ON l.snapshot_id=s.snapshot_id
    WHERE a.plan_year=2026 AND a.state='TX' AND EXISTS(SELECT 1 FROM provider_plan_group_edge e
      WHERE e.group_id=l.group_id AND NOT EXISTS(SELECT 1 FROM provider_plan_override x
        WHERE x.snapshot_id=l.snapshot_id AND x.record_id=l.record_id AND x.source_plan_index=e.source_plan_index)
      AND NOT EXISTS(SELECT 1 FROM provider_plan_suppressed x WHERE x.snapshot_id=l.snapshot_id
        AND x.record_id=l.record_id AND x.source_plan_index=e.source_plan_index) OFFSET 0)
  ) SELECT e.issuer_id,count(*)::int AS tx_records,count(DISTINCT r.npi)::int AS tx_npis,
    count(DISTINCT n.npi)::int AS tx_nppes_matches FROM eligible e
    JOIN qhp_provider_record r USING(snapshot_id,record_id) LEFT JOIN npi_provider n ON n.npi=r.npi GROUP BY e.issuer_id`).then(result => result.rows).catch(() => {
      txMatchesReason = 'not_measured_query_failed'; return [];
    });
  const identityComparison = await comparePriorProviderIdentity(db,cache);
  const providerReports = await synchronizeProviderReport(db,cache,prefix,matches);
  const manifest = (await db.query('SELECT * FROM qhp_coverage_manifest ORDER BY issuer_id,kind')).rows;
  const migrations = (await db.query('SELECT name FROM schema_migrations ORDER BY name')).rows;
  await mkdir(join(cache,'reports'),{ recursive: true });
  await writeFile(join(cache,'reports',`${prefix}-audit.json`),JSON.stringify({ identities,storage,attribution,matches,identity_comparison: identityComparison,provider_reports: providerReports,tx_matches: txMatches,tx_matches_reason: txMatchesReason,checks,manifest,migrations },null,2)+'\n');
  if (identityComparison.some(row => row.status === 'same_source_records' && !row.pass)) process.exitCode = 1;
  if (['wrong_issuer','wrong_state','wrong_year','logical_edge_mismatches'].some(k => Number(attribution?.[k]) !== 0)) process.exitCode = 1;
  if (checks.some(r => [r.drug,r.provider].some(c => c && typeof c === 'object' && 'pass' in c && !c.pass))) process.exitCode = 1;
} finally {
  await new Promise<void>((resolve,reject) => server.close(error => error ? reject(error) : resolve()));
  await apiDatabase.close();
  await pool.end();
}
