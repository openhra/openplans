/** Reconcile developer reports with the database manifest, including concurrent issuer runs. */
import { readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import type { SqlSession } from '../../db/database.js';
export async function synchronizeProviderReport(db: SqlSession, cache: string, prefix: string,
  matches: Record<string,unknown>[]) {
  const path = join(cache,'reports',`${prefix}-providers-realdata.json`);
  let prior: { database?: string; issuers?: Record<string,unknown>[] } = {};
  try { prior = JSON.parse(await readFile(path,'utf8')); } catch { /* database remains authoritative */ }
  const logs: Record<string,unknown>[] = [];
  for (const name of [`${prefix}-providers.log`,`${prefix}-retries.log`]) {
    let content = ''; try { content = await readFile(join(cache,'reports',name),'utf8'); } catch { /* optional */ }
    for (const line of content.split('\n')) try {
      const row = JSON.parse(line); if (row.kind === 'providers' && typeof row.elapsed_ms === 'number') logs.push(row);
    } catch { /* progress text, not a completed issuer report */ }
  }
  const rows = (await db.query(`SELECT m.issuer_id AS issuer,m.plan_year AS year,m.state,m.snapshot_id,
    s.validation_state AS status,m.status AS completeness,m.reason,m.expected_children,m.complete_children,
    CASE WHEN s.activated_at IS NOT NULL THEN extract(epoch FROM(s.activated_at-s.created_at))*1000 END AS source_window_ms,
    coalesce((SELECT sum(f.record_count) FROM provider_shard f WHERE f.source_set_id=m.snapshot_id),0)::int AS records,
    coalesce((SELECT sum(f.edge_count) FROM provider_shard f WHERE f.source_set_id=m.snapshot_id),0)::int AS edges
    FROM qhp_coverage_manifest m JOIN snapshot s USING(snapshot_id)
    WHERE m.kind='provider' AND m.plan_year=2026 AND m.state='TX' ORDER BY m.issuer_id`)).rows;
  const shards = (await db.query(`SELECT f.source_set_id,f.snapshot_id FROM provider_shard f
    JOIN qhp_coverage_manifest m ON m.snapshot_id=f.source_set_id WHERE m.kind='provider' AND m.plan_year=2026 AND m.state='TX'`)).rows;
  const owners = new Map<string,string>();
  for (const row of rows) owners.set(String(row.snapshot_id),String(row.issuer));
  for (const shard of shards) owners.set(String(shard.snapshot_id),owners.get(String(shard.source_set_id))!);
  const issues = (await db.query(`SELECT snapshot_id,issue_code,explanation FROM quality_issue WHERE snapshot_id=ANY($1::text[])`,
    [[...owners.keys()]])).rows;
  const issueCounts = new Map<string,Record<string,number>>();
  for (const issue of issues) {
    const issuer = owners.get(String(issue.snapshot_id))!, totals = issueCounts.get(issuer) ?? {};
    let count = 1; try { count = Number(JSON.parse(String(issue.explanation)).count ?? 1); } catch { /* one issue row */ }
    totals[String(issue.issue_code)] = (totals[String(issue.issue_code)] ?? 0)+count; issueCounts.set(issuer,totals);
  }
  const files = (await db.query(`SELECT f.source_set_id,c.qhp_child_url_id::text AS child_id,c.url,c.url_sha256,
    f.raw_snapshot_id AS snapshot_id,r.sha256,coalesce(r.compressed_bytes,0)::float8 AS bytes,r.http_status,
    CASE WHEN r.snapshot_id IS NOT NULL THEN 'downloaded' ELSE coalesce(f.reason,'child_not_cached') END AS status,
    jsonb_build_object('child_id',f.child_id::text,'status',f.status,'reason',f.reason,
      'record_count',f.record_count,'edge_count',f.edge_count) AS validation
    FROM provider_shard f JOIN qhp_child_url c ON c.qhp_child_url_id=f.child_id LEFT JOIN snapshot r ON r.snapshot_id=f.raw_snapshot_id
    JOIN qhp_coverage_manifest m ON m.snapshot_id=f.source_set_id WHERE m.kind='provider' AND m.plan_year=2026 AND m.state='TX'`)).rows;
  const reports: Record<string,unknown>[] = [];
  for (const row of rows) {
    const saved = prior.issuers?.find(p => p.snapshot_id === row.snapshot_id);
    const timing = logs.filter(log => log.issuer === row.issuer && log.status === row.completeness
      && Number(log.records ?? 0) === Number(row.records) && Number(log.edges ?? 0) === Number(row.edges)).at(-1);
    const match = matches.find(m => m.issuer_id === row.issuer);
    const selected = files.filter(f => f.source_set_id === row.snapshot_id).map(({ source_set_id: _set,...file }) => file);
    const addresses = saved?.addresses ?? (await db.query<{ n: number }>(`SELECT count(*)::int AS n
      FROM qhp_provider_address WHERE snapshot_id=ANY($1::text[])`,
    [shards.filter(s => s.source_set_id === row.snapshot_id).map(s => s.snapshot_id)])).rows[0]!.n;
    reports.push({ ...saved,...row,kind: 'providers',addresses,files: selected,bytes: selected.reduce((n,f) => n+Number(f.bytes),0),
      elapsed_ms: saved?.elapsed_ms ?? timing?.elapsed_ms ?? (row.source_window_ms !== null ? Number(row.source_window_ms) : row.reason === 'not_run_budget' ? 0 : null),
      elapsed_basis: saved?.elapsed_ms !== undefined ? 'runner_checkpoint' : timing ? 'completed_runner_log' : row.source_window_ms !== null ? 'source_snapshot_window_excludes_definition_acquisition' : 'not_recorded',
      issues: issueCounts.get(String(row.issuer)) ?? {},distinct_npis: match?.distinct_npis ?? 0,nppes_matches: match?.nppes_matches ?? 0,
      nppes_match_rate: Number(match?.distinct_npis) ? Number(match?.nppes_matches)/Number(match?.distinct_npis) : null });
  }
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp,JSON.stringify({ database: prior.database ?? `${prefix}-postgres`,backend: 'Native Postgres; full migrations including PostGIS',
    year: 2026,state: 'TX',kind: 'providers',issuers: reports,running: false,reconciled_to_manifest: true },null,2)+'\n');
  await rename(temp,path);
  return reports;
}

/** Compare the same cached source-record prefixes, so newly imported shards cannot mask enrichment. */
export async function comparePriorProviderIdentity(db: SqlSession, cache: string) {
  let prior: { issuers: Record<string,any>[] };
  try { prior = JSON.parse(await readFile(join(cache,'reports','p6a-providers-realdata.json'),'utf8')); }
  catch { return []; }
  const current = (await db.query(`SELECT a.issuer_id,a.snapshot_id AS source_set_id,f.snapshot_id,c.url_sha256,r.sha256,f.status
    FROM provider_active_set a JOIN provider_shard f ON f.source_set_id=a.snapshot_id
    JOIN qhp_child_url c ON c.qhp_child_url_id=f.child_id JOIN snapshot r ON r.snapshot_id=f.raw_snapshot_id
    WHERE a.plan_year=2026 AND a.state='TX'`)).rows;
  const rows: Record<string,unknown>[] = [];
  for (const old of prior.issuers) {
    if (!Number(old.records) || !current.some(c => c.issuer_id === old.issuer)) continue;
    const bounds: { snapshot_id: unknown; max_record: number }[] = [];
    let comparable = true;
    for (const file of old.files ?? []) {
      const n = Number(file.validation?.record_count ?? 0); if (!n) continue;
      const now = current.find(c => c.issuer_id === old.issuer && c.url_sha256 === file.url_sha256);
      if (!now || now.sha256 !== file.sha256 || now.status !== 'complete') { comparable = false; break; }
      bounds.push({ snapshot_id: now.snapshot_id,max_record: n });
    }
    if (!comparable || !bounds.length) { rows.push({ issuer: old.issuer,status: 'source_bytes_or_structure_changed' }); continue; }
    const counts = (await db.query<{ records: number; with_npi: number; absent: number; matched: number }>(`SELECT count(*)::int AS records,
      count(*) FILTER(WHERE r.npi IS NOT NULL)::int AS with_npi,
      count(*) FILTER(WHERE r.npi IS NOT NULL AND n.npi IS NULL)::int AS absent,
      count(*) FILTER(WHERE n.npi IS NOT NULL)::int AS matched
      FROM jsonb_to_recordset($1::jsonb) AS b(snapshot_id text,max_record bigint)
      JOIN qhp_provider_record r ON r.snapshot_id=b.snapshot_id AND r.source_record<b.max_record
      LEFT JOIN npi_provider n ON n.npi=r.npi`,[JSON.stringify(bounds)])).rows[0]!;
    const same = counts.records === Number(old.records), before = Number(old.issues?.npi_absent_from_nppes ?? 0);
    rows.push({ issuer: old.issuer,status: same ? 'same_source_records' : 'record_set_not_reproduced',
      baseline_records: old.records,current_matched_records: counts.records,with_npi: counts.with_npi,
      absent_before: before,absent_after: counts.absent,matched_after: counts.matched,
      pass: same && counts.absent <= before,sha256_checked_files: bounds.length });
  }
  return rows;
}
