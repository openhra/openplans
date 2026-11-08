import type { SqlSession } from '../../db/database.js';
import type { CachedChild, FormularyScope as ProviderScope } from './formulary-repository.js';
export { sourceSet, catalogPlans, saveIssues } from './formulary-repository.js';
export type { CachedChild, FormularyScope as ProviderScope } from './formulary-repository.js';

export async function beginSourceSet(db: SqlSession, scope: ProviderScope, id: string, discovery: string | null,
  sha: string, expected: number, catalog: string | null) {
  const source = `qhp-provider-${scope.issuer}-${scope.year}-${scope.state}`;
  await db.query(`INSERT INTO source(source_id,publisher,issuer_scope,source_kind,registry_evidence)
    VALUES ($1,'QHP issuer publication',$2,'qhp-provider',$3) ON CONFLICT DO NOTHING`,
  [source, JSON.stringify([scope.issuer]), JSON.stringify({ discovery_id: discovery })]);
  await db.query(`INSERT INTO snapshot(snapshot_id,source_id,sha256,retrieved_at,parser_version,expected_children,validation_state)
    VALUES ($1,$2,$3,now(),'qhp-provider-v4',$4,'FETCHING')`, [id, source, sha, expected]);
  await db.query(`INSERT INTO provider_source_set(snapshot_id,issuer_id,plan_year,state,discovery_id,catalog_snapshot_id)
    VALUES ($1,$2,$3,$4,$5,$6)`, [id, scope.issuer, scope.year, scope.state, discovery, catalog]);
}
export async function beginShard(db: SqlSession, id: string, set: string, child: CachedChild) {
  await db.query(`INSERT INTO snapshot(snapshot_id,source_id,requested_url,final_url,redirect_chain,retrieved_at,
    publisher_updated_at,http_status,etag,last_modified,content_type,compressed_bytes,sha256,raw_path,
    parser_version,expected_children,validation_state)
    SELECT $1,source_id,requested_url,final_url,redirect_chain,retrieved_at,publisher_updated_at,http_status,
    etag,last_modified,content_type,compressed_bytes,sha256,raw_path,'qhp-provider-v4',0,'FETCHING'
    FROM snapshot WHERE snapshot_id=$2`, [id, child.snapshot_id]);
  // Missing/unfetched children still have a quarantinable attempt snapshot.
  await db.query(`INSERT INTO snapshot(snapshot_id,source_id,parser_version,expected_children,validation_state)
    SELECT $1,source_id,'qhp-provider-v4',0,'FETCHING' FROM snapshot WHERE snapshot_id=$2
    ON CONFLICT DO NOTHING`, [id, set]);
  await db.query(`INSERT INTO provider_shard(source_set_id,child_id,snapshot_id,raw_snapshot_id,status,reason)
    VALUES ($1,$2,$3,$4,'failed','not_parsed')`, [set, child.child_id, id, child.snapshot_id]);
}
const jsonColumns = new Set(['name','facility_type','speciality','specialty','languages','accepting','raw']);
export async function insertRows(db: SqlSession, table: string, columns: string[], rows: unknown[][]) {
  // One typed JSON parameter avoids reparsing thousands of placeholders per batch in PGlite.
  // Column names/table names are constants supplied only by this adapter.
  for (let at = 0; at < rows.length; at += 1000) {
    const entries = rows.slice(at, at + 1000).map(row => Object.fromEntries(columns.map((column, index) => {
      const value = row[index];
      return [column, jsonColumns.has(column) && typeof value === 'string' ? JSON.parse(value) : value];
    })));
    await db.query(`INSERT INTO ${table}(${columns.join(',')}) SELECT ${columns.join(',')}
      FROM jsonb_populate_recordset(NULL::${table},$1::jsonb)`, [JSON.stringify(entries)]);
  }
}
export async function publishSet(db: SqlSession, scope: ProviderScope, id: string,
  status: 'complete' | 'partial' | 'failed' | 'access_denied' | 'unknown', reason: string, expected: number, complete: number, markets: string[], publishPositive = status === 'complete') {
  const active = publishPositive;
  await db.query(`UPDATE snapshot SET validation_state=$2,fetched_children=$3,activated_at=CASE WHEN $4 THEN now() ELSE NULL END
    WHERE snapshot_id=$1`, [id, active ? 'ACTIVE' : 'QUARANTINED', complete, active]);
  if (active) {
    await db.query(`INSERT INTO provider_active_set(issuer_id,plan_year,state,snapshot_id) VALUES ($1,$2,$3,$4)
      ON CONFLICT(issuer_id,plan_year,state) DO UPDATE SET snapshot_id=excluded.snapshot_id`, [scope.issuer, scope.year, scope.state, id]);
    await db.query(`UPDATE snapshot SET validation_state='ACTIVE',activated_at=now() WHERE snapshot_id IN
      (SELECT snapshot_id FROM provider_shard WHERE source_set_id=$1)`, [id]);
  } else {
    await db.query(`UPDATE snapshot SET validation_state='QUARANTINED' WHERE snapshot_id IN
      (SELECT snapshot_id FROM provider_shard WHERE source_set_id=$1)`, [id]);
  }
  await db.query(`INSERT INTO qhp_coverage_manifest(issuer_id,plan_year,state,kind,status,reason,snapshot_id,expected_children,complete_children)
    VALUES ($1,$2,$3,'provider',$4,$5,$6,$7,$8) ON CONFLICT(issuer_id,plan_year,state,kind) DO UPDATE SET
    status=excluded.status,reason=excluded.reason,snapshot_id=excluded.snapshot_id,
    expected_children=excluded.expected_children,complete_children=excluded.complete_children,updated_at=now()`,
  [scope.issuer, scope.year, scope.state, status, reason, id, expected, complete]);
  for (const market of markets) await db.query(`INSERT INTO data_availability(state,plan_year,market,issuer_id,provider_status,snapshot_id)
    VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT(state,plan_year,market,issuer_id) DO UPDATE SET
    provider_status=excluded.provider_status`, [scope.state, scope.year, market, scope.issuer, active ? 'available' : 'unknown', id]);
}

/** Group identity includes ordinal, plan, year and exact tier facts; no associations are deduplicated. */
export async function insertPlanGroups(db: SqlSession, groups: Map<string,unknown[][]>, links: unknown[][]) {
  if (!links.length) return;
  const inserted = (await db.query<{ group_id: string }>(`INSERT INTO provider_plan_group(group_id)
    SELECT value FROM jsonb_array_elements_text($1::jsonb) ON CONFLICT DO NOTHING RETURNING group_id`,
  [JSON.stringify([...groups.keys()])])).rows;
  const edges = inserted.flatMap(({ group_id }) => groups.get(group_id)!.map(row => [group_id,...row]));
  await insertRows(db,'provider_plan_group_edge',['group_id','source_plan_index','base_hios_id','plan_year','network_tier','tier_status'],edges);
  await insertRows(db,'provider_record_plan_group',['snapshot_id','record_id','group_id'],links);
}
