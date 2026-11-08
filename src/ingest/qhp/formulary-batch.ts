import { randomUUID } from 'node:crypto';
import type { Database } from '../../db/database.js';
import { acquireQhpChildren } from './formulary-acquire.js';
import type { AcquisitionOptions } from './formulary-acquire.js';
import { importFormulary } from './formulary.js';
import { ingestProviders } from './provider-acquire.js';
import { sourceSet } from './formulary-repository.js';
export interface QhpBatchOptions extends AcquisitionOptions {
  year: number; state: string; issuer?: string;
  onShard?: import('./provider.js').ProviderOptions['onShard'];
  onReport?: (report: Record<string,unknown>) => void | Promise<void>;
  /** Developer runner resume: completed issuer rows are retained in its external report. */
  skipIssuers?: readonly string[];
}
export async function ingestQhpBatch(db: Database, kind: 'formulary' | 'providers', options: QhpBatchOptions) {
  const issuers = options.issuer ? [options.issuer] : (await db.query<{ issuer_id: string; files: number }>(`WITH latest AS (
    SELECT DISTINCT ON (issuer_id) issuer_id,discovery_id FROM qhp_index WHERE plan_year=$1 AND state=$2
    ORDER BY issuer_id,discovered_at DESC,qhp_index_id DESC)
    SELECT l.issuer_id,count(c.qhp_child_url_id)::int AS files FROM latest l
    JOIN qhp_index i ON i.issuer_id=l.issuer_id AND i.discovery_id=l.discovery_id
    LEFT JOIN qhp_child_url c USING(qhp_index_id) GROUP BY l.issuer_id ORDER BY files,l.issuer_id`,[options.year,options.state])).rows.map(r => r.issuer_id);
  const reports: Record<string,unknown>[] = [], notRun: string[] = [];
  for (const issuer of issuers) {
    if (options.skipIssuers?.includes(issuer)) continue;
    const scope = { issuer,year: options.year,state: options.state }, started = Date.now();
    if (options.signal?.aborted || options.deadline !== undefined && Date.now() >= options.deadline) {
      notRun.push(issuer);
      const source = `qhp-${kind === 'providers' ? 'provider' : 'formulary'}-${issuer}-${options.year}-${options.state}`;
      const id = `${source}:not-run:${randomUUID()}`;
      const expected = (await sourceSet(db,scope)).children.filter(c => c.kind === (kind === 'providers' ? 'provider_urls' : 'formulary_urls')).length;
      await db.transaction(async tx => {
        await tx.query(`INSERT INTO source(source_id,publisher,source_kind,issuer_scope)
          VALUES ($1,'QHP issuer publication','qhp',$2) ON CONFLICT DO NOTHING`,[source,JSON.stringify([issuer])]);
        await tx.query(`INSERT INTO snapshot(snapshot_id,source_id,validation_state) VALUES ($1,$2,'QUARANTINED')`,[id,source]);
        await tx.query(`INSERT INTO qhp_coverage_manifest(issuer_id,plan_year,state,kind,status,reason,snapshot_id,expected_children,complete_children)
          VALUES ($1,$2,$3,$4,'unknown','not_run_budget',$5,$6,0) ON CONFLICT(issuer_id,plan_year,state,kind)
          DO UPDATE SET status='unknown',reason='not_run_budget',snapshot_id=excluded.snapshot_id,
          expected_children=excluded.expected_children,complete_children=0,updated_at=now()`,
        [issuer,options.year,options.state,kind === 'providers' ? 'provider' : 'drug',id,expected]);
      });
      continue;
    }
    let report: Record<string,unknown>, expectedChildren = 0;
    try {
      expectedChildren = (await sourceSet(db,scope)).children.filter(c => c.kind === (kind === 'providers' ? 'provider_urls' : 'formulary_urls')).length;
      if (kind === 'formulary') await acquireQhpChildren(db,scope,'formulary_urls',options);
      const result = kind === 'providers' ? await ingestProviders(db,scope,options) : await importFormulary(db,scope,options);
      const set = await sourceSet(db,scope);
      const files = set.children.filter(c => c.kind === (kind === 'providers' ? 'provider_urls' : 'formulary_urls'));
      const bytes = files.reduce((total,file) => total+Number(file.compressed_bytes ?? 0),0);
      let pairs: string | undefined, pairsReason: string | undefined;
      if (kind === 'providers') {
        if (result.edges === 0) pairs = '0';
        else if (result.edges > 10_000_000) pairsReason = 'not_measured_large_source_set';
        else try {
          // Restrict source records before expanding a shared list; never scan unrelated issuers' lists.
          pairs = (await db.transaction(async tx => {
            await tx.exec("SET LOCAL statement_timeout='60s'");
            return tx.query<{ pairs: string }>(`SELECT count(DISTINCT (r.npi,p.base_hios_id))::text AS pairs
              FROM provider_shard s JOIN qhp_provider_record r USING(snapshot_id)
              CROSS JOIN LATERAL (SELECT p.base_hios_id FROM qhp_provider_plan_all p
                WHERE p.snapshot_id=r.snapshot_id AND p.record_id=r.record_id OFFSET 0) p
              WHERE s.source_set_id=$1 AND r.npi IS NOT NULL`,[result.snapshot_id]);
          })).rows[0]?.pairs;
        } catch { pairsReason = 'not_measured_query_failed'; }
      }
      const shards = (await db.query<{ child_id: string; status: string; reason: string | null; record_count: number; edge_count: number }>(`SELECT
        child_id::text,status,reason,record_count,edge_count FROM ${kind === 'providers' ? 'provider' : 'formulary'}_shard WHERE source_set_id=$1`,[result.snapshot_id])).rows;
      report = { ...result,kind,bytes,distinct_npi_plan_pairs: pairs === undefined ? undefined : Number(pairs),
        distinct_pairs_reason: pairsReason,files: files.map(f => ({ child_id: f.child_id,url_sha256: f.url_sha256,
        snapshot_id: f.snapshot_id,status: f.status,url: f.url,sha256: f.sha256,bytes: Number(f.compressed_bytes ?? 0),http_status: f.http_status,
        validation: shards.find(s => s.child_id === f.child_id) })),elapsed_ms: Date.now()-started };
    } catch {
      // Import exceptions roll back this issuer. Preserve previous ACTIVE and invalidate absence.
      const source = `qhp-${kind === 'providers' ? 'provider' : 'formulary'}-${issuer}-${options.year}-${options.state}`;
      const id = `${source}:failed:${randomUUID()}`;
      await db.transaction(async tx => {
        await tx.query(`INSERT INTO source(source_id,publisher,source_kind) VALUES ($1,'QHP issuer publication','qhp') ON CONFLICT DO NOTHING`,[source]);
        await tx.query(`INSERT INTO snapshot(snapshot_id,source_id,validation_state) VALUES ($1,$2,'QUARANTINED')`,[id,source]);
        await tx.query(`INSERT INTO qhp_coverage_manifest(issuer_id,plan_year,state,kind,status,reason,snapshot_id,expected_children,complete_children)
          VALUES ($1,$2,$3,$4,'failed','issuer_import_failed',$5,$6,0) ON CONFLICT(issuer_id,plan_year,state,kind)
          DO UPDATE SET status='failed',reason='issuer_import_failed',snapshot_id=excluded.snapshot_id,expected_children=excluded.expected_children,complete_children=0,updated_at=now()`,
        [issuer,options.year,options.state,kind === 'providers' ? 'provider' : 'drug',id,expectedChildren]);
        await tx.query(`INSERT INTO quality_issue(snapshot_id,severity,issue_code,explanation)
          VALUES ($1,'warning','issuer_import_failed','Issuer transaction failed; no partial source set was activated')`,[id]);
        await tx.query(`UPDATE data_availability SET ${kind === 'providers' ? 'provider_status' : 'formulary_status'}='unknown'
          WHERE issuer_id=$1 AND plan_year=$2 AND state=$3`,[issuer,options.year,options.state]);
      });
      report = { ...scope,kind,status: 'QUARANTINED',completeness: 'failed',reason: 'issuer_import_failed',expected_children: expectedChildren,complete_children: 0,elapsed_ms: Date.now()-started };
    }
    reports.push(report); await options.onReport?.(report);
  }
  return { year: options.year,state: options.state,kind,issuers: reports,not_run: notRun };
}
