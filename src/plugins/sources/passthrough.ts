import { createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { dirname } from "node:path";
import {
  CACHE_LEVEL_ORDER,
  PASSTHROUGH_OPENING_REASONS,
} from "@openplans/plugin-sdk";
import type {
  AbsorbedRow,
  CacheLevel,
  CacheStore,
  EventRegistry,
  MappedOutcome,
  PassThroughAnswer,
  PassThroughApi,
  PassThroughEvidence,
  PassThroughReason,
  PassThroughScope,
  PassThroughServedFrom,
  PassThroughSource,
  Question,
  SqlSession,
} from "@openplans/plugin-sdk";
import {
  AdmissionSession,
  FetchError,
  fetchToCache,
  fetchTransient,
  shippedManifestPaths,
} from "../../fetch/index.js";
import type { FetchOptions } from "../../fetch/index.js";
import type { Database } from "../../db/database.js";
import { runRecordPolicy } from "../../worker/record-policy.js";
import { implicitPassThroughSources } from "../core-plugin.js";
import { currentRegistries } from "../registries.js";
import { restrictCacheLevel, scopeRequestAnswers } from "../request-scope.js";
import { coreWriter, sourceWriter } from "./scoped-writer.js";

/**
 * Pass-through core (design 5.10.3 and 5.10.4). A pass-through source answers, at request time,
 * questions the loaded files leave `unknown` for a "not sourced yet" reason. The core owns
 * eligibility, batching, the budget row, the per-client share, the breaker, admission, the call,
 * the attempt row, freshness, the evidence block, the unconfirmed-negative rule, conflicts and
 * the cache levels. Loaded files always win: only eligible `unknown` answers change.
 */
type Source = PassThroughSource<Question, unknown>;

/** Generic tables, used by stored sources without their own `storage`. */
export const PASSTHROUGH_CORE_TABLES: readonly string[] = Object.freeze([
  "passthrough_answer",
  "passthrough_attempt",
  "passthrough_conflict",
]);
const MEMORY_NAMESPACE = "openplans:passthrough:v1:";
const REQUEST_NAMESPACE = "passthrough:v1:";
/** Without a declared `ttl`, a memory entry lives one minute. */
const DEFAULT_MEMORY_TTL_SECONDS = 60;
const MAX_BODY_BYTES = 1024 ** 2;
const MAX_CLIENTS = 10_000;
/** The reservation's daily cap: a new UTC day, or calls left today. */
const DAILY_CAP =
  "AND (day_start<(now() AT TIME ZONE 'UTC')::date OR daily_requests<max_daily_requests)";

/**
 * A scope the host builds. Each source has its own live-call allowance for one inbound request,
 * shared by every kind asked with the same scope: `allowances[source id]` when the host sets one,
 * else the source's `maxCallsPerRequest`. One source's calls never spend another's allowance.
 * `fetchOptions` and `admission` are trusted test injection only.
 */
export interface HostPassThroughScope extends PassThroughScope {
  allowances?: Readonly<Record<string, number>>;
  fetchOptions?: Pick<FetchOptions, "transport" | "lookup" | "dataDir">;
  admission?: AdmissionSession;
}

export interface PassThroughDeps {
  /** Registered pass-through sources, in configuration order. */
  sources: () => readonly Source[];
  /** The configured shared cache (`memory` level). Without it, `memory` keeps nothing. */
  cacheStore?: CacheStore;
  events?: Pick<EventRegistry, "emit">;
  /** Operator levels by source id; they can only make a source stricter. */
  operatorLevels?: Readonly<Record<string, CacheLevel>>;
  /** Operator memory TTLs by source id; they can only shorten the declared ones. */
  operatorTtls?: Readonly<Record<string, OperatorTtl>>;
  /** Trusted test injection only. */
  fetchOptions?: Pick<
    FetchOptions,
    "transport" | "lookup" | "dataDir" | "sleep"
  >;
  admission?: () => AdmissionSession;
}

// In-process lookup counters per source, for the status page's hit rate (design 5.11).
const lookups = new Map<string, { asked: number; cached: number }>();
function countLookups(id: string, asked: number, cached: number): void {
  const entry = lookups.get(id) ?? { asked: 0, cached: 0 };
  entry.asked += asked;
  entry.cached += cached;
  lookups.set(id, entry);
}

/**
 * Share of eligible questions this process answered from the source's cache level (stored rows,
 * the shared cache or the request scope) without a live call; undefined before the first one.
 */
export function passThroughHitRate(id: string): number | undefined {
  const entry = lookups.get(id);
  return entry && entry.asked > 0 ? entry.cached / entry.asked : undefined;
}

/** The strictest of two levels. */
export function strictestLevel(a: CacheLevel, b?: CacheLevel): CacheLevel {
  if (!b) return a;
  return CACHE_LEVEL_ORDER.indexOf(b) < CACHE_LEVEL_ORDER.indexOf(a) ? b : a;
}

/** Seconds in a simple PostgreSQL interval such as "10 minutes" or "1 day 2 hours". */
export function intervalSeconds(interval: string): number {
  const units: Record<string, number> = {
    second: 1,
    minute: 60,
    hour: 3600,
    day: 86_400,
    week: 604_800,
  };
  const parts = interval.trim().toLowerCase().split(/\s+/);
  if (!parts.length || parts.length % 2) throw new TypeError("Bad interval");
  let total = 0;
  for (let i = 0; i < parts.length; i += 2) {
    const amount = Number(parts[i]);
    const unit = units[parts[i + 1]!.replace(/s$/, "")];
    if (!Number.isSafeInteger(amount) || amount < 0 || unit === undefined)
      throw new TypeError("Bad interval");
    total += amount * unit;
  }
  return total;
}

/** Seconds a `memory` entry lives as the source declares it. */
function declaredMemoryTtl(source: Source, outcome: MappedOutcome): number {
  const declared =
    outcome === "no_data"
      ? (source.cache.negativeTtl ?? source.cache.ttl)
      : source.cache.ttl;
  return declared ? intervalSeconds(declared) : DEFAULT_MEMORY_TTL_SECONDS;
}

/** An operator's memory TTLs for one source, in seconds. */
export interface OperatorTtl {
  ttl?: number;
  negativeTtl?: number;
}

interface Pair {
  index: number;
  question: Question;
  key: string;
}
interface Result {
  outcome: MappedOutcome;
  answer: unknown;
  negative: boolean;
  statement: string;
  snapshotId: string | null;
  sourcedAt: string;
  servedFrom: PassThroughServedFrom;
}
interface Batch {
  year: number;
  questions: Question[];
  pairs: Pair[];
}
type Reservation = "ok" | "budget" | "blocked";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const keyOf = (q: Question) => `${q.planId ?? ""}|${q.identity}|${q.year}`;
const utcDay = () => new Date().toISOString().slice(0, 10);

/** The source's own name for a core reason code; null keeps the answer's reason. */
function reasonOf(source: Source, code: PassThroughReason): string | null {
  const own = source.reasons?.[code];
  return own === undefined ? code : own;
}

function evidenceKey(source: Source): string {
  return source.evidence?.key ?? "passthrough";
}
function keyValue(source: Source): string | undefined {
  const name = source.manifest.apiKeyEnv;
  return name ? process.env[name] || undefined : undefined;
}

export function createPassThrough(deps: PassThroughDeps): PassThroughApi {
  const callsLeft = new WeakMap<PassThroughScope, Map<string, number>>();
  const clients = new Map<
    string,
    { day: string; counts: Map<string, number> }
  >();
  const exhaustedOn = new Map<string, string>();
  const budgetRows = new Set<string>();
  const sessions = new Map<
    string,
    { session: AdmissionSession; created: number }
  >();

  const level = (source: Source) =>
    strictestLevel(source.cache.level, deps.operatorLevels?.[source.id]);
  const memoryTtl = (source: Source, outcome: MappedOutcome) => {
    const declared = declaredMemoryTtl(source, outcome);
    const own = deps.operatorTtls?.[source.id];
    const wanted = outcome === "no_data" ? own?.negativeTtl : own?.ttl;
    return wanted === undefined ? declared : Math.min(declared, wanted);
  };

  function admission(
    source: Source,
    scope: HostPassThroughScope,
  ): AdmissionSession | undefined {
    if (scope.admission) return scope.admission;
    // An injected transport without a session: fetchToCache admits with its own default.
    if (scope.fetchOptions?.transport) return undefined;
    if (deps.admission) return deps.admission();
    const held = sessions.get(source.id);
    if (
      held &&
      !held.session.isStopped &&
      Date.now() - held.created < 12 * 60 * 60 * 1000
    )
      return held.session;
    const operator = source.manifest.shippedOnly
      ? undefined
      : process.env.OPENPLANS_ACCESS_MANIFEST;
    const session = new AdmissionSession(
      operator ? [...shippedManifestPaths(), operator] : shippedManifestPaths(),
      { maxRequests: 1000, maxTransferBytes: 128 * 1024 ** 2 },
    );
    sessions.set(source.id, { session, created: Date.now() });
    return session;
  }

  function eligible(
    source: Source,
    answer: PassThroughAnswer,
    question: Question,
  ): boolean {
    const reason = answer.reason ?? "";
    return (
      answer.status === "unknown" &&
      PASSTHROUGH_OPENING_REASONS.includes(reason) &&
      source.eligibility.openingReasons.includes(reason) &&
      source.eligibility.accepts(question)
    );
  }

  async function attempt(
    db: SqlSession,
    source: Source,
    kind: string,
    levelUsed: CacheLevel,
    year: number,
    pairs: number,
    outcome: "absorbed" | "answered" | "empty" | "failed" | "refused",
    extra: {
      receipt?: string | null;
      status?: number | null;
      failure?: string | null;
      refusal?: string | null;
      latency?: number | null;
    } = {},
  ): Promise<void> {
    if (source.storage?.recordAttempt) {
      await source.storage.recordAttempt(db, {
        kind,
        level: levelUsed,
        year,
        pairs,
        outcome,
        receipt: extra.receipt ?? null,
        status: extra.status ?? null,
        failure: extra.failure ?? null,
        refusal: extra.refusal ?? null,
        latency: extra.latency ?? null,
      });
      return;
    }
    await coreWriter(db).query(
      `INSERT INTO passthrough_attempt(source_id,kind,level,plan_year,pairs,receipt_id,outcome,
        http_status,failure_code,refusal_reason,latency_ms)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        source.id,
        kind,
        levelUsed,
        year,
        pairs,
        extra.receipt ?? null,
        outcome,
        extra.status ?? null,
        extra.failure ?? null,
        extra.refusal ?? null,
        extra.latency ?? null,
      ],
    );
  }

  async function budgetRow(db: SqlSession, source: Source): Promise<void> {
    if (source.storage?.budget || budgetRows.has(source.id)) return;
    await coreWriter(db).query(
      `INSERT INTO passthrough_budget(source_id,min_interval_ms,max_daily_requests)
      VALUES($1,$2,$3) ON CONFLICT (source_id) DO NOTHING`,
      [source.id, source.budget.minIntervalMs, source.budget.dailyMax],
    );
    budgetRows.add(source.id);
  }

  /**
   * Atomic reservation on the source's budget row: spacing, daily cap and breaker in one
   * UPDATE. After a pause the first reservation is the trial call; it holds the pause for
   * everyone else until its own result is known.
   */
  async function reserve(db: SqlSession, source: Source): Promise<Reservation> {
    if (source.storage?.budget) return source.storage.budget.reserve(db);
    const reserved = await coreWriter(db).query(
      `UPDATE passthrough_budget SET
        daily_requests=CASE WHEN day_start<(now() AT TIME ZONE 'UTC')::date THEN 1 ELSE daily_requests+1 END,
        day_start=(now() AT TIME ZONE 'UTC')::date,next_request_at=now()+min_interval_ms*interval '1 millisecond',
        blocked_until=CASE WHEN half_open THEN now()+$2*interval '1 millisecond' ELSE blocked_until END
      WHERE source_id=$1 AND next_request_at<=now() AND blocked_until<=now()
        ${DAILY_CAP} RETURNING source_id`,
      [source.id, source.budget.breaker.pauseMs],
    );
    if (reserved.rows.length) return "ok";
    const blocked = await coreWriter(db).query(
      "SELECT 1 FROM passthrough_budget WHERE source_id=$1 AND blocked_until>now()",
      [source.id],
    );
    return blocked.rows.length ? "blocked" : "budget";
  }

  async function emit(
    event:
      | {
          type: "passthrough.budget_exhausted";
          idempotencyKey: string;
          payload: { sourceId: string; dailyMax: number };
        }
      | {
          type: "passthrough.breaker_open";
          idempotencyKey: string;
          payload: { sourceId: string; untilAt: string };
        },
  ): Promise<void> {
    try {
      await deps.events?.emit(event);
    } catch {
      // An event that cannot be recorded never changes an answer.
    }
  }

  /**
   * One `passthrough.budget_exhausted` per source and UTC day from this process; the outbox key
   * keeps it to one row across processes. A "budget" reservation also covers call spacing, so
   * the row must show today's allowance spent first.
   */
  async function budgetExhausted(db: SqlSession, source: Source) {
    const day = utcDay();
    if (exhaustedOn.get(source.id) === day) return;
    const own = source.storage?.budget;
    let dailyMax: number;
    if (own) {
      if (!(await own.spent?.(db))) return;
      dailyMax = await own.dailyMax(db);
    } else {
      const row = (
        await coreWriter(db).query<{
          max_daily_requests: number;
          spent: boolean;
        }>(
          `SELECT max_daily_requests,
            day_start>=(now() AT TIME ZONE 'UTC')::date AND daily_requests>=max_daily_requests AS spent
          FROM passthrough_budget WHERE source_id=$1`,
          [source.id],
        )
      ).rows[0];
      if (!row?.spent) return;
      dailyMax = row.max_daily_requests;
    }
    exhaustedOn.set(source.id, day);
    await emit({
      type: "passthrough.budget_exhausted",
      idempotencyKey: `passthrough.budget_exhausted:${source.id}:${day}`,
      payload: { sourceId: source.id, dailyMax },
    });
  }

  /** `passthrough.breaker_open` once per pause, keyed by its end. */
  async function paused(source: Source, until: string | Date) {
    const untilAt = new Date(until).toISOString();
    await emit({
      type: "passthrough.breaker_open",
      idempotencyKey: `passthrough.breaker_open:${source.id}:${untilAt}`,
      payload: { sourceId: source.id, untilAt },
    });
  }

  /**
   * Server-side failures: `breaker.failures` within `windowMs` pause calls for `pauseMs`; a 401,
   * 403 or 429 pauses them for an hour. Only the failure that starts a pause reports it.
   */
  async function failed(db: SqlSession, source: Source, status: number | null) {
    if (source.storage?.budget) {
      const pause = await source.storage.budget.failed(db, status);
      if (pause) await paused(source, pause.pausedUntil);
      return;
    }
    const { failures, windowMs, pauseMs } = source.budget.breaker;
    const over = `failure_window_start<now()-$2*interval '1 millisecond'`;
    const count = `(CASE WHEN ${over} THEN 1 ELSE failure_count+1 END)`;
    const refused = status !== null && [401, 403, 429].includes(status);
    const set = refused
      ? "blocked_until=now()+interval '1 hour'"
      : `failure_count=${count},
          failure_window_start=CASE WHEN ${over} THEN now() ELSE failure_window_start END,
          half_open=half_open OR ${count}>=$3,
          blocked_until=CASE WHEN ${count}>=$3 THEN greatest(blocked_until,now()+$4*interval '1 millisecond') ELSE blocked_until END`;
    const row = (
      await coreWriter(db).query<{ opened: boolean; until: string | Date }>(
        `WITH before AS (SELECT blocked_until AS was FROM passthrough_budget WHERE source_id=$1 FOR UPDATE)
        UPDATE passthrough_budget SET ${set} FROM before WHERE source_id=$1
        RETURNING before.was<=now() AND passthrough_budget.blocked_until>now() AS opened,
          passthrough_budget.blocked_until AS until`,
        refused ? [source.id] : [source.id, windowMs, failures, pauseMs],
      )
    ).rows[0];
    if (row?.opened) await paused(source, row.until);
  }

  function clientCount(source: Source, client: string) {
    let state = clients.get(source.id);
    const day = utcDay();
    if (!state || state.day !== day) {
      state = { day, counts: new Map() };
      clients.set(source.id, state);
    }
    const key =
      state.counts.has(client) || state.counts.size < MAX_CLIENTS ? client : "";
    return { state, key, count: state.counts.get(key) ?? 0 };
  }

  function remaining(scope: HostPassThroughScope, source: Source): number {
    let left = callsLeft.get(scope);
    if (!left) callsLeft.set(scope, (left = new Map()));
    if (!left.has(source.id))
      left.set(
        source.id,
        scope.allowances?.[source.id] ?? source.batch.maxCallsPerRequest,
      );
    return left.get(source.id)!;
  }

  function batches(source: Source, pairs: Pair[]): Batch[] {
    const byYear = new Map<number, Pair[]>();
    for (const pair of pairs)
      byYear.set(pair.question.year, [
        ...(byYear.get(pair.question.year) ?? []),
        pair,
      ]);
    const out: Batch[] = [];
    const unique = (group: Pair[]) => [
      ...new Map(group.map((p) => [p.key, p.question])).values(),
    ];
    for (const [year, group] of byYear) {
      const grid = source.batch.grid;
      let rest = group;
      while (rest.length) {
        let batch: Pair[];
        if (grid) {
          // A rectangle may contain only eligible pairs, including its cross-product cells.
          const plan = (p: Pair) => p.question.planId ?? "";
          const firstPlan = plan(rest[0]!);
          const ids = [
            ...new Set(
              rest
                .filter((p) => plan(p) === firstPlan)
                .map((p) => p.question.identity),
            ),
          ].slice(0, grid.maxIdentities);
          const plans = [...new Set(rest.map(plan))]
            .filter((candidate) =>
              ids.every((id) =>
                rest.some(
                  (p) => plan(p) === candidate && p.question.identity === id,
                ),
              ),
            )
            .slice(0, grid.maxPlans);
          batch = rest.filter(
            (p) => plans.includes(plan(p)) && ids.includes(p.question.identity),
          );
        } else {
          const keys = [...new Set(rest.map((p) => p.key))].slice(
            0,
            source.batch.maxQuestionsPerCall,
          );
          batch = rest.filter((p) => keys.includes(p.key));
        }
        rest = rest.filter((p) => !batch.includes(p));
        out.push({ year, questions: unique(batch), pairs: batch });
      }
    }
    return out;
  }

  /** Keeps live answers at the levels that keep anything outside the database. */
  async function keep(
    levelUsed: CacheLevel,
    source: Source,
    kind: string,
    entries: [string, Result][],
  ): Promise<void> {
    if (levelUsed === "request") {
      const answers = scopeRequestAnswers();
      for (const [key, result] of entries)
        answers?.set(`${REQUEST_NAMESPACE}${source.id}:${kind}:${key}`, {
          ...result,
        });
    } else if (levelUsed === "memory" && deps.cacheStore) {
      for (const [key, result] of entries)
        await deps.cacheStore.set(
          `${MEMORY_NAMESPACE}${source.id}:${kind}:${key}`,
          JSON.stringify(result),
          memoryTtl(source, result.outcome),
        );
    }
  }

  async function readStored(
    db: SqlSession,
    source: Source,
    kind: string,
    questions: Question[],
  ): Promise<AbsorbedRow<unknown>[]> {
    if (!questions.length) return [];
    if (source.storage) return source.storage.readAbsorbed(db, questions, kind);
    const rows = (
      await coreWriter(db).query<{
        plan_id: string;
        identity: string;
        plan_year: number;
        outcome: MappedOutcome;
        negative: boolean;
        answer: unknown;
        statement: string;
        snapshot_id: string;
        sourced_at: string | Date;
        fresh: boolean;
      }>(
        `SELECT a.plan_id,a.identity,a.plan_year,a.outcome,a.negative,a.answer,a.statement,a.snapshot_id,
          a.sourced_at,(a.expired_at IS NULL OR a.expired_at>now()) AS fresh
        FROM passthrough_answer a JOIN record_policy p ON p.name=a.record_policy
        WHERE a.source_id=$1 AND a.kind=$2 AND a.sourced_by=$1
          AND (a.plan_id,a.identity,a.plan_year) IN (SELECT * FROM unnest($3::text[],$4::text[],$5::int[]))
          AND (a.expired_at IS NULL OR a.expired_at+p.stale_window>now())`,
        [
          source.id,
          kind,
          questions.map((q) => q.planId ?? ""),
          questions.map((q) => q.identity),
          questions.map((q) => q.year),
        ],
      )
    ).rows;
    return rows.map((row) => ({
      identity: row.identity,
      ...(row.plan_id ? { planId: row.plan_id } : {}),
      year: row.plan_year,
      outcome: row.outcome,
      answer: row.answer,
      negative: row.negative,
      statement: row.statement,
      snapshotId: row.snapshot_id,
      sourcedAt: new Date(row.sourced_at).toISOString(),
      freshness: row.fresh ? "absorbed" : "absorbed_stale",
    }));
  }

  async function writeStored(
    db: SqlSession,
    source: Source,
    kind: string,
    snapshotId: string,
    mapped: { question: Question; result: Result; sourceRow?: number }[],
  ): Promise<void> {
    if (source.storage) {
      await source.storage.writeAbsorbed(
        db,
        mapped.map(({ question, result, sourceRow }) => ({
          question,
          outcome: result.outcome,
          answer: result.answer,
          negative: result.negative,
          statement: result.statement,
          snapshotId,
          ...(sourceRow === undefined ? {} : { sourceRow }),
        })),
        kind,
      );
      return;
    }
    const policy = source.cache.recordPolicy;
    // The first stored answer registers the table in the catalog generation (migration 1001).
    await coreWriter(db).query(
      "INSERT INTO api_data_generation(table_name) VALUES ('passthrough_answer') ON CONFLICT DO NOTHING",
    );
    for (const [index, { question, result }] of mapped.entries())
      await coreWriter(db).query(
        `INSERT INTO passthrough_answer(source_id,kind,plan_id,identity,plan_year,outcome,negative,answer,
          statement,policy_name,snapshot_id,source_row)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12)
        ON CONFLICT (source_id,kind,plan_id,identity,plan_year) DO UPDATE SET outcome=EXCLUDED.outcome,
          negative=EXCLUDED.negative,answer=EXCLUDED.answer,statement=EXCLUDED.statement,
          policy_name=EXCLUDED.policy_name,snapshot_id=EXCLUDED.snapshot_id,source_row=EXCLUDED.source_row`,
        [
          source.id,
          kind,
          question.planId ?? "",
          question.identity,
          question.year,
          result.outcome,
          result.negative,
          result.outcome === "answer" ? JSON.stringify(result.answer) : null,
          result.statement,
          result.outcome === "no_data"
            ? (policy!.noDataName ?? policy!.name)
            : policy!.name,
          snapshotId,
          index + 1,
        ],
      );
  }

  /** Records, without changing either side, how a stored answer compares with loaded files. */
  async function shadow(
    db: SqlSession,
    source: Source,
    kind: string,
    answers: PassThroughAnswer[],
    settled: Pair[],
  ): Promise<void> {
    const rows = await readStored(
      db,
      source,
      kind,
      settled.map((p) => p.question),
    );
    const byKey = new Map(
      rows.map((row) => [
        keyOf({ planId: row.planId, identity: row.identity, year: row.year }),
        row,
      ]),
    );
    const found = settled.flatMap((pair) => {
      const row = byKey.get(pair.key);
      return row ? [{ pair, row }] : [];
    });
    if (!found.length) return;
    if (source.storage) {
      await source.storage.recordConflict(
        db,
        found.map(({ pair, row }) => ({
          question: pair.question,
          sourceAnswer: row.answer,
          localStatus: answers[pair.index]!.status,
          sourceSnapshotId: row.snapshotId,
          local: answers[pair.index]!,
        })),
        kind,
      );
      return;
    }
    for (const { pair, row } of found) {
      const sourceStatus =
        row.outcome === "answer" && row.answer && typeof row.answer === "object"
          ? (row.answer as { status?: unknown }).status
          : undefined;
      await coreWriter(db).query(
        `INSERT INTO passthrough_conflict(source_id,kind,plan_id,identity,plan_year,source_snapshot_id,
          source_outcome,local_status,agrees)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING`,
        [
          source.id,
          kind,
          pair.question.planId ?? "",
          pair.question.identity,
          pair.question.year,
          row.snapshotId,
          row.outcome,
          answers[pair.index]!.status,
          sourceStatus === answers[pair.index]!.status,
        ],
      );
    }
  }

  /** One live call. Fills `results` and returns null, or returns a refusal reason. */
  async function call(
    source: Source,
    levelUsed: CacheLevel,
    kind: string,
    batch: Batch,
    scope: HostPassThroughScope,
    db: SqlSession,
    results: Map<string, Result>,
  ): Promise<PassThroughReason | null> {
    const pairs = batch.questions.length;
    const refuse = async (
      reason: PassThroughReason,
      refusal: PassThroughReason = reason,
    ) => {
      await attempt(db, source, kind, levelUsed, batch.year, pairs, "refused", {
        refusal: reasonOf(source, refusal),
      });
      return reason;
    };
    await budgetRow(db, source);
    const client =
      scope.client === undefined
        ? undefined
        : clientCount(source, scope.client);
    if (client) {
      const max = source.storage?.budget
        ? await source.storage.budget.dailyMax(db)
        : ((
            await coreWriter(db).query<{ max_daily_requests: number }>(
              "SELECT max_daily_requests FROM passthrough_budget WHERE source_id=$1",
              [source.id],
            )
          ).rows[0]?.max_daily_requests ?? 0);
      if (
        client.count >= Math.max(1, Math.floor(max * source.budget.clientShare))
      )
        return refuse("passthrough_request_cap", "passthrough_client_share");
    }
    const reservation = await reserve(db, source);
    if (reservation !== "ok") {
      if (reservation === "budget") {
        await budgetExhausted(db, source);
        return refuse("passthrough_budget_exhausted");
      }
      return refuse("passthrough_unavailable");
    }
    callsLeft.get(scope)!.set(source.id, remaining(scope, source) - 1);
    if (client) client.state.counts.set(client.key, client.count + 1);

    const request = source.buildRequest(batch.questions, kind);
    const url = new URL(`https://${source.manifest.host}${request.path}`);
    if (
      url.hostname !== source.manifest.host ||
      !source.manifest.permittedPaths.some((path) =>
        url.pathname.startsWith(path),
      )
    )
      throw new Error("Request outside the source's permitted paths");
    for (const [name, value] of Object.entries(request.query))
      url.searchParams.set(name, value);
    const params = source.storage?.cacheKey
      ? source.storage.cacheKey(kind, batch.year, batch.questions)
      : sha(
          JSON.stringify([kind, batch.year, batch.questions.map(keyOf).sort()]),
        ).slice(0, 16);
    const options = {
      ...(scope.fetchOptions ?? deps.fetchOptions),
      admission: admission(source, scope),
      allowHosts: [source.manifest.host],
      expectedContent: "json" as const,
      maxBytes: MAX_BODY_BYTES,
      maxDecompressedBytes: MAX_BODY_BYTES,
      maxAttempts: 1,
      maxRedirects: 0,
      connectTimeoutMs: 3_000,
      readTimeoutMs: 3_000,
    };
    const started = Date.now();
    let status: number | null = null;
    try {
      let text: string;
      let receipt: string;
      let stored: Awaited<ReturnType<typeof fetchToCache>> | undefined;
      const persistent = levelUsed === "stored";
      if (persistent) {
        // One cache directory per question set, as the receipt names it.
        stored = await fetchToCache(url.href, {
          ...options,
          source: `${source.id}-${params}`,
        });
        if (stored.outcome === "not_modified") throw new Error("no body");
        status = stored.metadata.status;
        text = await readFile(stored.path, "utf8");
        receipt = stored.metadata.sha256;
      } else {
        const fetched = await fetchTransient(url, {
          ...options,
          deadlineMs: 10_000,
        });
        status = fetched.status;
        text = fetched.body.toString("utf8");
        receipt = fetched.sha256;
      }
      const key = keyValue(source);
      if (key && text.includes(key)) {
        // A body that echoes the key is never stored or parsed.
        if (stored && stored.outcome !== "not_modified") {
          await rm(dirname(stored.path), { recursive: true, force: true });
          await rm(stored.metadataPath, { force: true });
        }
        await attempt(
          db,
          source,
          kind,
          levelUsed,
          batch.year,
          pairs,
          "failed",
          {
            status,
            failure: "body_rejected",
            latency: Date.now() - started,
          },
        );
        return "passthrough_unavailable";
      }
      const wanted = new Map(batch.questions.map((q) => [keyOf(q), q]));
      const mapped = new Map<
        string,
        { question: Question; result: Result; sourceRow?: number }
      >();
      const sourcedAt = new Date().toISOString();
      const entries = source.mapResponse(
        JSON.parse(text),
        batch.questions,
        kind,
      );
      // Entries for questions not asked are dropped; a repeated entry replaces the earlier one.
      for (const entry of entries) {
        const question = wanted.get(keyOf(entry.question));
        if (!question) continue;
        mapped.set(keyOf(question), {
          question,
          ...(entry.sourceRow === undefined
            ? {}
            : { sourceRow: entry.sourceRow }),
          result: {
            outcome: entry.outcome,
            answer: "answer" in entry ? (entry.answer ?? null) : null,
            negative: entry.outcome === "answer" && entry.negative === true,
            statement: String(entry.statement),
            snapshotId: null,
            sourcedAt,
            servedFrom: "live",
          },
        });
      }
      if (
        persistent &&
        stored &&
        stored.outcome !== "not_modified" &&
        source.storage?.receipt
      ) {
        receipt = await source.storage.receipt(db, {
          kind,
          year: batch.year,
          questions: batch.questions,
          url: stored.metadata.url,
          status: stored.metadata.status,
          contentType: stored.metadata.content_type,
          bytes: stored.metadata.bytes,
          sha256: stored.metadata.sha256,
          rawPath: stored.path,
        });
        await writeStored(db, source, kind, receipt, [...mapped.values()]);
      } else if (persistent && stored && stored.outcome !== "not_modified") {
        receipt = `${source.id}:${kind}:${batch.year}:${params}:${stored.metadata.sha256.slice(0, 16)}:${sha(sourcedAt).slice(0, 16)}`;
        await coreWriter(db).query(
          `INSERT INTO source(source_id,publisher,source_kind,terms_review_reference)
          VALUES($1,$2,'passthrough',$3) ON CONFLICT (source_id) DO NOTHING`,
          [
            source.id,
            source.publisher ?? source.id,
            source.evidence?.termsUrl ?? null,
          ],
        );
        await coreWriter(db).query(
          `INSERT INTO snapshot(snapshot_id,source_id,requested_url,final_url,redirect_chain,
          retrieved_at,http_status,content_type,compressed_bytes,sha256,raw_path,schema_version,parser_version,
          terms_review_reference,expected_children,fetched_children,validation_state,activated_at)
          VALUES($1,$2,$3,$3,'[]',$4,$5,$6,$7,$8,$9,'passthrough-v1',$10,$11,0,0,'ACTIVE',now())
          ON CONFLICT DO NOTHING`,
          [
            receipt,
            source.id,
            stored.metadata.url,
            sourcedAt,
            status,
            stored.metadata.content_type,
            stored.metadata.bytes,
            stored.metadata.sha256,
            stored.path,
            `${source.id}-v1`,
            source.evidence?.termsUrl ?? null,
          ],
        );
        await writeStored(db, source, kind, receipt, [...mapped.values()]);
      } else {
        for (const [key, { result }] of mapped) results.set(key, result);
        await keep(
          levelUsed,
          source,
          kind,
          [...mapped].map(([key, { result }]) => [key, result]),
        );
      }
      // "empty" means the body held no entries at all.
      let outcome: "absorbed" | "answered" | "empty" = "empty";
      if (entries.length) outcome = persistent ? "absorbed" : "answered";
      await attempt(db, source, kind, levelUsed, batch.year, pairs, outcome, {
        receipt,
        status,
        latency: Date.now() - started,
      });
      // A trial call that succeeds ends the pause.
      if (source.storage?.budget) await source.storage.budget.recovered(db);
      else
        await coreWriter(db).query(
          "UPDATE passthrough_budget SET half_open=false,blocked_until='epoch',failure_count=0 WHERE source_id=$1 AND half_open",
          [source.id],
        );
      return null;
    } catch (error) {
      const fetchError = error instanceof FetchError ? error : undefined;
      status = fetchError?.status ?? status;
      if (
        (status !== null && [401, 403, 429].includes(status)) ||
        !fetchError ||
        (fetchError.code !== "admission_denied" &&
          fetchError.code !== "storage_forbidden" &&
          (status === null || status >= 500))
      )
        await failed(db, source, status);
      await attempt(db, source, kind, levelUsed, batch.year, pairs, "failed", {
        status,
        failure: fetchError?.code ?? "invalid_body",
        latency: Date.now() - started,
      });
      return fetchError?.code === "admission_denied"
        ? "passthrough_not_configured"
        : "passthrough_unavailable";
    }
  }

  function serve<T extends PassThroughAnswer>(
    source: Source,
    levelUsed: CacheLevel,
    kind: string,
    answer: T,
    result: Result,
    confirmed: boolean,
  ): T {
    if (source.serve)
      return source.serve(kind, answer, {
        outcome: result.outcome,
        answer: result.answer,
        negative: result.negative,
        statement: result.statement,
        snapshotId: levelUsed === "stored" ? result.snapshotId : null,
        sourcedAt: result.sourcedAt,
        servedFrom: result.servedFrom,
        level: levelUsed,
        confirmed,
      });
    const negativeUnconfirmed =
      result.outcome === "negative_unconfirmed" ||
      (result.outcome === "answer" && result.negative && !confirmed);
    const evidence: PassThroughEvidence = {
      source_id: source.id,
      level: levelUsed,
      outcome: negativeUnconfirmed ? "negative_unconfirmed" : result.outcome,
      served_from: result.servedFrom,
      snapshot_id: levelUsed === "stored" ? result.snapshotId : null,
      retrieved_at: result.sourcedAt,
      statement: result.statement,
      ...(source.evidence
        ? {
            source: source.evidence.source,
            terms_url: source.evidence.termsUrl,
            ...(source.evidence.limits
              ? { limits: source.evidence.limits(kind) }
              : {}),
          }
        : {}),
    };
    const key = evidenceKey(source);
    // An unconfirmed negative stays unknown; the source's words go into provenance only.
    if (negativeUnconfirmed)
      return {
        ...answer,
        status: "unknown",
        reason: "passthrough_negative_unconfirmed",
        [key]: evidence,
      };
    if (result.outcome === "no_data")
      return {
        ...answer,
        reason: "passthrough_data_not_provided",
        [key]: evidence,
      };
    const folded = source.fold
      ? source.fold(kind, answer, { answer: result.answer, evidence })
      : {
          ...answer,
          ...(result.answer && typeof result.answer === "object"
            ? (result.answer as object)
            : {}),
          reason: null,
        };
    return { ...folded, [key]: evidence };
  }

  async function applySource<T extends PassThroughAnswer>(
    source: Source,
    kind: string,
    answers: T[],
    scope: HostPassThroughScope,
    skip: ReadonlySet<number>,
    served: Set<number>,
  ): Promise<T[]> {
    const levelUsed = level(source);
    const pairs: Pair[] = [];
    const settled: Pair[] = [];
    answers.forEach((answer, index) => {
      // An earlier source already served this answer.
      if (skip.has(index)) return;
      let question: Question | null;
      try {
        question = source.question(kind, answer);
      } catch {
        return;
      }
      if (!question) return;
      const pair = { index, question, key: keyOf(question) };
      if (eligible(source, answer, question)) pairs.push(pair);
      else if (answer.status !== "unknown" && answer.status !== "conflicting")
        settled.push(pair);
    });
    // A plugin route's scoped writer reaches only that plugin's own sources.
    const writer = sourceWriter(scope.writer, source);
    if (levelUsed === "stored" && writer && settled.length)
      await shadow(writer, source, kind, answers, settled);
    if (!pairs.length) return answers;

    const results = new Map<string, Result>();
    const stale = new Map<string, Result>();
    const questions = [
      ...new Map(pairs.map((p) => [p.key, p.question])).values(),
    ];
    const fromRow = (row: AbsorbedRow<unknown>): Result => ({
      outcome: row.outcome,
      answer: row.answer,
      negative: row.negative === true,
      statement: row.statement,
      snapshotId: row.snapshotId,
      sourcedAt: row.sourcedAt,
      servedFrom: row.freshness,
    });
    if (levelUsed === "stored") {
      for (const row of await readStored(
        scope.reader,
        source,
        kind,
        questions,
      )) {
        const key = keyOf({
          planId: row.planId,
          identity: row.identity,
          year: row.year,
        });
        (row.freshness === "absorbed_stale" ? stale : results).set(
          key,
          fromRow(row),
        );
      }
    } else if (levelUsed === "memory" && deps.cacheStore) {
      for (const question of questions) {
        const value = await deps.cacheStore.get(
          `${MEMORY_NAMESPACE}${source.id}:${kind}:${keyOf(question)}`,
        );
        if (value)
          results.set(keyOf(question), {
            ...(JSON.parse(value) as Result),
            servedFrom: "memory",
          });
      }
    } else if (levelUsed === "request") {
      const kept = scopeRequestAnswers();
      for (const question of questions) {
        const value = kept?.get(
          `${REQUEST_NAMESPACE}${source.id}:${kind}:${keyOf(question)}`,
        ) as Result | undefined;
        if (value)
          results.set(keyOf(question), { ...value, servedFrom: "request" });
      }
    }

    countLookups(source.id, questions.length, results.size);

    const reasonFor = new Map<number, string>();
    const setReason = (index: number, code: PassThroughReason) => {
      const reason = reasonOf(source, code);
      if (reason !== null) reasonFor.set(index, reason);
    };
    const missing = pairs.filter((p) => !results.has(p.key));
    const calledLive = new Set<string>();
    if (!writer) {
      for (const pair of missing)
        if (!stale.has(pair.key))
          setReason(pair.index, "passthrough_not_available_read_only");
      // Never share a read-only answer from a `none` or `request` source. The next request
      // with a writer may call. MCP answers `unknown` and the catalog stays empty (5.10.5).
      if (missing.length && (levelUsed === "none" || levelUsed === "request"))
        restrictCacheLevel(levelUsed);
    } else if (missing.length) {
      // Generic storage needs the record policies the source names.
      const configured =
        (source.manifest.accessMode !== "api-key" ||
          Boolean(keyValue(source))) &&
        (levelUsed !== "stored" ||
          Boolean(source.storage) ||
          Boolean(source.cache.recordPolicy));
      let callable: Pair[] = [];
      for (const pair of missing) {
        if (!configured) setReason(pair.index, "passthrough_not_configured");
        else if (
          source.eligibility.years &&
          !source.eligibility.years.includes(pair.question.year)
        )
          setReason(pair.index, "passthrough_year_not_served");
        else callable.push(pair);
      }
      if (callable.length && source.eligibility.notServed) {
        const verdicts = await source.eligibility.notServed(
          scope.reader,
          callable.map((p) => p.question),
        );
        callable = callable.filter((pair, i) => {
          const reason = verdicts[i];
          if (reason) reasonFor.set(pair.index, reason);
          return !reason;
        });
      }
      const planned = batches(source, callable);
      for (const [index, batch] of planned.entries()) {
        if (remaining(scope, source) <= 0) {
          // One refusal row per plan year left, counting every answer it leaves unknown.
          const byYear = new Map<number, number>();
          for (const rest of planned.slice(index)) {
            for (const pair of rest.pairs)
              setReason(pair.index, "passthrough_request_cap");
            byYear.set(
              rest.year,
              (byYear.get(rest.year) ?? 0) + rest.pairs.length,
            );
          }
          for (const [year, count] of byYear)
            await attempt(
              writer,
              source,
              kind,
              levelUsed,
              year,
              count,
              "refused",
              { refusal: reasonOf(source, "passthrough_request_cap") },
            );
          break;
        }
        const refused = await call(
          source,
          levelUsed,
          kind,
          batch,
          scope,
          writer,
          results,
        );
        if (refused)
          for (const pair of batch.pairs) setReason(pair.index, refused);
        else
          for (const question of batch.questions)
            calledLive.add(keyOf(question));
      }
      if (levelUsed === "stored" && calledLive.size)
        for (const row of await readStored(
          writer,
          source,
          kind,
          questions.filter((q) => calledLive.has(keyOf(q))),
        )) {
          // A call that did not answer a question leaves its stale row stale.
          if (row.freshness === "absorbed_stale") continue;
          const key = keyOf({
            planId: row.planId,
            identity: row.identity,
            year: row.year,
          });
          results.set(key, { ...fromRow(row), servedFrom: "live" });
          stale.delete(key);
        }
    }

    const negatives = [
      ...new Set(
        pairs
          .filter((p) => {
            const r = results.get(p.key) ?? stale.get(p.key);
            return r?.outcome === "answer" && r.negative;
          })
          .map((p) => p.question.identity),
      ),
    ];
    const known =
      negatives.length && source.confirmIdentities
        ? await source.confirmIdentities(scope.reader, kind, negatives)
        : new Set<string>();
    const out = [...answers];
    const ttl =
      levelUsed === "memory" ? memoryTtl(source, "answer") : undefined;
    for (const pair of pairs) {
      let result = results.get(pair.key);
      if (
        !result &&
        stale.has(pair.key) &&
        (reasonFor.has(pair.index) || !writer)
      )
        result = { ...stale.get(pair.key)!, servedFrom: "absorbed_stale" };
      if (result) {
        served.add(pair.index);
        out[pair.index] = serve(
          source,
          levelUsed,
          kind,
          answers[pair.index]!,
          result,
          known.has(pair.question.identity),
        );
        restrictCacheLevel(levelUsed, ttl);
      } else if (reasonFor.has(pair.index))
        out[pair.index] = {
          ...answers[pair.index]!,
          reason: reasonFor.get(pair.index)!,
        };
    }
    return out;
  }

  return {
    async apply<T extends PassThroughAnswer>(
      kind: string,
      answers: T[],
      scope?: PassThroughScope,
    ): Promise<T[]> {
      if (!scope) return answers;
      const sources = deps.sources().filter((s) => s.kinds.includes(kind));
      if (!sources.length) return answers;
      // Each source reads the answers as the loaded files gave them, so an earlier source's
      // refusal reason never hides an answer from a later one. The first source to serve an
      // answer keeps it; otherwise the first refusal reason stays.
      const out = [...answers];
      const served = new Set<number>();
      const refused = new Set<number>();
      let changed = false;
      for (const source of sources) {
        const now = new Set<number>();
        let result: T[];
        try {
          result = await applySource(source, kind, answers, scope, served, now);
        } catch {
          // Optional answers must survive cache, budget, audit and storage failures.
          now.clear();
          result = answers.map((answer, index) => {
            if (served.has(index)) return answer;
            let question: Question | null = null;
            try {
              question = source.question(kind, answer);
            } catch {
              // Not a question this source can read.
            }
            const reason = reasonOf(source, "passthrough_unavailable");
            return question && reason && eligible(source, answer, question)
              ? { ...answer, reason }
              : answer;
          });
        }
        result.forEach((answer, index) => {
          if (served.has(index)) return;
          if (now.has(index)) served.add(index);
          else if (answer === answers[index] || refused.has(index)) return;
          else refused.add(index);
          out[index] = answer;
          changed = true;
        });
      }
      return changed ? out : answers;
    },
    async availability(id: string, db: SqlSession): Promise<unknown> {
      const source = deps.sources().find((s) => s.id === id);
      return source?.availability ? source.availability(db) : null;
    },
  };
}

/** Tables a dump leaves out for the registered pass-through sources, core tables first. */
export function passThroughExcludedTables(
  sources: readonly Source[],
): string[] {
  const tables = [...PASSTHROUGH_CORE_TABLES];
  for (const source of sources)
    if (source.storage && source.cache.excludeFromBackups !== false)
      tables.push(...source.storage.excludedTables);
  return [...new Set(tables)];
}

/** The operator's settings for one source, from `plugins[].sources[id]` in the config file. */
export interface OperatorSourcePolicy {
  cacheLevel?: CacheLevel;
  ttl?: string;
  staleWindow?: string;
  negativeTtl?: string;
}

/** A pass-through setting the core refuses when plugins load. */
export class PassThroughPolicyRefusal extends Error {
  constructor(
    readonly code: "passthrough_level_loosened",
    readonly sourceId: string,
  ) {
    super(`${code}: ${sourceId}`);
    this.name = "PassThroughPolicyRefusal";
  }
}

/** Every enabled plugin entry's `sources` settings by source id; a later entry wins. */
export function operatorSourcePolicies(config: {
  plugins: readonly {
    enabled: boolean;
    sources: Readonly<Record<string, OperatorSourcePolicy>>;
  }[];
}): Record<string, OperatorSourcePolicy> {
  const out: Record<string, OperatorSourcePolicy> = {};
  for (const entry of config.plugins)
    if (entry.enabled)
      for (const [id, policy] of Object.entries(entry.sources))
        out[id] = { ...out[id], ...policy };
  return out;
}

/**
 * The operator levels to pass to `configurePassThrough`. An operator may only tighten a
 * source's declared level (design 5.10.4); a looser level is refused, never ignored.
 */
export function operatorLevels(
  sources: readonly Source[],
  policies: Readonly<Record<string, OperatorSourcePolicy>>,
): Record<string, CacheLevel> {
  const levels: Record<string, CacheLevel> = {};
  for (const source of sources) {
    const wanted = policies[source.id]?.cacheLevel;
    if (!wanted) continue;
    if (strictestLevel(source.cache.level, wanted) !== wanted)
      throw new PassThroughPolicyRefusal(
        "passthrough_level_loosened",
        source.id,
      );
    levels[source.id] = wanted;
  }
  return levels;
}

/** What `configurePassThrough` takes from the operator's `plugins[].sources` settings. */
export interface OperatorPassThrough {
  operatorLevels: Record<string, CacheLevel>;
  operatorTtls: Record<string, OperatorTtl>;
}

/**
 * The operator's levels and `memory` TTLs for the registered sources. Both can only tighten: a
 * looser level, or a TTL longer than the declared one at `memory`, is refused with
 * `passthrough_level_loosened`. At `stored` the TTLs are record policy settings, which the worker
 * applies at start (`applyPassThroughPolicies`).
 */
export function operatorPassThrough(
  sources: readonly Source[],
  policies: Readonly<Record<string, OperatorSourcePolicy>>,
): OperatorPassThrough {
  const levels = operatorLevels(sources, policies);
  const ttls: Record<string, OperatorTtl> = {};
  for (const source of sources) {
    const policy = policies[source.id];
    if (strictestLevel(source.cache.level, levels[source.id]) !== "memory")
      continue;
    const own: OperatorTtl = {};
    for (const [field, outcome] of [
      ["ttl", "answer"],
      ["negativeTtl", "no_data"],
    ] as const) {
      const wanted = policy?.[field];
      if (wanted === undefined) continue;
      let seconds: number;
      try {
        seconds = intervalSeconds(wanted);
      } catch {
        throw new PassThroughPolicyRefusal(
          "passthrough_level_loosened",
          source.id,
        );
      }
      if (seconds > declaredMemoryTtl(source, outcome))
        throw new PassThroughPolicyRefusal(
          "passthrough_level_loosened",
          source.id,
        );
      own[field] = seconds;
    }
    if (Object.keys(own).length) ttls[source.id] = own;
  }
  return { operatorLevels: levels, operatorTtls: ttls };
}

/**
 * Applies the operator's policy settings for `stored` sources at worker start (design 5.10.4),
 * through the same code path as `worker record-policy`, which works in heap-block batches:
 * - a changed `ttl`, `staleWindow` or `negativeTtl` runs `record-policy set` for the source's
 *   record policy (`negativeTtl` for its no-data policy), which recomputes `expired_at`;
 * - a level tightened below `stored` runs `record-policy expire` for both policies while any
 *   absorbed row is still live. Rows are kept (expand/contract); the stricter level stops writes.
 * Returns the command lines it ran. A looser level is refused before anything runs.
 */
export async function applyPassThroughPolicies(
  db: Database,
  sources: readonly Source[],
  policies: Readonly<Record<string, OperatorSourcePolicy>>,
  output: { out(message: string): void; error(message: string): void },
): Promise<string[][]> {
  operatorLevels(sources, policies);
  // record-policy closes its connection; this one belongs to the caller.
  const borrowed = new Proxy(db, {
    get: (target, property, receiver) =>
      property === "close"
        ? async () => {}
        : (Reflect.get(target, property, receiver) as unknown),
  });
  const ran: string[][] = [];
  const run = async (args: string[]) => {
    ran.push(args);
    if ((await runRecordPolicy(args, () => borrowed, output)) !== 0)
      throw new Error(`worker record-policy ${args[0]} failed`);
  };
  const current = async (name: string) =>
    (
      await db.query<{ ttl: string | null; stale: string }>(
        "SELECT default_ttl::text AS ttl, stale_window::text AS stale FROM record_policy WHERE name=$1",
        [name],
      )
    ).rows[0];
  const same = async (a: string | null, b: string) =>
    a !== null &&
    (
      await db.query<{ same: boolean }>(
        "SELECT $1::interval = $2::interval AS same",
        [a, b],
      )
    ).rows[0]!.same;
  const live = async (name: string) => {
    for (const { table_name } of (
      await db.query<{ table_name: string }>(
        "SELECT table_name FROM row_provenance_rule ORDER BY table_name",
      )
    ).rows) {
      const table = `"${table_name.replaceAll('"', '""')}"`;
      const found = await db.query(
        `SELECT 1 FROM ${table} WHERE record_policy=$1 AND (expired_at IS NULL OR expired_at>now()) LIMIT 1`,
        [name],
      );
      if (found.rows.length) return true;
    }
    return false;
  };
  for (const source of sources) {
    const policy = policies[source.id];
    const names = source.cache.recordPolicy;
    if (!policy || !names || source.cache.level !== "stored") continue;
    const level = strictestLevel(source.cache.level, policy.cacheLevel);
    if (level !== "stored") {
      for (const name of new Set([names.name, names.noDataName ?? names.name]))
        if (await live(name)) await run(["expire", name]);
      continue;
    }
    const changes: [string, string | undefined, string | undefined][] = [
      [names.name, policy.ttl, policy.staleWindow],
    ];
    if (names.noDataName && names.noDataName !== names.name)
      changes.push([names.noDataName, policy.negativeTtl, undefined]);
    for (const [name, ttl, stale] of changes) {
      const row = await current(name);
      if (!row || (ttl === undefined && stale === undefined)) continue;
      const ttlChanged = ttl !== undefined && !(await same(row.ttl, ttl));
      const staleChanged =
        stale !== undefined && !(await same(row.stale, stale));
      if (!ttlChanged && !staleChanged) continue;
      await run([
        "set",
        name,
        "--ttl",
        ttl ?? row.ttl ?? "null",
        ...(stale === undefined ? [] : ["--stale", stale]),
      ]);
    }
  }
  return ran;
}

/** First-party sources the core loads itself, then the plugins' sources with other ids. */
export function passThroughSourcesOf(
  entries: readonly { spec: { kind: string; id: string } }[],
): readonly Source[] {
  const implicit = implicitPassThroughSources();
  const ids = new Set(implicit.map((source) => source.id));
  return [
    ...implicit,
    ...entries
      .map((entry) => entry.spec)
      .filter(
        (spec): spec is Source =>
          spec.kind === "passthrough" && !ids.has(spec.id),
      ),
  ];
}
const registered = (): readonly Source[] =>
  passThroughSourcesOf(currentRegistries().sources);
/** Ids of the pass-through sources this process serves. */
export function passThroughSourceIds(): string[] {
  return registered().map((source) => source.id);
}

let hostDeps: Omit<PassThroughDeps, "sources"> &
  Partial<Pick<PassThroughDeps, "sources">> = {};
let core = createPassThrough({ sources: registered });

/**
 * Host wiring: the shared cache, the event registry and the operator's levels. Sources default
 * to the pass-through sources in the active registries.
 */
export function configurePassThrough(
  deps: Omit<PassThroughDeps, "sources"> &
    Partial<Pick<PassThroughDeps, "sources">>,
): void {
  hostDeps = deps;
  core = createPassThrough({ sources: registered, ...deps });
}

/**
 * What a host sets at start: the operator's levels and TTLs from the loader, and the host's shared
 * cache and events. Other settings stay as they are.
 */
export function configureHostPassThrough(
  settings: OperatorPassThrough &
    Pick<PassThroughDeps, "cacheStore" | "events">,
): void {
  configurePassThrough({
    ...hostDeps,
    operatorLevels: settings.operatorLevels,
    operatorTtls: settings.operatorTtls,
    cacheStore: settings.cacheStore,
    events: settings.events,
  });
}

/** Test seam: the host settings in effect. */
export function passThroughHostSettings(): Readonly<
  Omit<PassThroughDeps, "sources"> & Partial<Pick<PassThroughDeps, "sources">>
> {
  return hostDeps;
}

/** `ctx.sources.passThrough`: the active registries' pass-through sources. */
export const passThrough: PassThroughApi = Object.freeze({
  apply: <T extends PassThroughAnswer>(
    kind: string,
    answers: T[],
    scope?: PassThroughScope,
  ) => core.apply(kind, answers, scope),
  availability: (id: string, db: SqlSession) => core.availability(id, db),
});

/** Test hook: a fresh core, forgetting per-client counts and budget-row memos. */
export function resetPassThrough(): void {
  lookups.clear();
  core = createPassThrough({ sources: registered, ...hostDeps });
}
