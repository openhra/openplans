import type { SqlSession } from '../../db/database.js';
import type { ImportKind } from './import-source.js';
import { importTables } from './import-parse.js';

export interface FileReconciliation {
  error?: string; expected_rows?: number; source?: 'cms_sbe_puf'; member?: string; bundle_url?: string;
  kind: ImportKind; snapshot_id: string; sha256: string; input_rows: number; stored_rows: number; rejected_rows: number;
}
export interface ReconciliationCheck { code: string; severity: 'error' | 'warning'; count: number; sample: Record<string, unknown>[] }
export interface Reconciliation {
  files: FileReconciliation[];
  checks: ReconciliationCheck[];
  identifiers: { attribute_14: number; attribute_17: number; base_plans: number; variants: number; rate_14: number; rate_17: number };
  passed: boolean;
}
export async function reconcileImport(db: SqlSession, files: FileReconciliation[], options: { sbe?: boolean } = {}): Promise<Reconciliation> {
  const snapshots = Object.fromEntries(files.map(f => [f.kind, f.snapshot_id]));
  const p = snapshots['plan-attributes'], s = snapshots['service-area'], r = snapshots.rate,
    n = snapshots.network, b = snapshots['benefits-and-cost-sharing'];
  const checks: ReconciliationCheck[] = [];
  for (const file of files) {
    file.stored_rows = Number((await db.query(`SELECT count(*) AS n FROM ${importTables[file.kind]} WHERE snapshot_id=$1`, [file.snapshot_id])).rows[0]!.n);
    if (file.expected_rows !== undefined && file.expected_rows !== file.stored_rows) checks.push({ code: 'state_source_row_count', severity: 'error', count: Math.max(1, Math.abs(file.expected_rows - file.stored_rows)), sample: [{ kind: file.kind, expected: file.expected_rows, stored: file.stored_rows }] });
    if (file.input_rows !== file.stored_rows || (file.input_rows === 0 && !(options.sbe && file.kind === 'business-rules'))) checks.push({ code: 'file_row_count', severity: 'error', count: Math.max(1, file.input_rows - file.stored_rows), sample: [{ kind: file.kind, input: file.input_rows, stored: file.stored_rows }] });
  }
  async function check(code: string, sql: string, parameters: unknown[], severity: 'error' | 'warning' = 'error') {
    const { rows } = await db.query(`SELECT count(*) OVER() AS total, x.* FROM (${sql}) x LIMIT 20`, parameters);
    checks.push({ code, severity, count: Number(rows[0]?.total ?? 0), sample: rows.map(({ total: _total, ...row }) => row) });
  }
  await check('plans_without_rates', `SELECT p.base_plan_id FROM plan p WHERE p.snapshot_id=$1 AND NOT EXISTS
    (SELECT 1 FROM rate r WHERE r.snapshot_id=$2 AND r.base_plan_id=p.base_plan_id)`, [p, r]);
  await check('rates_without_plan', `SELECT r.base_plan_id,r.source_row FROM rate r WHERE r.snapshot_id=$1 AND NOT EXISTS
    (SELECT 1 FROM plan p WHERE p.snapshot_id=$2 AND p.base_plan_id=r.base_plan_id)`, [r, p]);
  await check('variants_without_base', `SELECT v.variant_plan_id FROM plan_variant v WHERE v.snapshot_id=$1 AND NOT EXISTS
    (SELECT 1 FROM plan p WHERE p.snapshot_id=$1 AND p.base_plan_id=v.base_plan_id)`, [p]);
  await check('unused_service_areas', `SELECT s.issuer_id,s.service_area_id,s.market,s.dental_only FROM service_area s WHERE s.snapshot_id=$1 AND NOT EXISTS
    (SELECT 1 FROM plan p WHERE p.snapshot_id=$2 AND p.issuer_id=s.issuer_id AND p.service_area_id=s.service_area_id AND p.market=s.market AND p.dental_only=s.dental_only)`, [s, p], 'warning');
  await check('plans_without_service_area', `SELECT p.base_plan_id FROM plan p WHERE p.snapshot_id=$1 AND NOT EXISTS
    (SELECT 1 FROM service_area s WHERE s.snapshot_id=$2 AND s.issuer_id=p.issuer_id AND s.service_area_id=p.service_area_id AND s.market=p.market AND s.dental_only=p.dental_only)`, [p, s]);
  await check('plans_without_network', `SELECT p.base_plan_id FROM plan p WHERE p.snapshot_id=$1 AND NOT EXISTS
    (SELECT 1 FROM network n WHERE n.snapshot_id=$2 AND n.issuer_id=p.issuer_id AND n.network_id=p.network_id AND n.market=p.market AND n.dental_only=p.dental_only)`, [p, n]);
  await check('benefits_without_plan', `SELECT DISTINCT b.published_plan_id FROM plan_benefit b WHERE b.snapshot_id=$1 AND NOT EXISTS
    (SELECT 1 FROM plan_attribute p WHERE p.snapshot_id=$2 AND ${options.sbe ? 'p.base_plan_id=b.base_plan_id' : 'p.published_plan_id=b.published_plan_id'})`, [b, p]);
  if (options.sbe) await check('benefit_variant_attributes_missing', `SELECT DISTINCT b.published_plan_id FROM plan_benefit b WHERE b.snapshot_id=$1 AND NOT EXISTS
    (SELECT 1 FROM plan_attribute p WHERE p.snapshot_id=$2 AND p.published_plan_id=b.published_plan_id)`, [b, p], 'warning');
  // Per-member PUF rows explicitly enumerate these 51 bands; never manufacture missing prices.
  await check('incomplete_rate_age_bands', `SELECT base_plan_id,rating_area_id,tobacco,effective_date,expiration_date,count(*) AS rows,count(DISTINCT age_band) AS bands
    FROM rate WHERE snapshot_id=$1 AND rating_method='per_member'
    GROUP BY base_plan_id,rating_area_id,tobacco,effective_date,expiration_date HAVING count(*)<>51 OR count(DISTINCT age_band)<>51`, [r]);
  await check('duplicate_rate_keys', `SELECT base_plan_id,rating_area_id,tobacco,effective_date,expiration_date,age_band,count(*) AS rows
    FROM rate WHERE snapshot_id=$1 GROUP BY base_plan_id,rating_area_id,tobacco,effective_date,expiration_date,age_band HAVING count(*)>1`, [r]);
  const identifiers = (await db.query(`SELECT
    (SELECT count(*) FROM plan_attribute WHERE snapshot_id=$1 AND length(published_plan_id)=14)::integer AS attribute_14,
    (SELECT count(*) FROM plan_attribute WHERE snapshot_id=$1 AND length(published_plan_id)=17)::integer AS attribute_17,
    (SELECT count(*) FROM plan WHERE snapshot_id=$1)::integer AS base_plans,
    (SELECT count(*) FROM plan_variant WHERE snapshot_id=$1)::integer AS variants,
    (SELECT count(*) FROM rate WHERE snapshot_id=$2 AND length(base_plan_id)=14)::integer AS rate_14,
    (SELECT count(*) FROM rate WHERE snapshot_id=$2 AND length(base_plan_id)=17)::integer AS rate_17`, [p, r])).rows[0] as Reconciliation['identifiers'];
  const invalid = files.reduce((sum, file) => sum + file.rejected_rows, 0);
  if (invalid) checks.push({ code: 'rejected_source_rows', severity: 'error', count: invalid, sample: [] });
  return { files, checks, identifiers, passed: !checks.some(check => check.severity === 'error' && check.count > 0) };
}
