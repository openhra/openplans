import { readFile } from 'node:fs/promises';
import type { SqlSession } from '../../db/database.js';
import { fetchToCache, FetchError } from '../../fetch/index.js';
import type { FetchOptions } from '../../fetch/index.js';
import { dataDirectory } from './sources.js';
import { saveFallbackSnapshot } from './fallback-snapshot.js';
import { STATE_FIPS } from './states.js';

const base = 'https://marketplace.api.healthcare.gov/api/v1/counties/by/zip/';
const terms = 'https://developer.cms.gov/marketplace-api/';
export interface CmsLookupOptions {
  /** False for prefix/bulk callers: they may use cached CMS answers but never make live calls. */
  allowCmsLive?: boolean;
  year?: number;
  dataDir?: string;
  fetchOptions?: Pick<FetchOptions, 'lookup' | 'transport'>;
}
interface Lookup extends Record<string, unknown> { snapshot_id: string | null; outcome: string; fresh: boolean }
/** The documented credential is a query parameter, not a custom header. fetchToCache
 * redacts query values; neither database provenance nor errors receive the request URL. */
export async function cmsCountySnapshot(db: SqlSession, zip: string, options: CmsLookupOptions = {}): Promise<string | null> {
  const key = process.env.CMS_API_KEY;
  if (!key) return null;
  const year = options.year ?? new Date().getUTCFullYear();
  if (!/^\d{5}$/.test(zip) || !Number.isInteger(year) || year < 2014 || year > 9999) throw new TypeError('Invalid CMS ZIP/year');
  const cached = (await db.query<Lookup>(`SELECT snapshot_id,outcome,expires_at>now() AS fresh
    FROM cms_zip_lookup WHERE zip=$1 AND plan_year=$2`,[zip,year])).rows[0];
  if (cached?.fresh) return cached.outcome === 'available' ? cached.snapshot_id : null;
  if (options.allowCmsLive === false) return null;
  // Atomic persistent reservation, shared by all processes. Never queue a batch behind this limiter.
  const reserved = await db.query(`UPDATE cms_zip_budget SET
    daily_requests=CASE WHEN day_start<(now() AT TIME ZONE 'UTC')::date THEN 1 ELSE daily_requests+1 END,
    day_start=(now() AT TIME ZONE 'UTC')::date,next_request_at=now()+min_interval_ms*interval '1 millisecond'
    WHERE singleton AND next_request_at<=now() AND blocked_until<=now()
      AND (day_start<(now() AT TIME ZONE 'UTC')::date OR daily_requests<max_daily_requests) RETURNING singleton`);
  if (!reserved.rows.length) return null;
  const safeUrl = `${base}${zip}?year=${year}`;
  const url = new URL(safeUrl); url.searchParams.set('apikey',key);
  let snapshot: string | null = null, outcome = 'failed', httpStatus: number | null = null, code: string | null = null;
  let ttlSeconds = 300;
  try {
    const result = await fetchToCache(url.href, { ...options.fetchOptions,
      source: 'cms-marketplace-zip', allowHosts: ['marketplace.api.healthcare.gov'], expectedContent: 'json',
      dataDir: options.dataDir ?? dataDirectory(), maxBytes: 256 * 1024, maxDecompressedBytes: 256 * 1024,
      maxAttempts: 1, maxRedirects: 0, connectTimeoutMs: 3_000, readTimeoutMs: 3_000,
    });
    if (result.outcome === 'not_modified') throw new Error('Missing CMS body');
    httpStatus = result.metadata.status;
    const body: unknown = JSON.parse(await readFile(result.path,'utf8'));
    if (!body || typeof body !== 'object' || !('counties' in body) || !Array.isArray(body.counties)
      || body.counties.length > 100) throw new Error('Invalid CMS counties');
    const counties = body.counties.map((value: unknown) => {
      if (!value || typeof value !== 'object') throw new Error('Invalid CMS county');
      const row = value as Record<string,unknown>;
      if (row.zipcode !== zip || typeof row.fips !== 'string' || !/^\d{5}$/.test(row.fips)
        || typeof row.state !== 'string' || !STATE_FIPS[row.state] || !row.fips.startsWith(STATE_FIPS[row.state]!)
        || typeof row.name !== 'string' || !row.name.trim() || row.name.length > 200 || row.name.includes(key)) throw new Error('Invalid CMS county');
      return { fips: row.fips, name: row.name, state: row.state };
    });
    const id = `cms-marketplace-zip:${zip}:${year}:${result.metadata.sha256}`;
    // Raw bytes may deduplicate to an older request/year; this snapshot describes this live retrieval.
    snapshot = await saveFallbackSnapshot(db,{ path: result.path,
      metadata: { ...result.metadata, fetched_at: new Date().toISOString() } },
      'Centers for Medicare & Medicaid Services',safeUrl,terms,id);
    for (let i=0;i<counties.length;i++) {
      const county = counties[i]!;
      await db.query(`INSERT INTO zip_county_fallback(source,zip,county_fips,county_name,state,snapshot_id,source_row)
        VALUES('cms_marketplace',$1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,[zip,county.fips,county.name,county.state,snapshot,i+1]);
    }
    outcome = counties.length ? 'available' : 'empty'; ttlSeconds = counties.length ? 86400 : 3600;
  } catch (error) {
    // Persist only controlled codes/status; error messages/bodies/URLs can contain credentials.
    snapshot = null;
    code = error instanceof FetchError ? error.code : 'invalid_response';
    if (error instanceof FetchError) httpStatus = error.status ?? null;
    if (httpStatus === 401 || httpStatus === 403 || httpStatus === 429) {
      const retry = error instanceof FetchError ? error.evidence?.response_headers['retry-after'] : undefined;
      const seconds = retry && /^\d+$/.test(retry) ? Number(retry) : retry ? Math.ceil((Date.parse(retry)-Date.now())/1000) : 0;
      ttlSeconds = Math.max(3600,Number.isFinite(seconds) ? seconds : 0);
      await db.query(`UPDATE cms_zip_budget SET blocked_until=GREATEST(blocked_until,now()+$1*interval '1 second') WHERE singleton`,[ttlSeconds]);
    }
  }
  await db.query(`INSERT INTO cms_zip_attempt(zip,plan_year,snapshot_id,outcome,http_status,failure_code,requested_url)
    VALUES($1,$2,$3,$4,$5,$6,$7)`,[zip,year,snapshot,outcome,httpStatus,code,safeUrl]);
  await db.query(`INSERT INTO cms_zip_lookup(zip,plan_year,snapshot_id,outcome,http_status,failure_code,requested_url,fetched_at,expires_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,now(),now()+$8*interval '1 second')
    ON CONFLICT(zip,plan_year) DO UPDATE SET snapshot_id=EXCLUDED.snapshot_id,outcome=EXCLUDED.outcome,
      http_status=EXCLUDED.http_status,failure_code=EXCLUDED.failure_code,requested_url=EXCLUDED.requested_url,
      fetched_at=EXCLUDED.fetched_at,expires_at=EXCLUDED.expires_at`,[zip,year,snapshot,outcome,httpStatus,code,safeUrl,ttlSeconds]);
  return outcome === 'available' ? snapshot : null;
}
