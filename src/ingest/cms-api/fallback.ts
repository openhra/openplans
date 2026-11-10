import { createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { dirname } from "node:path";
import type { SqlSession } from "../../db/database.js";
import {
  AdmissionSession,
  FetchError,
  cmsFallbackEnabled,
  fetchToCache,
  shippedManifestPaths,
} from "../../fetch/index.js";
import type { FetchOptions } from "../../fetch/index.js";
import { parse_hios } from "../../domain/hios/index.js";
import type { DrugCoverage } from "../../domain/drugs/index.js";
import type { ProviderParticipation } from "../../domain/providers/index.js";

/**
 * Coverage fallback to the CMS Marketplace API, off unless `OPENPLANS_CMS_FALLBACK=on`.
 *
 * Runs after the answer from loaded files, and only for pairs that answer is `unknown` for a
 * reason that means "not sourced yet". It never touches issuer or PUF tables: API answers go to
 * their own tables, and loaded files always win because they are read first.
 */
export const CMS_API_SOURCE = "cms-marketplace-api";
const host = "marketplace.api.healthcare.gov";
const base = `https://${host}/api/v1/`;
const termsUrl = "https://developer.cms.gov/marketplace-api/";
const attribution =
  "Centers for Medicare & Medicaid Services, Marketplace API (HealthCare.gov)";
/** Reasons that mean OpenPlans has not sourced the issuer's files; nothing else opens a call. */
export const OPENING_REASONS: readonly string[] = [
  "source_set_not_available",
  "source_access_denied",
  "source_set_not_validated",
  "source_set_not_active",
];
/** Plan years the reviewed manifest entry covers. */
const servedYears = [2025, 2026, 2027];
const maxPlansPerCall = 10;
const maxIdsPerCall = 10;

export type CmsKind = "drug" | "provider";
type Endpoint = "drugs/covered" | "providers/covered";
const endpointOf = (kind: CmsKind): Endpoint =>
  kind === "drug" ? "drugs/covered" : "providers/covered";

export interface CmsApiEvidence {
  coverage: string;
  generic_rxcui?: string | null;
  accepting?: string | null;
  snapshot_id: string;
  sourced_by: typeof CMS_API_SOURCE;
  sourced_at: string;
  sourced_slug: string;
  served_from: "live" | "absorbed" | "absorbed_stale";
  /** Quote provenance label, derived from served_from. */
  freshness?: "fresh" | "stale" | "refetched";
  source: string;
  terms_url: string;
  limits: string;
}
/**
 * One per inbound request. Without `writer` (read-only request scopes such as MCP tools) only
 * rows absorbed earlier are served: no live call, no write.
 */
export interface CmsFallbackContext {
  reader: SqlSession;
  writer?: SqlSession;
  /** Live calls left for this inbound request (default 2). */
  remaining: number;
  /**
   * The inbound client, as the API rate limiter names it. One client may use at most a tenth
   * of the daily allowance. Held in memory only and never stored.
   */
  client?: string;
  /** Trusted test injection only. */
  fetchOptions?: Pick<FetchOptions, "transport" | "lookup" | "dataDir">;
  admission?: AdmissionSession;
}
export function cmsFallbackContext(
  reader: SqlSession,
  writer: SqlSession | undefined,
  overrides: Partial<CmsFallbackContext> = {},
): CmsFallbackContext | undefined {
  if (!cmsFallbackEnabled()) return undefined;
  return { reader, writer, remaining: 2, ...overrides };
}

type Answer = DrugCoverage | ProviderParticipation;
interface Pair {
  index: number;
  plan: string;
  id: string;
  year: number;
}
interface AbsorbedRow extends Record<string, unknown> {
  plan_id: string;
  identity: string;
  coverage: string;
  generic_rxcui: string | null;
  accepting: string | null;
  snapshot_id: string;
  sourced_by: string;
  sourced_at: string | Date;
  sourced_slug: string;
  fresh: boolean;
}

const identityOf = (kind: CmsKind, answer: Answer) =>
  kind === "drug"
    ? (answer as DrugCoverage).rxcui
    : (answer as ProviderParticipation).identity;
const limits = (kind: CmsKind) =>
  kind === "drug"
    ? "coverage flag only; tier, prior authorization, step therapy, quantity limit and cost are not published by this source"
    : "coverage flag only; network tier and address participation are not published by this source";

function eligible(kind: CmsKind, answer: Answer): boolean {
  if (
    answer.status !== "unknown" ||
    !OPENING_REASONS.includes(answer.reason ?? "")
  )
    return false;
  return kind === "drug" || /^\d{10}$/.test(identityOf(kind, answer));
}

let shared: { session: AdmissionSession; created: number } | undefined;
/** One long-lived session per process, replaced daily or after any stop. */
function admission(): AdmissionSession {
  if (
    !shared ||
    shared.session.isStopped ||
    Date.now() - shared.created > 12 * 60 * 60 * 1000
  )
    shared = {
      session: new AdmissionSession(shippedManifestPaths(), {
        maxRequests: 1000,
        maxTransferBytes: 128 * 1024 ** 2,
      }),
      created: Date.now(),
    };
  return shared.session;
}

function evidenceFrom(
  kind: CmsKind,
  row: AbsorbedRow,
  served: CmsApiEvidence["served_from"],
): CmsApiEvidence {
  return {
    coverage: row.coverage,
    ...(kind === "drug"
      ? { generic_rxcui: row.generic_rxcui ?? null }
      : { accepting: row.accepting ?? null }),
    snapshot_id: row.snapshot_id,
    sourced_by: CMS_API_SOURCE,
    sourced_at: new Date(row.sourced_at).toISOString(),
    sourced_slug: row.sourced_slug,
    served_from: served,
    source: attribution,
    terms_url: termsUrl,
    limits: limits(kind),
  };
}

function withEvidence<T extends Answer>(
  kind: CmsKind,
  answer: T,
  evidence: CmsApiEvidence,
): T {
  const covered = ["Covered", "GenericCovered"].includes(evidence.coverage);
  if (
    evidence.coverage === "DataNotProvided" ||
    !["Covered", "GenericCovered", "NotCovered"].includes(evidence.coverage)
  )
    return {
      ...answer,
      reason: "cms_api_data_not_provided",
      cms_api: evidence,
    };
  const statuses = {
    drug: ["listed_covered", "explicitly_not_covered"],
    provider: ["listed_participating", "explicitly_not_participating"],
  } as const;
  const status = statuses[kind][covered ? 0 : 1];
  return { ...answer, status, reason: null, covered, cms_api: evidence };
}

async function absorbed(
  db: SqlSession,
  kind: CmsKind,
  pairs: Pair[],
): Promise<Map<string, AbsorbedRow>> {
  const found = new Map<string, AbsorbedRow>();
  if (!pairs.length) return found;
  const table =
    kind === "drug" ? "cms_api_drug_coverage" : "cms_api_provider_coverage";
  const column = kind === "drug" ? "rxcui" : "npi";
  const extra =
    kind === "drug"
      ? "generic_rxcui, NULL::text AS accepting"
      : "NULL::text AS generic_rxcui, accepting";
  const rows = (
    await db.query<AbsorbedRow>(
      `SELECT plan_id, ${column} AS identity, plan_year, coverage, ${extra}, snapshot_id,
        c.sourced_by, c.sourced_at, c.sourced_slug, (c.expired_at IS NULL OR c.expired_at > now()) AS fresh
      FROM ${table} c JOIN record_policy p ON p.name=c.record_policy
      WHERE (plan_id, ${column}, plan_year) IN (
        SELECT * FROM unnest($1::text[], $2::text[], $3::int[]))
        AND (c.expired_at IS NULL OR c.expired_at + p.stale_window > now())
        AND c.sourced_by = '${CMS_API_SOURCE}'`,
      [
        pairs.map((p) => p.plan),
        pairs.map((p) => p.id),
        pairs.map((p) => p.year),
      ],
    )
  ).rows;
  for (const row of rows)
    found.set(`${row.plan_id}|${row.identity}|${row.plan_year}`, row);
  return found;
}
const keyOf = (pair: { plan: string; id: string; year: number }) =>
  `${pair.plan}|${pair.id}|${pair.year}`;

async function attempt(
  db: SqlSession,
  endpoint: Endpoint,
  year: number,
  pairs: number,
  outcome: "absorbed" | "empty" | "failed" | "refused",
  extra: {
    snapshot?: string | null;
    status?: number | null;
    failure?: string | null;
    refusal?: string | null;
    latency?: number | null;
  } = {},
): Promise<void> {
  await db.query(
    `INSERT INTO cms_api_attempt(endpoint,plan_year,pairs,snapshot_id,outcome,http_status,failure_code,refusal_reason,latency_ms)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      endpoint,
      year,
      pairs,
      extra.snapshot ?? null,
      outcome,
      extra.status ?? null,
      extra.failure ?? null,
      extra.refusal ?? null,
      extra.latency ?? null,
    ],
  );
}

/** Share of the daily allowance one inbound client may use. */
export const CLIENT_SHARE = 0.1;
const maxClients = 10_000;
const clientCalls = { day: "", counts: new Map<string, number>() };
/** Per-process, per-UTC-day call counts by client. Past `maxClients`, new clients share one count. */
function clientCount(client: string): { key: string; count: number } {
  const day = new Date().toISOString().slice(0, 10);
  if (clientCalls.day !== day) {
    clientCalls.day = day;
    clientCalls.counts.clear();
  }
  const key =
    clientCalls.counts.has(client) || clientCalls.counts.size < maxClients
      ? client
      : "";
  return { key, count: clientCalls.counts.get(key) ?? 0 };
}
/** Test hook: forgets every client's count. */
export function resetCmsClientCounts(): void {
  clientCalls.counts.clear();
}
async function clientAllowance(db: SqlSession): Promise<number> {
  const row = (
    await db.query<{ max_daily_requests: number }>(
      "SELECT max_daily_requests FROM cms_api_budget WHERE singleton",
    )
  ).rows[0];
  return Math.max(1, Math.floor((row?.max_daily_requests ?? 0) * CLIENT_SHARE));
}

/**
 * Atomic reservation on the shared budget row: spacing, daily cap and breaker in one UPDATE.
 * After a pause for server-side failures the first reservation is the trial call. It blocks
 * every other caller for another fifteen minutes until its own result is known.
 */
async function reserve(db: SqlSession): Promise<"ok" | "budget" | "blocked"> {
  const reserved = await db.query(`UPDATE cms_api_budget SET
    daily_requests=CASE WHEN day_start<(now() AT TIME ZONE 'UTC')::date THEN 1 ELSE daily_requests+1 END,
    day_start=(now() AT TIME ZONE 'UTC')::date,next_request_at=now()+min_interval_ms*interval '1 millisecond',
    blocked_until=CASE WHEN half_open THEN now()+interval '15 minutes' ELSE blocked_until END
    WHERE singleton AND next_request_at<=now() AND blocked_until<=now()
      AND (day_start<(now() AT TIME ZONE 'UTC')::date OR daily_requests<max_daily_requests) RETURNING singleton`);
  if (reserved.rows.length) return "ok";
  const blocked = await db.query(
    "SELECT 1 FROM cms_api_budget WHERE singleton AND blocked_until>now()",
  );
  return blocked.rows.length ? "blocked" : "budget";
}

const windowOver = "failure_window_start<now()-interval '5 minutes'";
const failures = `(CASE WHEN ${windowOver} THEN 1 ELSE failure_count+1 END)`;

/**
 * States and years whose active catalog comes from a state-based exchange bundle. The CMS API
 * answers only for plans sold through HealthCare.gov and rejects these, so no call is spent.
 */
async function stateExchangeYears(
  db: SqlSession,
  pairs: Pair[],
): Promise<Set<string>> {
  if (!pairs.length) return new Set();
  const rows = (
    await db.query<{ state: string; plan_year: number }>(
      `SELECT a.state,a.plan_year FROM puf_active_catalog a
      JOIN sbe_catalog s ON s.import_id=a.import_id WHERE a.state=ANY($1::text[])`,
      [[...new Set(pairs.map((p) => p.plan.slice(5, 7)))]],
    )
  ).rows;
  return new Set(rows.map((row) => `${row.state}|${row.plan_year}`));
}

const coverageEnum = {
  drug: ["Covered", "NotCovered", "GenericCovered", "DataNotProvided"],
  provider: ["Covered", "NotCovered", "DataNotProvided"],
};
interface ParsedRow {
  plan_id: string;
  identity: string;
  coverage: string;
  generic_rxcui: string | null;
  accepting: string | null;
  addresses: unknown[];
}
function parseBody(kind: CmsKind, text: string): ParsedRow[] {
  const body = JSON.parse(text) as { coverage?: unknown };
  if (!body || !Array.isArray(body.coverage)) throw new Error("invalid body");
  return body.coverage.map((value: unknown) => {
    const r = value as Record<string, unknown>;
    const identity = kind === "drug" ? r.rxcui : r.npi;
    if (
      typeof r.plan_id !== "string" ||
      !/^\d{5}[A-Z]{2}\d{7}$/.test(r.plan_id) ||
      typeof identity !== "string" ||
      !(kind === "drug" ? /^\d{1,20}$/ : /^\d{10}$/).test(identity) ||
      typeof r.coverage !== "string" ||
      !coverageEnum[kind].includes(r.coverage)
    )
      throw new Error("invalid row");
    return {
      plan_id: r.plan_id,
      identity,
      coverage: r.coverage,
      generic_rxcui:
        typeof r.generic_rxcui === "string" &&
        /^\d{1,20}$/.test(r.generic_rxcui)
          ? r.generic_rxcui
          : null,
      accepting:
        typeof r.accepting === "string" ? r.accepting.slice(0, 40) : null,
      addresses: Array.isArray(r.addresses) ? r.addresses.slice(0, 20) : [],
    };
  });
}

const sha = (value: string) => createHash("sha256").update(value).digest("hex");

/** One live call for up to 10 plans x 10 ids. Returns the absorbed rows' keys, or a refusal reason. */
async function liveCall(
  context: CmsFallbackContext,
  db: SqlSession,
  kind: CmsKind,
  year: number,
  plans: string[],
  ids: string[],
): Promise<string | null> {
  const endpoint = endpointOf(kind);
  const pairs = plans.length * ids.length;
  const client =
    context.client === undefined ? undefined : clientCount(context.client);
  if (client && client.count >= (await clientAllowance(db))) {
    await attempt(db, endpoint, year, pairs, "refused", {
      refusal: "cms_api_client_share",
    });
    return "cms_api_request_cap";
  }
  const reservation = await reserve(db);
  if (reservation !== "ok") {
    const reason =
      reservation === "blocked"
        ? "cms_api_unavailable"
        : "cms_api_budget_exhausted";
    await attempt(db, endpoint, year, pairs, "refused", { refusal: reason });
    return reason;
  }
  context.remaining--;
  if (client) clientCalls.counts.set(client.key, client.count + 1);
  const url = new URL(`${base}${endpoint}`);
  url.searchParams.set("year", String(year));
  url.searchParams.set(
    kind === "drug" ? "drugs" : "providerids",
    ids.join(","),
  );
  url.searchParams.set("planids", plans.join(","));
  const started = Date.now();
  const params = sha(
    JSON.stringify([year, [...plans].sort(), [...ids].sort()]),
  ).slice(0, 16);
  let status: number | null = null;
  try {
    const result = await fetchToCache(url.href, {
      ...context.fetchOptions,
      admission: context.fetchOptions?.transport
        ? context.admission
        : (context.admission ?? admission()),
      // One cache directory per question: identical bytes answering another question are
      // stored again rather than reused under that question's URL.
      source: `${CMS_API_SOURCE}-${params}`,
      allowHosts: [host],
      expectedContent: "json",
      maxBytes: 1024 ** 2,
      maxDecompressedBytes: 1024 ** 2,
      maxAttempts: 1,
      maxRedirects: 0,
      connectTimeoutMs: 3_000,
      readTimeoutMs: 3_000,
    });
    if (result.outcome === "not_modified") throw new Error("no body");
    status = result.metadata.status;
    const text = await readFile(result.path, "utf8");
    const key = process.env.CMS_API_KEY;
    if (key && text.includes(key)) {
      // A body that echoes the key is never stored or parsed.
      await rm(dirname(result.path), { recursive: true, force: true });
      await rm(result.metadataPath, { force: true });
      await attempt(db, endpoint, year, pairs, "failed", {
        status,
        failure: "body_rejected",
        latency: Date.now() - started,
      });
      return "cms_api_unavailable";
    }
    const rows = parseBody(kind, text);
    // The cache reuses identical bytes after a successful download. This receipt records
    // the new observation, rather than inheriting the first download's time.
    const retrievedAt = new Date().toISOString();
    const snapshot = `${CMS_API_SOURCE}:${endpoint.replace("/", "-")}:${year}:${params}:${result.metadata.sha256.slice(0, 16)}:${sha(retrievedAt).slice(0, 16)}`;
    await db.query(
      `INSERT INTO snapshot(snapshot_id,source_id,requested_url,final_url,redirect_chain,
      retrieved_at,http_status,content_type,compressed_bytes,sha256,raw_path,schema_version,parser_version,
      terms_review_reference,expected_children,fetched_children,validation_state,activated_at)
      VALUES($1,$2,$3,$3,'[]',$4,$5,$6,$7,$8,$9,'cms-api-coverage-v1','cms-api-fallback-v1',$10,0,0,'ACTIVE',now())
      ON CONFLICT DO NOTHING`,
      [
        snapshot,
        CMS_API_SOURCE,
        result.metadata.url,
        retrievedAt,
        status,
        result.metadata.content_type,
        result.metadata.bytes,
        result.metadata.sha256,
        result.path,
        termsUrl,
      ],
    );
    const retrieved = (
      await db.query<{ retrieved_at: string | Date }>(
        "SELECT retrieved_at FROM snapshot WHERE snapshot_id=$1",
        [snapshot],
      )
    ).rows[0]!.retrieved_at;
    const table =
      kind === "drug" ? "cms_api_drug_coverage" : "cms_api_provider_coverage";
    const column = kind === "drug" ? "rxcui" : "npi";
    const extraColumn = kind === "drug" ? "generic_rxcui" : "accepting";
    for (const [index, row] of rows.entries()) {
      if (!plans.includes(row.plan_id) || !ids.includes(row.identity)) continue;
      const policy =
        row.coverage === "DataNotProvided"
          ? "cms_api_fallback_no_data"
          : "cms_api_fallback";
      await db.query(
        `INSERT INTO ${table}(plan_id,${column},plan_year,coverage,${extraColumn},${kind === "provider" ? "addresses," : ""}
          snapshot_id,source_row,record_policy,sourced_by,sourced_at,sourced_slug)
        VALUES($1,$2,$3,$4,$5,${kind === "provider" ? "$10::jsonb," : ""}$6,$7,$8,'${CMS_API_SOURCE}',$9,$6)
        ON CONFLICT (plan_id,${column},plan_year) DO UPDATE SET coverage=EXCLUDED.coverage,
          ${extraColumn}=EXCLUDED.${extraColumn},snapshot_id=EXCLUDED.snapshot_id,source_row=EXCLUDED.source_row,
          record_policy=EXCLUDED.record_policy,record_ttl=EXCLUDED.record_ttl,expired_at=EXCLUDED.expired_at,sourced_by=EXCLUDED.sourced_by,sourced_at=EXCLUDED.sourced_at,
          sourced_slug=EXCLUDED.sourced_slug,updated_at=now()`,
        [
          row.plan_id,
          row.identity,
          year,
          row.coverage,
          kind === "drug" ? row.generic_rxcui : row.accepting,
          snapshot,
          index + 1,
          policy,
          retrieved,
          ...(kind === "provider" ? [JSON.stringify(row.addresses)] : []),
        ],
      );
    }
    await attempt(
      db,
      endpoint,
      year,
      pairs,
      rows.length ? "absorbed" : "empty",
      {
        snapshot,
        status,
        latency: Date.now() - started,
      },
    );
    // A trial call that succeeds ends the pause.
    await db.query(
      "UPDATE cms_api_budget SET half_open=false,blocked_until='epoch',failure_count=0 WHERE singleton AND half_open",
    );
    return null;
  } catch (error) {
    const fetchError = error instanceof FetchError ? error : undefined;
    status = fetchError?.status ?? status;
    if (status !== null && [401, 403, 429].includes(status))
      await db.query(
        "UPDATE cms_api_budget SET blocked_until=now()+interval '1 hour' WHERE singleton",
      );
    // A 5xx, a timeout or an unreadable body: three within 5 minutes pause calls for 15.
    else if (
      !fetchError ||
      (fetchError.code !== "admission_denied" &&
        (status === null || status >= 500))
    )
      await db.query(`UPDATE cms_api_budget SET
        failure_count=${failures},
        failure_window_start=CASE WHEN ${windowOver} THEN now() ELSE failure_window_start END,
        half_open=half_open OR ${failures}>=3,
        blocked_until=CASE WHEN ${failures}>=3 THEN greatest(blocked_until,now()+interval '15 minutes') ELSE blocked_until END
        WHERE singleton`);
    await attempt(db, endpoint, year, pairs, "failed", {
      status,
      failure: fetchError?.code ?? "invalid_body",
      latency: Date.now() - started,
    });
    return fetchError?.code === "admission_denied"
      ? "cms_api_not_configured"
      : "cms_api_unavailable";
  }
}

/**
 * Applies the fallback to answers already computed from loaded files. Answers that are not
 * `unknown` with an opening reason come back unchanged; when an absorbed row exists for such an
 * answer, the pair is recorded in the shadow table `cms_api_conflict`.
 */
export async function applyCmsFallback<T extends Answer>(
  kind: CmsKind,
  answers: T[],
  context: CmsFallbackContext | undefined,
): Promise<T[]> {
  if (!context || !cmsFallbackEnabled()) return answers;
  const db = context.reader;
  const writer = context.writer;
  const out = [...answers];
  const pairs: Pair[] = [];
  const settled: Pair[] = [];
  answers.forEach((answer, index) => {
    let plan: string;
    try {
      plan = parse_hios(answer.requested_plan_id).base;
    } catch {
      return;
    }
    const pair = {
      index,
      plan,
      id: identityOf(kind, answer),
      year: answer.plan_year,
    };
    if (eligible(kind, answer)) pairs.push(pair);
    else if (answer.status !== "unknown" && answer.status !== "conflicting")
      settled.push(pair);
  });
  if (writer) await shadow(writer, kind, answers, settled);
  if (!pairs.length) return out;
  const reasonFor = new Map<number, string>();
  let rows = await absorbed(db, kind, pairs);
  const missing = () => pairs.filter((p) => !rows.get(keyOf(p))?.fresh);
  const key = process.env.CMS_API_KEY;
  const stateRun =
    writer && key ? await stateExchangeYears(db, missing()) : new Set<string>();
  for (const pair of missing()) {
    if (!writer) continue;
    if (!key) reasonFor.set(pair.index, "cms_api_not_configured");
    else if (!servedYears.includes(pair.year))
      reasonFor.set(pair.index, "cms_api_year_not_served");
    else if (stateRun.has(`${pair.plan.slice(5, 7)}|${pair.year}`))
      reasonFor.set(pair.index, "cms_api_state_not_served");
  }
  // Batch the rest by year into calls of at most 10 plans x 10 ids, within the request cap.
  const pending = writer
    ? missing().filter((p) => !reasonFor.has(p.index))
    : [];
  const byYear = new Map<number, Pair[]>();
  for (const pair of pending)
    byYear.set(pair.year, [...(byYear.get(pair.year) ?? []), pair]);
  for (const [year, group] of byYear) {
    let rest = group;
    while (rest.length) {
      // A rectangle may contain only eligible pairs, including its cross-product cells.
      const firstPlan = rest[0]!.plan;
      const ids = [
        ...new Set(rest.filter((p) => p.plan === firstPlan).map((p) => p.id)),
      ].slice(0, maxIdsPerCall);
      const plans = [...new Set(rest.map((p) => p.plan))]
        .filter((plan) =>
          ids.every((id) => rest.some((p) => p.plan === plan && p.id === id)),
        )
        .slice(0, maxPlansPerCall);
      const batch = rest.filter(
        (p) => plans.includes(p.plan) && ids.includes(p.id),
      );
      rest = rest.filter((p) => !batch.includes(p));
      if (context.remaining <= 0) {
        for (const pair of [...batch, ...rest])
          reasonFor.set(pair.index, "cms_api_request_cap");
        await attempt(
          writer!,
          endpointOf(kind),
          year,
          batch.length + rest.length,
          "refused",
          {
            refusal: "cms_api_request_cap",
          },
        );
        break;
      }
      const refused = await liveCall(context, writer!, kind, year, plans, ids);
      if (refused) for (const pair of batch) reasonFor.set(pair.index, refused);
    }
  }
  if (pending.length) rows = await absorbed(writer ?? db, kind, pairs);
  for (const pair of pairs) {
    const row = rows.get(keyOf(pair));
    const answer = out[pair.index]!;
    if (row && (row.fresh || reasonFor.has(pair.index) || !writer)) {
      let served: CmsApiEvidence["served_from"] = "absorbed";
      if (!row.fresh) served = "absorbed_stale";
      else if (pending.includes(pair) && !reasonFor.has(pair.index))
        served = "live";
      out[pair.index] = withEvidence(
        kind,
        answer,
        evidenceFrom(kind, row, served),
      );
    } else if (reasonFor.has(pair.index))
      out[pair.index] = { ...answer, reason: reasonFor.get(pair.index)! };
  }
  return out;
}

/** Records, without changing either side, how an absorbed answer compares with loaded files. */
async function shadow<T extends Answer>(
  db: SqlSession,
  kind: CmsKind,
  answers: T[],
  settled: Pair[],
): Promise<void> {
  if (!settled.length) return;
  const rows = await absorbed(db, kind, settled);
  for (const pair of settled) {
    const row = rows.get(keyOf(pair));
    if (!row) continue;
    const answer = answers[pair.index]!;
    const positive = ["listed_covered", "listed_participating"].includes(
      answer.status,
    );
    const cmsPositive = ["Covered", "GenericCovered"].includes(row.coverage);
    const agrees =
      row.coverage === "DataNotProvided" ? false : positive === cmsPositive;
    await db.query(
      `INSERT INTO cms_api_conflict(kind,plan_id,identity,plan_year,cms_snapshot_id,cms_coverage,
        authoritative_status,authoritative_snapshot_id,agrees)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING`,
      [
        kind,
        pair.plan,
        pair.id,
        pair.year,
        row.snapshot_id,
        row.coverage,
        answer.status,
        answer.snapshot_id,
        agrees,
      ],
    );
  }
}

export interface CmsApiAvailability {
  configured: boolean;
  absorbed_rows: number;
  last_absorbed_at: string | null;
}
/**
 * Stored API answers per issuer, state and plan year, keyed `issuer|state|year`. Empty unless
 * the fallback is on. It returns counts and a time, never plan ids, codes or key material.
 */
export async function cmsApiAvailability(db: SqlSession): Promise<{
  configured: boolean;
  byIssuer: Map<string, CmsApiAvailability>;
} | null> {
  if (!cmsFallbackEnabled()) return null;
  const configured = Boolean(process.env.CMS_API_KEY);
  const rows = (
    await db.query<{
      issuer_id: string;
      state: string;
      plan_year: number;
      absorbed_rows: number;
      last_absorbed_at: string | Date | null;
    }>(`SELECT left(plan_id,5) AS issuer_id,substr(plan_id,6,2) AS state,plan_year,
        count(*)::int AS absorbed_rows,max(sourced_at) AS last_absorbed_at
      FROM (SELECT plan_id,plan_year,sourced_at FROM cms_api_drug_coverage WHERE sourced_by='${CMS_API_SOURCE}'
        UNION ALL SELECT plan_id,plan_year,sourced_at FROM cms_api_provider_coverage WHERE sourced_by='${CMS_API_SOURCE}') rows
      GROUP BY 1,2,3`)
  ).rows;
  return {
    configured,
    byIssuer: new Map(
      rows.map((row) => [
        `${row.issuer_id}|${row.state}|${row.plan_year}`,
        {
          configured,
          absorbed_rows: row.absorbed_rows,
          last_absorbed_at: row.last_absorbed_at
            ? new Date(row.last_absorbed_at).toISOString()
            : null,
        },
      ]),
    ),
  };
}
