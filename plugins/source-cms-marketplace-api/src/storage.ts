import { createHash } from "node:crypto";
import type {
  AbsorbedRow,
  PassThroughAttempt,
  PassThroughBudgetStore,
  PassThroughReceiptInput,
  PassThroughStorage,
  SqlSession,
} from "@openplans/plugin-sdk";
import {
  CMS_API_EXPORT_EXCLUDED_TABLES,
  CMS_API_SOURCE,
  CMS_API_TERMS_URL,
  RECORD_POLICY,
  RECORD_POLICY_NO_DATA,
  endpointOf,
} from "./constants.js";
import type { CmsQuestion, CmsStatement } from "./response.js";

/**
 * Storage over the tables of migrations 970 and 992: `cms_api_drug_coverage`,
 * `cms_api_provider_coverage`, `cms_api_conflict`, `cms_api_attempt` and the shared
 * `cms_api_budget` row. Freshness comes from `expired_at` and the row's record policy.
 */
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const tableOf = (kind: string) =>
  kind === "drug" ? "cms_api_drug_coverage" : "cms_api_provider_coverage";
const columnOf = (kind: string) => (kind === "drug" ? "rxcui" : "npi");

interface StoredRow extends Record<string, unknown> {
  plan_id: string;
  identity: string;
  plan_year: number;
  coverage: string;
  generic_rxcui: string | null;
  accepting: string | null;
  snapshot_id: string;
  sourced_by: string;
  sourced_at: string | Date;
  sourced_slug: string;
  fresh: boolean;
}

/** The question set's hash: plan year, sorted plans, sorted codes. */
export function questionHash(year: number, questions: CmsQuestion[]): string {
  const plans = [...new Set(questions.map((q) => q.planId))];
  const ids = [...new Set(questions.map((q) => q.identity))];
  return sha(JSON.stringify([year, plans.sort(), ids.sort()])).slice(0, 16);
}

async function readAbsorbed(
  db: SqlSession,
  questions: CmsQuestion[],
  kind: string,
): Promise<AbsorbedRow<CmsStatement>[]> {
  if (!questions.length) return [];
  const table = tableOf(kind);
  const column = columnOf(kind);
  const extra =
    kind === "drug"
      ? "generic_rxcui, NULL::text AS accepting"
      : "NULL::text AS generic_rxcui, accepting";
  const rows = (
    await db.query<StoredRow>(
      `SELECT plan_id, ${column} AS identity, plan_year, coverage, ${extra}, snapshot_id,
        c.sourced_by, c.sourced_at, c.sourced_slug, (c.expired_at IS NULL OR c.expired_at > now()) AS fresh
      FROM ${table} c JOIN record_policy p ON p.name=c.record_policy
      WHERE (plan_id, ${column}, plan_year) IN (
        SELECT * FROM unnest($1::text[], $2::text[], $3::int[]))
        AND (c.expired_at IS NULL OR c.expired_at + p.stale_window > now())
        AND c.sourced_by = '${CMS_API_SOURCE}'`,
      [
        questions.map((q) => q.planId),
        questions.map((q) => q.identity),
        questions.map((q) => q.year),
      ],
    )
  ).rows;
  return rows.map((row) => ({
    identity: row.identity,
    planId: row.plan_id,
    year: row.plan_year,
    outcome: row.coverage === "DataNotProvided" ? "no_data" : "answer",
    answer: {
      coverage: row.coverage,
      generic_rxcui: row.generic_rxcui ?? null,
      accepting: row.accepting ?? null,
      sourced_slug: row.sourced_slug,
    },
    negative: row.coverage === "NotCovered",
    statement: row.coverage,
    snapshotId: row.snapshot_id,
    sourcedAt: new Date(row.sourced_at).toISOString(),
    freshness: row.fresh ? "absorbed" : "absorbed_stale",
  }));
}

async function receipt(
  db: SqlSession,
  call: PassThroughReceiptInput<CmsQuestion>,
): Promise<string> {
  const endpoint = endpointOf(call.kind);
  // The cache reuses identical bytes after a successful download. This receipt records
  // the new observation, rather than inheriting the first download's time.
  const retrievedAt = new Date().toISOString();
  const snapshot = `${CMS_API_SOURCE}:${endpoint.replace("/", "-")}:${call.year}:${questionHash(call.year, call.questions)}:${call.sha256.slice(0, 16)}:${sha(retrievedAt).slice(0, 16)}`;
  await db.query(
    `INSERT INTO snapshot(snapshot_id,source_id,requested_url,final_url,redirect_chain,
      retrieved_at,http_status,content_type,compressed_bytes,sha256,raw_path,schema_version,parser_version,
      terms_review_reference,expected_children,fetched_children,validation_state,activated_at)
      VALUES($1,$2,$3,$3,'[]',$4,$5,$6,$7,$8,$9,'cms-api-coverage-v1','cms-api-fallback-v1',$10,0,0,'ACTIVE',now())
      ON CONFLICT DO NOTHING`,
    [
      snapshot,
      CMS_API_SOURCE,
      call.url,
      retrievedAt,
      call.status,
      call.contentType,
      call.bytes,
      call.sha256,
      call.rawPath,
      CMS_API_TERMS_URL,
    ],
  );
  return snapshot;
}

async function writeAbsorbed(
  db: SqlSession,
  rows: Parameters<
    PassThroughStorage<CmsQuestion, CmsStatement>["writeAbsorbed"]
  >[1],
  kind: string,
): Promise<void> {
  if (!rows.length) return;
  const snapshot = rows[0]!.snapshotId;
  const retrieved = (
    await db.query<{ retrieved_at: string | Date }>(
      "SELECT retrieved_at FROM snapshot WHERE snapshot_id=$1",
      [snapshot],
    )
  ).rows[0]!.retrieved_at;
  const table = tableOf(kind);
  const column = columnOf(kind);
  const extraColumn = kind === "drug" ? "generic_rxcui" : "accepting";
  for (const row of rows) {
    const said = row.answer!;
    const policy =
      said.coverage === "DataNotProvided"
        ? RECORD_POLICY_NO_DATA
        : RECORD_POLICY;
    await db.query(
      `INSERT INTO ${table}(plan_id,${column},plan_year,coverage,${extraColumn},${kind === "provider" ? "addresses," : ""}
          snapshot_id,source_row,record_policy,sourced_by,sourced_at,sourced_slug)
        VALUES($1,$2,$3,$4,$5,${kind === "provider" ? "$10::jsonb," : ""}$6,$7,$8,'${CMS_API_SOURCE}',$9,$6)
        ON CONFLICT (plan_id,${column},plan_year) DO UPDATE SET coverage=EXCLUDED.coverage,
          ${extraColumn}=EXCLUDED.${extraColumn},snapshot_id=EXCLUDED.snapshot_id,source_row=EXCLUDED.source_row,
          record_policy=EXCLUDED.record_policy,record_ttl=EXCLUDED.record_ttl,expired_at=EXCLUDED.expired_at,sourced_by=EXCLUDED.sourced_by,sourced_at=EXCLUDED.sourced_at,
          sourced_slug=EXCLUDED.sourced_slug,updated_at=now()`,
      [
        row.question.planId,
        row.question.identity,
        row.question.year,
        said.coverage,
        kind === "drug" ? said.generic_rxcui : said.accepting,
        snapshot,
        row.sourceRow,
        policy,
        retrieved,
        ...(kind === "provider" ? [JSON.stringify(said.addresses ?? [])] : []),
      ],
    );
  }
}

/** Records, without changing either side, how a stored answer compares with loaded files. */
async function recordConflict(
  db: SqlSession,
  rows: Parameters<
    PassThroughStorage<CmsQuestion, CmsStatement>["recordConflict"]
  >[1],
  kind: string,
): Promise<void> {
  for (const row of rows) {
    const coverage = row.sourceAnswer!.coverage;
    const positive = ["listed_covered", "listed_participating"].includes(
      row.localStatus,
    );
    const cmsPositive = ["Covered", "GenericCovered"].includes(coverage);
    const agrees =
      coverage === "DataNotProvided" ? false : positive === cmsPositive;
    await db.query(
      `INSERT INTO cms_api_conflict(kind,plan_id,identity,plan_year,cms_snapshot_id,cms_coverage,
        authoritative_status,authoritative_snapshot_id,agrees)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING`,
      [
        kind,
        row.question.planId,
        row.question.identity,
        row.question.year,
        row.sourceSnapshotId,
        coverage,
        row.localStatus,
        row.local?.snapshot_id,
        agrees,
      ],
    );
  }
}

async function recordAttempt(
  db: SqlSession,
  attempt: PassThroughAttempt,
): Promise<void> {
  await db.query(
    `INSERT INTO cms_api_attempt(endpoint,plan_year,pairs,snapshot_id,outcome,http_status,failure_code,refusal_reason,latency_ms)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      endpointOf(attempt.kind),
      attempt.year,
      attempt.pairs,
      attempt.receipt,
      attempt.outcome,
      attempt.status,
      attempt.failure,
      attempt.refusal,
      attempt.latency,
    ],
  );
}

const windowOver = "failure_window_start<now()-interval '5 minutes'";
const failures = `(CASE WHEN ${windowOver} THEN 1 ELSE failure_count+1 END)`;

/** The one `cms_api_budget` row every process on the database shares. */
export const budget: PassThroughBudgetStore = {
  /**
   * Spacing, daily cap and breaker in one UPDATE. After a pause for server-side failures the
   * first reservation is the trial call. It blocks every other caller for another fifteen
   * minutes until its own result is known.
   */
  async reserve(db) {
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
  },
  async dailyMax(db) {
    const row = (
      await db.query<{ max_daily_requests: number }>(
        "SELECT max_daily_requests FROM cms_api_budget WHERE singleton",
      )
    ).rows[0];
    return row?.max_daily_requests ?? 0;
  },
  async spent(db) {
    const row = (
      await db.query<{ spent: boolean }>(
        `SELECT day_start>=(now() AT TIME ZONE 'UTC')::date AND daily_requests>=max_daily_requests AS spent
        FROM cms_api_budget WHERE singleton`,
      )
    ).rows[0];
    return row?.spent === true;
  },
  async failed(db, status) {
    const set =
      status !== null && [401, 403, 429].includes(status)
        ? "blocked_until=now()+interval '1 hour'"
        : // A 5xx, a timeout or an unreadable body: three within 5 minutes pause calls for 15.
          `failure_count=${failures},
        failure_window_start=CASE WHEN ${windowOver} THEN now() ELSE failure_window_start END,
        half_open=half_open OR ${failures}>=3,
        blocked_until=CASE WHEN ${failures}>=3 THEN greatest(blocked_until,now()+interval '15 minutes') ELSE blocked_until END`;
    // The row lock orders concurrent failures, so only the one that starts a pause reports it.
    const row = (
      await db.query<{ opened: boolean; until: string | Date }>(
        `WITH before AS (SELECT blocked_until AS was FROM cms_api_budget WHERE singleton FOR UPDATE)
        UPDATE cms_api_budget SET ${set} FROM before WHERE singleton
        RETURNING before.was<=now() AND cms_api_budget.blocked_until>now() AS opened,
          cms_api_budget.blocked_until AS until`,
      )
    ).rows[0];
    return row?.opened ? { pausedUntil: row.until } : undefined;
  },
  async recovered(db) {
    // A trial call that succeeds ends the pause.
    await db.query(
      "UPDATE cms_api_budget SET half_open=false,blocked_until='epoch',failure_count=0 WHERE singleton AND half_open",
    );
  },
};

export const storage: PassThroughStorage<CmsQuestion, CmsStatement> = {
  readAbsorbed,
  writeAbsorbed,
  recordConflict,
  excludedTables: [...CMS_API_EXPORT_EXCLUDED_TABLES],
  receipt,
  cacheKey: (_kind, year, questions) => questionHash(year, questions),
  recordAttempt,
  budget,
};

/**
 * Stored API answers per issuer, state and plan year, keyed `issuer|state|year`. It returns
 * counts and a time, never plan ids, codes or key material.
 */
export async function storedCounts(
  db: SqlSession,
  configured: boolean,
): Promise<{
  configured: boolean;
  byIssuer: Map<string, CmsApiAvailability>;
}> {
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
export interface CmsApiAvailability {
  configured: boolean;
  absorbed_rows: number;
  last_absorbed_at: string | null;
}
