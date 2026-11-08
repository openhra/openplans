import type { SqlSession } from '../../db/database.js';
import type { SnapshotMetadata } from '../../fetch/index.js';

export interface DiscoveryIndex {
  id: string; discovery: string; issuer: string; year: number; state: string;
  registrySnapshot: string; row: number; url: string | null; snapshot: string | null;
  status: string; httpStatus?: number; pufHosts: string[]; childHosts: string[];
  metadata: Record<string, unknown>;
}
export interface DiscoveryChild {
  kind: 'plan_urls' | 'provider_urls' | 'formulary_urls'; url: string; publishedUrl: string; urlSha256: string; host: string | null;
  snapshot: string | null; status: string; httpStatus?: number; metadata: Record<string, unknown>;
}
export async function saveDiscoverySnapshot(db: SqlSession, source: string, id: string, metadata: SnapshotMetadata,
  path: string, issuer: string | null, evidence: unknown[], state: 'PARSED' | 'QUARANTINED' | 'FETCHING' = 'PARSED', approvedHosts: string[] = [],
): Promise<void> {
  await db.query(`INSERT INTO source(source_id,publisher,issuer_scope,source_kind,registry_evidence,approved_destinations)
    VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
  [source, issuer ? 'QHP issuer publication' : 'Centers for Medicare & Medicaid Services', JSON.stringify(issuer ? [issuer] : []),
    issuer ? 'qhp' : 'exchange-puf', JSON.stringify(evidence), JSON.stringify(approvedHosts)]);
  await db.query(`INSERT INTO snapshot(snapshot_id,source_id,requested_url,final_url,redirect_chain,retrieved_at,http_status,
    etag,last_modified,content_type,compressed_bytes,sha256,raw_path,parser_version,validation_state)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'qhp-discover-v1',$14)
    ON CONFLICT (snapshot_id) DO UPDATE SET validation_state=CASE
      WHEN snapshot.validation_state='ACTIVE' THEN snapshot.validation_state ELSE excluded.validation_state END`,
  [id, source, metadata.url, metadata.final_url, JSON.stringify(metadata.redirect_chain), metadata.fetched_at, metadata.status,
    metadata.etag, metadata.last_modified, metadata.content_type, metadata.bytes, metadata.sha256, path, state]);
}
export async function saveDiscoveryIndex(db: SqlSession, index: DiscoveryIndex, children: DiscoveryChild[]): Promise<void> {
  await db.query(`INSERT INTO qhp_index(qhp_index_id,discovery_id,issuer_id,plan_year,state,registry_snapshot_id,
    registry_row,url,snapshot_id,status,http_status,puf_hosts,child_hosts,publisher_metadata)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
  [index.id, index.discovery, index.issuer, index.year, index.state, index.registrySnapshot, index.row, index.url,
    index.snapshot, index.status, index.httpStatus ?? null, JSON.stringify(index.pufHosts), JSON.stringify(index.childHosts), JSON.stringify(index.metadata)]);
  if (index.snapshot && index.status === 'ok') await db.query(`UPDATE snapshot SET expected_children=$2,fetched_children=$3
    WHERE snapshot_id=$1 AND validation_state <> 'ACTIVE'`, [index.snapshot, children.length, children.filter(child => child.status === 'downloaded').length]);
  for (const child of children) {
    await db.query(`INSERT INTO qhp_child_url(qhp_index_id,issuer_id,plan_year,kind,url,published_url,url_sha256,host,host_evidence,
      index_snapshot_id,snapshot_id,status,http_status,publisher_metadata)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'index_child',$9,$10,$11,$12,$13)`,
    [index.id, index.issuer, index.year, child.kind, child.url, child.publishedUrl, child.urlSha256, child.host, index.snapshot, child.snapshot,
      child.status, child.httpStatus ?? null, JSON.stringify(child.metadata)]);
  }
}
