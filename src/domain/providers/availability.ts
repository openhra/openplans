import type { SqlSession } from '../../db/database.js';

export type ProviderSourceStatus = 'complete' | 'partial' | 'failed' | 'access_denied' | 'unknown';
export interface ProviderAvailability extends Record<string, unknown> {
  issuer_id: string; plan_year: number; state: string; status: ProviderSourceStatus;
  reason: string; snapshot_id: string | null; active_snapshot_id: string | null;
  discovery_id: string | null; expected_children: number; complete_children: number;
}
/** Discovery alone never establishes completeness. Only a validated current source set can. */
export async function providerAvailability(db: SqlSession, scope?: { issuer: string; year: number; state: string }): Promise<ProviderAvailability[]> {
  const rows = (await db.query<ProviderAvailability & {
    manifest_status: ProviderSourceStatus | null; manifest_reason: string | null;
    manifest_discovery: string | null; index_statuses: string[] | null;
    child_statuses: string[] | null; discovered_children: number | null; denied: boolean | null;
  }>(`WITH latest AS (
    SELECT DISTINCT ON (issuer_id,plan_year,state) issuer_id,plan_year,state,discovery_id
    FROM qhp_index ORDER BY issuer_id,plan_year,state,discovered_at DESC,qhp_index_id DESC
  ), discovery AS (
    SELECT l.issuer_id,l.plan_year,l.state,l.discovery_id,
      array_agg(DISTINCT i.status) AS index_statuses,
      bool_or(i.http_status=403 OR (c.kind IN ('plan_urls','provider_urls') AND c.http_status=403)) AS denied,
      array_agg(DISTINCT c.status) FILTER (WHERE c.kind IN ('provider_urls','plan_urls')) AS child_statuses,
      count(DISTINCT c.url_sha256) FILTER (WHERE c.kind='provider_urls')::int AS discovered_children
    FROM latest l JOIN qhp_index i ON i.discovery_id=l.discovery_id AND i.issuer_id=l.issuer_id
      AND i.plan_year=l.plan_year AND i.state=l.state
    LEFT JOIN qhp_child_url c USING(qhp_index_id) GROUP BY l.issuer_id,l.plan_year,l.state,l.discovery_id
  ), manifest AS (
    SELECT m.*,s.discovery_id AS manifest_discovery,a.snapshot_id AS active_snapshot_id
    FROM qhp_coverage_manifest m LEFT JOIN provider_source_set s USING(snapshot_id)
    LEFT JOIN provider_active_set a ON a.issuer_id=m.issuer_id AND a.plan_year=m.plan_year AND a.state=m.state
    WHERE m.kind='provider'
  ) SELECT coalesce(m.issuer_id,d.issuer_id) AS issuer_id,coalesce(m.plan_year,d.plan_year) AS plan_year,
    coalesce(m.state,d.state) AS state,m.status AS manifest_status,m.reason AS manifest_reason,
    m.snapshot_id,m.active_snapshot_id,m.manifest_discovery,d.discovery_id,d.index_statuses,d.child_statuses,
    d.discovered_children,d.denied,coalesce(m.expected_children,d.discovered_children,0)::int AS expected_children,
    coalesce(m.complete_children,0)::int AS complete_children
    FROM manifest m FULL JOIN discovery d USING(issuer_id,plan_year,state)
    WHERE ($1::text IS NULL OR coalesce(m.issuer_id,d.issuer_id)=$1)
      AND ($2::int IS NULL OR coalesce(m.plan_year,d.plan_year)=$2)
      AND ($3::text IS NULL OR coalesce(m.state,d.state)=$3)
    ORDER BY state,plan_year,issuer_id`, [scope?.issuer ?? null, scope?.year ?? null, scope?.state ?? null])).rows;
  return rows.map(row => {
    const statuses = [...row.index_statuses ?? [], ...row.child_statuses ?? []];
    let status: ProviderSourceStatus = 'unknown', reason = 'source_set_not_validated';
    if (row.denied || statuses.includes('access_denied') || row.manifest_status === 'access_denied') {
      status = 'access_denied'; reason = 'source_access_denied';
    } else if (row.index_statuses?.some(s => s !== 'ok') || row.child_statuses?.some(s => !['downloaded','discovered'].includes(s))) {
      status = row.child_statuses?.includes('downloaded') ? 'partial' : 'failed'; reason = 'discovery_incomplete';
    } else if (row.manifest_status && (!row.discovery_id || row.manifest_discovery === row.discovery_id)) {
      status = row.manifest_status; reason = row.manifest_reason ?? reason;
      if (status === 'complete' && (row.snapshot_id !== row.active_snapshot_id
        || row.child_statuses?.some(s => s !== 'downloaded'))) { status = 'unknown'; reason = 'source_set_not_active'; }
    }
    return { issuer_id: row.issuer_id, plan_year: row.plan_year, state: row.state, status, reason,
      snapshot_id: row.snapshot_id ?? null, active_snapshot_id: row.active_snapshot_id ?? null,
      discovery_id: row.discovery_id ?? row.manifest_discovery ?? null,
      expected_children: row.discovery_id && row.manifest_discovery !== row.discovery_id ? row.discovered_children ?? 0 : row.expected_children,
      complete_children: !row.discovery_id || row.manifest_discovery === row.discovery_id ? row.complete_children : 0 };
  });
}
