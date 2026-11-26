import {
  cmsFallbackUnavailable,
  disableCmsFallback,
  enableCmsFallback,
} from "../../config/cms-fallback.js";
import type { CmsFallbackFailure } from "../../config/cms-fallback.js";
import { readFile } from "node:fs/promises";
import type { SqlSession } from "../../db/database.js";
import {
  AdmissionSession,
  fetchToCache,
  FetchError,
  prepareFetch,
  shippedManifestPaths,
} from "../../fetch/index.js";
import { operatorManifest } from "../../config/access.js";
import { restrictCacheLevel } from "../../plugins/request-scope.js";
import type { FetchOptions } from "../../fetch/index.js";
import { dataDirectory } from "./sources.js";
import { cmsApiKey, cmsApiKeyConfigured } from "../../config/access.js";
import { saveFallbackSnapshot } from "./fallback-snapshot.js";
import { STATE_FIPS } from "./states.js";
import { CMS_API_SOURCE } from "@openplans/source-cms-marketplace-api";
import {
  declinedInScope,
  recordUpstream,
} from "../../plugins/upstream-scope.js";

const base = "https://marketplace.api.healthcare.gov/api/v1/counties/by/zip/";
const terms = "https://developer.cms.gov/marketplace-api/";
export interface CmsLookupOptions {
  /** False for prefix/bulk callers: they may use cached CMS answers but never make live calls. */
  allowCmsLive?: boolean;
  year?: number;
  dataDir?: string;
  fetchOptions?: Pick<FetchOptions, "lookup" | "transport">;
}
const SESSION_MAX_AGE_MS = 12 * 60 * 60 * 1000;
let held: { session: AdmissionSession; created: number } | undefined;

let warmFetchOptions: CmsLookupOptions["fetchOptions"];
/** Test seam: policy preparation uses this injected transport and so makes no real read. */
export function setCmsZipWarmFetchOptions(
  options: CmsLookupOptions["fetchOptions"],
): void {
  warmFetchOptions = options;
}

function zipAdmission(options: CmsLookupOptions): AdmissionSession | undefined {
  // Injected transports can run offline without publisher policy fixtures.
  if (options.fetchOptions?.transport) return undefined;
  const operator = operatorManifest();
  const paths = [...shippedManifestPaths(), ...(operator ? [operator] : [])];
  const current = held;
  if (
    current &&
    !current.session.isStopped &&
    current.session.manifestPaths.length === paths.length &&
    paths.every(
      (path, index) => path === current.session.manifestPaths[index],
    ) &&
    Date.now() - current.created < SESSION_MAX_AGE_MS
  )
    return current.session;
  held = {
    session: new AdmissionSession(paths, {
      maxRequests: 1000,
      maxTransferBytes: 128 * 1024 ** 2,
    }),
    created: Date.now(),
  };
  return held.session;
}

/** Prepare policy without spending a ZIP lookup or changing its cache. */
export async function warmCmsZipLookup(): Promise<void> {
  if (!cmsApiKeyConfigured()) return;
  const admission = zipAdmission({ fetchOptions: warmFetchOptions });
  if (!admission) return;
  await prepareFetch(base, {
    admission,
    source: "cms-marketplace-zip",
    allowHosts: ["marketplace.api.healthcare.gov"],
    expectedContent: "json",
    maxBytes: 256 * 1024,
    maxAttempts: 1,
    maxRedirects: 0,
    connectTimeoutMs: 3_000,
    readTimeoutMs: 3_000,
  });
}

export const CMS_POLICY_PREPARE_MS = 6_000;
/** A ZIP request waits this long at most for the shared policy attempt. Afterwards it
 * answers from loaded data and treats the CMS fallback as unavailable for that request;
 * the preparation itself keeps running for later requests. */
export const CMS_REQUEST_PREPARE_WAIT_MS = 250;
const RETRY_MIN_MS = 1_000;
const RETRY_MAX_MS = 60_000;
let preparation: Promise<boolean> | undefined;
let retry: ReturnType<typeof setTimeout> | undefined;
let retryDelay = RETRY_MIN_MS;
let retryAt = 0;
let stopped = false;
const inflight = new Set<Promise<void>>();

/** Startup and early requests share one bounded policy attempt. Readiness never waits. */
export function prepareCmsZipFallback(): Promise<boolean> {
  if (!cmsApiKeyConfigured() || stopped) return Promise.resolve(false);
  if (preparation) return preparation;
  if (Date.now() < retryAt) return Promise.resolve(false);
  clearTimeout(retry);
  preparation = prepareOptionalFallback().finally(() => {
    preparation = undefined;
  });
  return preparation;
}

/** Policy readiness within a request's bound. Pending, timed-out and failed preparation
 * all answer false quickly; a request never waits on the publisher behind this call. */
export async function cmsZipFallbackPrepared(
  waitMs = CMS_REQUEST_PREPARE_WAIT_MS,
): Promise<boolean> {
  const pending = prepareCmsZipFallback();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), waitMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Stop this process's retry timer and retire its policy session during shutdown. */
export function stopCmsZipPreparation(): void {
  stopped = true;
  clearTimeout(retry);
  held?.session.stop();
}

/** Resolves once every policy attempt this process started has settled, however it ended. */
export async function cmsZipPreparationSettled(): Promise<void> {
  await Promise.all(inflight);
}

async function prepareOptionalFallback(): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let reason: CmsFallbackFailure = "policy_failed";
  const work = warmCmsZipLookup();
  // A retired attempt may still be writing its policy cache; shutdown and tests can wait for it.
  const settled: Promise<void> = work
    .then(
      () => undefined,
      () => undefined,
    )
    .finally(() => {
      inflight.delete(settled);
    });
  inflight.add(settled);
  const session = held?.session;
  try {
    await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reason = "policy_timeout";
          reject(new Error("CMS policy preparation timed out"));
        }, CMS_POLICY_PREPARE_MS);
      }),
    ]);
    if (stopped) return false;
    retryAt = 0;
    retryDelay = RETRY_MIN_MS;
    enableCmsFallback();
    return true;
  } catch (error) {
    session?.stop();
    // Network failures and timeouts do not withdraw configured or stored sources.
    if (error instanceof FetchError && error.code === "admission_denied")
      disableCmsFallback("policy_failed");
    if (!stopped) {
      console.warn(
        JSON.stringify({ event: "cms_policy_preparation_failed", reason }),
      );
      retryAt = Date.now() + retryDelay;
      retry = setTimeout(() => {
        void prepareCmsZipFallback();
      }, retryDelay);
      retry.unref();
      retryDelay = Math.min(retryDelay * 2, RETRY_MAX_MS);
    }
    return false;
  } finally {
    clearTimeout(timer);
  }
}

interface Lookup extends Record<string, unknown> {
  snapshot_id: string | null;
  outcome: string;
  fresh: boolean;
}
/** The documented credential is a query parameter, not a custom header. fetchToCache
 * redacts query values; neither database provenance nor errors receive the request URL. */
export async function cmsCountySnapshot(
  db: SqlSession,
  zip: string,
  options: CmsLookupOptions = {},
): Promise<string | null> {
  const key = cmsApiKey();
  if (!key || cmsFallbackUnavailable()) return null;
  // A caller that declined pass-through asks nothing upstream and reads no stored CMS answer.
  if (declinedInScope()) return null;
  const year = options.year ?? new Date().getUTCFullYear();
  if (
    !/^\d{5}$/.test(zip) ||
    !Number.isInteger(year) ||
    year < 2014 ||
    year > 9999
  )
    throw new TypeError("Invalid CMS ZIP/year");
  const cached = (
    await db.query<Lookup>(
      `SELECT snapshot_id,outcome,expires_at>now() AS fresh
    FROM cms_zip_lookup WHERE zip=$1 AND plan_year=$2`,
      [zip, year],
    )
  ).rows[0];
  if (cmsFallbackUnavailable()) return null;
  if (cached?.fresh) {
    if (cached.outcome !== "available") return null;
    // The county list comes from the CMS API, live or stored: disclosed like every pass-through source.
    recordUpstream([CMS_API_SOURCE]);
    return cached.snapshot_id;
  }
  if (options.allowCmsLive === false) return null;
  // Read-only request scopes cannot reserve budget or record the attempt. Serve cached rows only.
  const mode = (
    await db.query<{ read_only: string }>(
      "SELECT current_setting('transaction_read_only') AS read_only",
    )
  ).rows[0];
  if (mode?.read_only === "on") return null;
  // A cold request answers from loaded data while preparation is pending or failed.
  if (!options.fetchOptions?.transport && !(await cmsZipFallbackPrepared())) {
    // That answer omits a configured source, so no shared cache may keep it.
    restrictCacheLevel("request");
    return null;
  }
  // Atomic persistent reservation, shared by all processes. Never queue a batch behind this limiter.
  const reserved = await db.query(`UPDATE cms_zip_budget SET
    daily_requests=CASE WHEN day_start<(now() AT TIME ZONE 'UTC')::date THEN 1 ELSE daily_requests+1 END,
    day_start=(now() AT TIME ZONE 'UTC')::date,next_request_at=now()+min_interval_ms*interval '1 millisecond'
    WHERE singleton AND next_request_at<=now() AND blocked_until<=now()
      AND (day_start<(now() AT TIME ZONE 'UTC')::date OR daily_requests<max_daily_requests) RETURNING singleton`);
  if (!reserved.rows.length) return null;
  // Disclosed before the fetch: a call that fails or is refused upstream was still made.
  recordUpstream([CMS_API_SOURCE]);
  const safeUrl = `${base}${zip}?year=${year}`;
  const url = new URL(safeUrl);
  url.searchParams.set("apikey", key);
  let snapshot: string | null = null,
    outcome = "failed",
    httpStatus: number | null = null,
    code: string | null = null;
  let ttlSeconds = 300;
  try {
    const result = await fetchToCache(url.href, {
      ...options.fetchOptions,
      admission: zipAdmission(options),
      source: "cms-marketplace-zip",
      allowHosts: ["marketplace.api.healthcare.gov"],
      expectedContent: "json",
      dataDir: options.dataDir ?? dataDirectory(),
      maxBytes: 256 * 1024,
      maxDecompressedBytes: 256 * 1024,
      maxAttempts: 1,
      maxRedirects: 0,
      connectTimeoutMs: 3_000,
      readTimeoutMs: 3_000,
    });
    if (cmsFallbackUnavailable()) return null;
    if (result.outcome === "not_modified") throw new Error("Missing CMS body");
    httpStatus = result.metadata.status;
    const body: unknown = JSON.parse(await readFile(result.path, "utf8"));
    if (
      !body ||
      typeof body !== "object" ||
      !("counties" in body) ||
      !Array.isArray(body.counties) ||
      body.counties.length > 100
    )
      throw new Error("Invalid CMS counties");
    const counties = body.counties.map((value: unknown) => {
      if (!value || typeof value !== "object")
        throw new Error("Invalid CMS county");
      const row = value as Record<string, unknown>;
      if (
        row.zipcode !== zip ||
        typeof row.fips !== "string" ||
        !/^\d{5}$/.test(row.fips) ||
        typeof row.state !== "string" ||
        !STATE_FIPS[row.state] ||
        !row.fips.startsWith(STATE_FIPS[row.state]!) ||
        typeof row.name !== "string" ||
        !row.name.trim() ||
        row.name.length > 200 ||
        row.name.includes(key)
      )
        throw new Error("Invalid CMS county");
      return { fips: row.fips, name: row.name, state: row.state };
    });
    const id = `cms-marketplace-zip:${zip}:${year}:${result.metadata.sha256}`;
    // Raw bytes may deduplicate to an older request/year; this snapshot describes this live retrieval.
    snapshot = await saveFallbackSnapshot(
      db,
      {
        path: result.path,
        metadata: { ...result.metadata, fetched_at: new Date().toISOString() },
      },
      "Centers for Medicare & Medicaid Services",
      safeUrl,
      terms,
      id,
    );
    for (let i = 0; i < counties.length; i++) {
      const county = counties[i]!;
      await db.query(
        `INSERT INTO zip_county_fallback(source,zip,county_fips,county_name,state,snapshot_id,source_row)
        VALUES('cms_marketplace',$1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
        [zip, county.fips, county.name, county.state, snapshot, i + 1],
      );
    }
    outcome = counties.length ? "available" : "empty";
    ttlSeconds = counties.length ? 86400 : 3600;
  } catch (error) {
    if (error instanceof FetchError && error.code === "admission_denied") {
      disableCmsFallback("policy_failed");
      void prepareCmsZipFallback();
    }
    if (cmsFallbackUnavailable()) return null;
    // Persist only controlled codes/status; error messages/bodies/URLs can contain credentials.
    snapshot = null;
    code = error instanceof FetchError ? error.code : "invalid_response";
    if (error instanceof FetchError) httpStatus = error.status ?? null;
    if (httpStatus === 401 || httpStatus === 403 || httpStatus === 429) {
      const retry =
        error instanceof FetchError
          ? error.evidence?.response_headers["retry-after"]
          : undefined;
      let seconds;
      if (retry && /^\d+$/.test(retry)) {
        seconds = Number(retry);
      } else if (retry) {
        seconds = Math.ceil((Date.parse(retry) - Date.now()) / 1000);
      } else {
        seconds = 0;
      }
      ttlSeconds = Math.max(3600, Number.isFinite(seconds) ? seconds : 0);
      await db.query(
        `UPDATE cms_zip_budget SET blocked_until=GREATEST(blocked_until,now()+$1*interval '1 second') WHERE singleton`,
        [ttlSeconds],
      );
    }
  }
  await db.query(
    `INSERT INTO cms_zip_attempt(zip,plan_year,snapshot_id,outcome,http_status,failure_code,requested_url)
    VALUES($1,$2,$3,$4,$5,$6,$7)`,
    [zip, year, snapshot, outcome, httpStatus, code, safeUrl],
  );
  await db.query(
    `INSERT INTO cms_zip_lookup(zip,plan_year,snapshot_id,outcome,http_status,failure_code,requested_url,fetched_at,expires_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,now(),now()+$8*interval '1 second')
    ON CONFLICT(zip,plan_year) DO UPDATE SET snapshot_id=EXCLUDED.snapshot_id,outcome=EXCLUDED.outcome,
      http_status=EXCLUDED.http_status,failure_code=EXCLUDED.failure_code,requested_url=EXCLUDED.requested_url,
      fetched_at=EXCLUDED.fetched_at,expires_at=EXCLUDED.expires_at`,
    [zip, year, snapshot, outcome, httpStatus, code, safeUrl, ttlSeconds],
  );
  return !cmsFallbackUnavailable() && outcome === "available" ? snapshot : null;
}
