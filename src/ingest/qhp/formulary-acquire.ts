import { homedir } from 'node:os';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { SqlSession } from '../../db/database.js';
import { checkedUrl, fetchToCache, FetchError } from '../../fetch/index.js';
import { httpsTransport } from '../../fetch/transport.js';
import type { Transport } from '../../fetch/index.js';
import type { FetchOptions, SnapshotMetadata } from '../../fetch/index.js';
import { saveDiscoverySnapshot } from './discover-repository.js';
import { sourceSet } from './formulary-repository.js';
import type { CachedChild, FormularyScope } from './formulary-repository.js';

export interface RunBudget { deadline?: number; signal?: AbortSignal }
export interface AcquisitionOptions extends RunBudget { fetcher?: typeof fetchToCache; fetchOptions?: Partial<FetchOptions>; childIds?: readonly string[] }
export function checkRunBudget(options: RunBudget) {
  if (options.signal?.aborted || options.deadline !== undefined && Date.now() >= options.deadline)
    throw new Error('run_budget_exceeded');
}
function budgetTransport(base: Transport, options: RunBudget): Transport {
  return async (url,context) => {
    checkRunBudget(options);
    const remaining = options.deadline === undefined ? Infinity : options.deadline-Date.now();
    const response = await base(url,{ ...context,connectTimeoutMs: Math.max(1,Math.min(context.connectTimeoutMs,remaining)) });
    const abort = () => { response.body.destroy(); };
    const timer = Number.isFinite(remaining) ? setTimeout(abort,Math.max(1,(options.deadline ?? 0)-Date.now())) : undefined;
    const cleanup = () => { clearTimeout(timer); options.signal?.removeEventListener('abort',abort); };
    response.body.once('close',cleanup); response.body.once('end',cleanup); response.body.once('error',cleanup);
    options.signal?.addEventListener('abort',abort,{ once: true });
    if (options.signal?.aborted || options.deadline !== undefined && Date.now() >= options.deadline) {
      abort(); cleanup(); throw new FetchError('read_timeout','Run budget expired');
    }
    return response;
  };
}
export const childFailureCodes = new Set(['run_budget_exceeded','too_large','html_error_page','access_denied','http_status','truncated',
  'invalid_json','read_timeout','connect_timeout','network_error','cache_error','host_not_allowed','https_required',
  'blocked_address','unsupported_encoding','dns_error','invalid_url','blocked_port','embedded_credentials',
  'too_many_redirects','invalid_redirect','snapshot_conflict']);

/** Reuse immutable, previously hashed QHP acquisitions. Query-bearing URLs require their
 * original URL hash in the source directory because provenance deliberately redacts queries. */
async function priorHash(dataDir: string, source: string, url: string): Promise<{ source: string; sha256: string } | undefined> {
  let names: string[];
  try { names = await readdir(join(dataDir,'raw')); } catch { return; }
  let newest: { source: string; sha256: string; fetched_at: string } | undefined;
  for (const name of [source,...names.filter(n => n.startsWith('qhp-') && n !== source)]) {
    let entries: string[];
    try { entries = await readdir(join(dataDir,'raw',name)); } catch { continue; }
    if (new URL(url).search && name !== source) continue;
    for (const entry of entries.filter(n => n.endsWith('.meta.json'))) {
      const meta = JSON.parse(await readFile(join(dataDir,'raw',name,entry),'utf8')) as SnapshotMetadata;
      if ((name === source || meta.url === url) && (!newest || meta.fetched_at > newest.fetched_at))
        newest = { source: name,sha256: meta.sha256,fetched_at: meta.fetched_at };
    }
  }
  return newest;
}

/** Acquire plan definitions and the requested kind; a failure belongs to one source set,
 * never to the batch. Shared URLs point to one immutable acquisition across issuers. */
export async function acquireQhpChildren(db: SqlSession, scope: FormularyScope,
  kind: 'formulary_urls' | 'provider_urls', options: AcquisitionOptions = {}) {
  const set = await sourceSet(db,scope);
  if (!set.children.some(c => c.kind === kind)) return;
  const dataDir = options.fetchOptions?.dataDir ?? process.env.OPENPLANS_DATA_DIR ?? join(homedir(), '.local', 'share', 'openplans');
  const maxBytes = options.fetchOptions?.maxBytes ?? 4 * 1024 ** 3;
  const children = set.children.filter(c => [kind,'plan_urls'].includes(c.kind)
    && (!options.childIds || options.childIds.includes(c.child_id)));
  async function acquire(child: CachedChild) {
    if (child.status === 'downloaded') {
      const size = (await db.query<{ compressed_bytes: string | null }>('SELECT compressed_bytes FROM snapshot WHERE snapshot_id=$1',[child.snapshot_id])).rows[0]?.compressed_bytes;
      if (size === null || size === undefined || Number(size) <= maxBytes) return;
      await db.query(`UPDATE qhp_child_url SET status='too_large',snapshot_id=NULL WHERE qhp_child_url_id=$1`,[child.child_id]);
      return;
    }
    const indexes = (await db.query<{ child_hosts: string[] }>(`SELECT i.child_hosts FROM qhp_child_url c
      JOIN qhp_index i USING(qhp_index_id) WHERE c.qhp_child_url_id=$1`,[child.child_id])).rows;
    const hosts = indexes.flatMap(i => i.child_hosts);
    try {
      checkRunBudget(options);
      // Even a reused acquisition must be authorized by this issuer's index.
      if (!options.fetcher) checkedUrl(child.url,hosts);
      const shared = (await db.query<{ snapshot_id: string; compressed_bytes: string | null }>(`SELECT c.snapshot_id,s.compressed_bytes FROM qhp_child_url c
        JOIN snapshot s ON s.snapshot_id=c.snapshot_id WHERE c.kind=$1 AND c.url_sha256=$2 AND c.status='downloaded'
        ORDER BY c.qhp_child_url_id DESC LIMIT 1`,[child.kind,child.url_sha256])).rows[0];
      if (shared?.compressed_bytes && Number(shared.compressed_bytes) > maxBytes) throw new FetchError('too_large','Cached child exceeds byte limit');
      let snapshot = shared?.snapshot_id;
      if (!snapshot) {
        const source = `qhp-child-${child.kind}-${child.url_sha256}`;
        const invalidJsonCache = ['truncated','invalid_json'].includes(child.status);
        const prior = options.fetcher || invalidJsonCache ? undefined : await priorHash(dataDir,source,child.url);
        const cached = await (options.fetcher ?? fetchToCache)(child.url,{ ...options.fetchOptions,
          transport: options.deadline !== undefined || options.signal ? budgetTransport(options.fetchOptions?.transport ?? httpsTransport,options) : options.fetchOptions?.transport,
          dataDir,source: prior?.source ?? source,allowHosts: hosts,expectedContent: 'json',
          expectedSha256: options.fetchOptions?.expectedSha256 ?? prior?.sha256,
          maxBytes,
          connectTimeoutMs: options.fetchOptions?.connectTimeoutMs ?? 30_000,
          readTimeoutMs: options.fetchOptions?.readTimeoutMs ?? 60_000 });
        if (cached.outcome === 'not_modified') throw new FetchError('cache_error','Unexpected conditional response');
        snapshot = `qhp-child:${child.kind}:${cached.metadata.sha256}`;
        await saveDiscoverySnapshot(db,source,snapshot,cached.metadata,cached.path,scope.issuer,
          [{ discovery_id: set.discovery,child_id: child.child_id }],'FETCHING',hosts);
      }
      await db.query(`UPDATE source SET issuer_scope=CASE WHEN issuer_scope @> $2::jsonb THEN issuer_scope
        ELSE issuer_scope || $2::jsonb END WHERE source_id=(SELECT source_id FROM snapshot WHERE snapshot_id=$1)`,
      [snapshot,JSON.stringify([scope.issuer])]);
      await db.query(`UPDATE qhp_child_url SET snapshot_id=$2,status='downloaded',http_status=200,publisher_metadata=publisher_metadata-'parse_failure'
        WHERE qhp_index_id IN (SELECT qhp_index_id FROM qhp_index WHERE discovery_id=$3 AND issuer_id=$4 AND plan_year=$5 AND state=$6)
        AND url_sha256=$1 AND kind=$7`,[child.url_sha256,snapshot,set.discovery,scope.issuer,scope.year,scope.state,child.kind]);
    } catch (error) {
      const reason = options.signal?.aborted || options.deadline !== undefined && Date.now() >= options.deadline
        ? 'run_budget_exceeded' : error instanceof FetchError ? error.code === 'http_status' && error.status === 403 ? 'access_denied' : error.code : 'child_not_cached';
      await db.query(`UPDATE qhp_child_url SET status=$2,http_status=$3,snapshot_id=NULL,
        publisher_metadata=publisher_metadata || $4::jsonb WHERE qhp_child_url_id=$1`,
      [child.child_id,reason,error instanceof FetchError ? error.status ?? null : null,
        JSON.stringify({ fetch_failure: reason,fetch_evidence: error instanceof FetchError ? error.evidence ?? null : null })]);
    }
  }
  // Bounded acquisition concurrency keeps national shard sets practical without buffering bodies.
  // Await every worker even if a database operation fails; no orphan writes leak into the next issuer.
  let next = 0;
  const results = await Promise.allSettled(Array.from({ length: Math.min(3,children.length) },async () => {
    while (next < children.length) await acquire(children[next++]!);
  }));
  if (results.some(r => r.status === 'rejected')) throw new Error('issuer_acquisition_failed');
}
export const acquireFormulary = (db: SqlSession, scope: FormularyScope, options?: AcquisitionOptions) =>
  acquireQhpChildren(db,scope,'formulary_urls',options);
