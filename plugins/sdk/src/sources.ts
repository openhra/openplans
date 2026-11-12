import { z } from "zod";
import type {
  AcquiredFile,
  AdmittedFetch,
  CacheLevel,
  PluginContext,
  SqlSession,
} from "./contracts.js";
import type { EventRegistry } from "./events.js";

/** What a feed source's hooks receive. There is no transport, key or database handle here. */
export interface FeedContext {
  source: FeedSource;
  /** The data cache directory (`OPENPLANS_DATA_DIR`). */
  dataDir: string;
  /**
   * Admitted fetch for the source's own hosts, through the run's one admission session. It works
   * only while `plan` runs, for discovery pages; the plan's files are fetched by the core.
   */
  fetch: AdmittedFetch;
  log: PluginContext["log"];
  events: EventRegistry;
}
export interface FeedPlan {
  files: {
    url: string;
    expectedContent: "csv" | "json" | "zip" | "xlsx" | "binary";
    maxBytes: number;
    expectedSha256?: string;
    /**
     * Where the core keeps the download. `"run"` (the default) stores it under this run's
     * snapshot id. `"content"` stores it under its SHA-256 and reuses an earlier copy of the same
     * URL without a request. Use it only for a URL that names one fixed release. When
     * `expectedSha256` names other content, the core skips the earlier copy and downloads.
     */
    cache?: "run" | "content";
  }[];
  /**
   * Tables that must hold at least one row from this run's snapshots before activation. Each must
   * also be in the `tables` that `stage` returns.
   */
  requireRows?: string[];
}
export interface FeedSource {
  kind: "feed";
  /** The `source.source_id` and the `sourced_by` value of every staged row. */
  id: string;
  publisher: string;
  /**
   * Exact hosts; every plan URL must be on one. Each must also be among the plugin's
   * `capabilities.network` hosts and be allowed in a loaded manifest, or the run stops before
   * `plan`.
   */
  hosts: string[];
  command: { argv: readonly string[]; usage: string; args: z.ZodType };
  plan(ctx: FeedContext, args: unknown): Promise<FeedPlan>;
  /** Parse the acquired files and write rows. Runs inside the core's one transaction. */
  stage(
    ctx: FeedContext,
    acquired: AcquiredFile[],
    tx: SqlSession,
  ): Promise<{ rows: number; tables: string[] }>;
  /** Plugin-level checks. The core adds its own readiness checks after these. */
  validate(
    ctx: FeedContext,
    tx: SqlSession,
  ): Promise<{ ok: true } | { ok: false; reasonCode: string }>;
  /** Runs just before the core marks this run's snapshots ACTIVE, in the same transaction. */
  beforeActivate?(
    ctx: FeedContext,
    tx: SqlSession,
    snapshotIds: string[],
  ): Promise<void>;
}

/** Feed source ids double as fetch cache directory names and snapshot id prefixes. */
export const FEED_SOURCE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
/** Reason codes end up in `quality_issue.issue_code` and in `snapshot.quarantined` events. */
export const FEED_REASON_CODE = /^[a-z][a-z0-9_]{0,63}$/;
/** A plain table name, optionally schema-qualified. */
export const FEED_TABLE_NAME =
  /^[a-z_][a-z0-9_]{0,62}(?:\.[a-z_][a-z0-9_]{0,62})?$/;

/** The shape the core accepts from `plan`. Plugins can use it in their own tests. */
export const feedPlanSchema = z.strictObject({
  files: z
    .array(
      z.strictObject({
        url: z.string().min(1).max(2048),
        expectedContent: z.enum(["csv", "json", "zip", "xlsx", "binary"]),
        maxBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
        expectedSha256: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .optional(),
        cache: z.enum(["run", "content"]).optional(),
      }),
    )
    .min(1)
    .max(1000),
  requireRows: z.array(z.string().regex(FEED_TABLE_NAME)).optional(),
});

/**
 * Reasons that mean OpenPlans has not sourced the publisher's files. Only an `unknown` answer
 * with one of these reasons can open a pass-through call; a source may narrow the list.
 */
export const PASSTHROUGH_OPENING_REASONS: readonly string[] = Object.freeze([
  "source_set_not_available",
  "source_access_denied",
  "source_set_not_validated",
  "source_set_not_active",
]);

/** The fields the core reads from an answer computed from loaded files. */
export interface PassThroughAnswer {
  status: string;
  reason?: string | null;
}
export interface Question {
  planId?: string;
  identity: string;
  year: number;
}
/**
 * What `mapResponse` makes of one question. `statement` is the source's own words and is kept
 * in provenance. An `answer` with `negative: true` is served only when the source confirms the
 * identity locally (`confirmIdentities`); otherwise the core treats it as `negative_unconfirmed`,
 * which always stays `unknown`.
 */
export type Mapped<Q, A> = (
  | {
      question: Q;
      outcome: "answer";
      answer: A;
      statement: string;
      negative?: boolean;
    }
  | {
      question: Q;
      outcome: "no_data";
      statement: string;
      /** What the source said besides "no data"; stored by a source's own `storage` only. */
      answer?: A;
    }
  | { question: Q; outcome: "negative_unconfirmed"; statement: string }
) & {
  /** 1-based position of the entry in the response body, for a source's own `storage`. */
  sourceRow?: number;
};
export type MappedOutcome = Mapped<unknown, unknown>["outcome"];
export interface AbsorbedRow<A> {
  identity: string;
  planId?: string;
  year: number;
  outcome: MappedOutcome;
  answer: A | null;
  negative?: boolean;
  statement: string;
  snapshotId: string;
  sourcedAt: string;
  freshness: "live" | "absorbed" | "absorbed_stale";
}
export interface PassThroughStorage<Q, A> {
  readAbsorbed(
    db: SqlSession,
    questions: Q[],
    kind: string,
  ): Promise<AbsorbedRow<A>[]>;
  writeAbsorbed(
    tx: SqlSession,
    rows: {
      question: Q;
      outcome: MappedOutcome;
      answer: A | null;
      negative?: boolean;
      statement: string;
      snapshotId: string;
      sourceRow?: number;
    }[],
    kind: string,
  ): Promise<void>;
  recordConflict(
    tx: SqlSession,
    rows: {
      question: Q;
      sourceAnswer: A | null;
      localStatus: string;
      /** The stored row's receipt, and the loaded-files answer it is checked against. */
      sourceSnapshotId?: string;
      local?: PassThroughAnswer & { snapshot_id?: string | null };
    }[],
    kind: string,
  ): Promise<void>;
  /** Tables whose data `worker backup-args` leaves out of dumps. */
  excludedTables: string[];
  /**
   * Every table these hooks write, budget row included; defaults to `excludedTables`. On a plugin
   * route's scoped writer the hooks may write these tables and nothing else. Tables the core's
   * migrations create never count.
   */
  tables?: string[];
  /**
   * Writes the receipt for one stored call and returns its snapshot id. Without it the core
   * writes a `passthrough-v1` receipt under the source's id.
   */
  receipt?(tx: SqlSession, call: PassThroughReceiptInput<Q>): Promise<string>;
  /** The question set's cache directory suffix. Default: a hash of kind, year and questions. */
  cacheKey?(kind: string, year: number, questions: Q[]): string;
  /** Call log rows in the source's own table instead of `passthrough_attempt`. */
  recordAttempt?(tx: SqlSession, attempt: PassThroughAttempt): Promise<void>;
  /** The source's own budget row instead of its `passthrough_budget` row. */
  budget?: PassThroughBudgetStore;
}
export interface PassThroughReceiptInput<Q> {
  kind: string;
  year: number;
  questions: Q[];
  url: string;
  status: number;
  contentType: string | null;
  bytes: number;
  sha256: string;
  rawPath: string;
}
export interface PassThroughAttempt {
  kind: string;
  level: CacheLevel;
  year: number;
  pairs: number;
  outcome: "absorbed" | "answered" | "empty" | "failed" | "refused";
  receipt: string | null;
  status: number | null;
  failure: string | null;
  /** Already in the source's own words (`reasons`). */
  refusal: string | null;
  latency: number | null;
}
/** A pause that one failure started: calls stay refused until `pausedUntil`. */
export interface PassThroughPause {
  pausedUntil: string | Date;
}
/**
 * A source-owned budget row. The core decides when to reserve, refuse, count a failure or end a
 * pause; the store owns the SQL. The core emits `passthrough.budget_exhausted` when `spent`
 * says so, and `passthrough.breaker_open` when `failed` returns a pause.
 */
export interface PassThroughBudgetStore {
  /** Spacing, daily cap and breaker in one atomic step. */
  reserve(db: SqlSession): Promise<"ok" | "budget" | "blocked">;
  /** The current daily allowance, for the per-client share. */
  dailyMax(db: SqlSession): Promise<number>;
  /**
   * True when today's allowance is used up. `reserve` also answers "budget" while calls are
   * spaced, so the core asks before it reports the budget as spent. Without it, no event.
   */
  spent?(db: SqlSession): Promise<boolean>;
  /**
   * A server-side failure, a timeout, an unreadable body, or a 401, 403 or 429 (`status`).
   * Returns the pause when this failure started one; nothing while a pause already runs.
   */
  failed(
    db: SqlSession,
    status: number | null,
  ): Promise<void | PassThroughPause>;
  /** A call that worked: ends a pause. */
  recovered(db: SqlSession): Promise<void>;
}
/** The core's reason codes, which a source may rename (`reasons`). */
export type PassThroughReason =
  | "passthrough_not_configured"
  | "passthrough_year_not_served"
  | "passthrough_request_cap"
  | "passthrough_client_share"
  | "passthrough_budget_exhausted"
  | "passthrough_unavailable"
  | "passthrough_not_available_read_only";
/** What the core hands a source's own `serve`. */
export interface PassThroughResult<A> {
  outcome: MappedOutcome;
  answer: A | null;
  negative: boolean;
  statement: string;
  snapshotId: string | null;
  sourcedAt: string;
  servedFrom: PassThroughServedFrom;
  level: CacheLevel;
  /** True when `confirmIdentities` knows the identity. */
  confirmed: boolean;
}
/** Where a served answer came from, as the evidence block reports it. */
export type PassThroughServedFrom =
  "live" | "absorbed" | "absorbed_stale" | "memory" | "request";
export interface PassThroughEvidence {
  source_id: string;
  level: CacheLevel;
  outcome: MappedOutcome;
  served_from: PassThroughServedFrom;
  /** The receipt id at `stored`; null at the other levels, which keep no receipt. */
  snapshot_id: string | null;
  /**
   * When the source answered. Not `sourced_at`: that name belongs to the row provenance columns,
   * which API responses leave out.
   */
  retrieved_at: string;
  statement: string;
  source?: string;
  terms_url?: string;
  limits?: string;
}
export interface PassThroughServed<A> {
  answer: A;
  evidence: PassThroughEvidence;
}
export interface PassThroughSource<Q extends Question, A> {
  kind: "passthrough";
  /** `source.source_id` and the `sourced_by` value of stored answers. */
  id: string;
  publisher?: string;
  /** The answer kinds this source can fill, the first argument of `apply`. */
  kinds: readonly string[];
  manifest: {
    host: string;
    accessMode: "public" | "api-key";
    apiKeyEnv?: string;
    permittedPaths: string[];
    /** Admit with the shipped manifests only, without the operator manifest. */
    shippedOnly?: boolean;
  };
  cache: {
    /** The declared level; operator configuration can only make it stricter. */
    level: CacheLevel;
    /** PostgreSQL interval, such as "10 minutes". `memory` only; stored rows use record policies. */
    ttl?: string;
    staleWindow?: string;
    negativeTtl?: string;
    maxEntries?: number;
    excludeFromBackups?: boolean;
    /**
     * Record policy names for stored answers, added by the plugin's migration. Required at
     * `stored` without `storage`; without them the source makes no call.
     */
    recordPolicy?: { name: string; noDataName?: string };
  };
  eligibility: {
    openingReasons: readonly string[];
    years?: number[];
    accepts(question: Q): boolean;
    /**
     * Questions the source cannot answer for a reason found in the database, checked after the
     * year and before any call. Returns one reason or null per question.
     */
    notServed?(db: SqlSession, questions: Q[]): Promise<(string | null)[]>;
  };
  /** The question an answer from loaded files asks, or null when this source cannot answer it. */
  question(kind: string, answer: PassThroughAnswer): Q | null;
  /** Identities known locally, for answers marked `negative`. */
  confirmIdentities?(
    db: SqlSession,
    kind: string,
    identities: string[],
  ): Promise<Set<string>>;
  batch: {
    maxQuestionsPerCall: number;
    maxCallsPerRequest: number;
    /** Plans x identities rectangles, every cell a question (the CMS API's call shape). */
    grid?: { maxPlans: number; maxIdentities: number };
  };
  budget: {
    dailyMax: number;
    minIntervalMs: number;
    clientShare: number;
    breaker: { failures: number; windowMs: number; pauseMs: number };
  };
  buildRequest(
    questions: Q[],
    kind: string,
  ): { path: string; query: Record<string, string> };
  mapResponse(body: unknown, questions: Q[], kind: string): Mapped<Q, A>[];
  /** Folds a served answer into the loaded-files answer. Default: copy the answer's fields. */
  fold?<T extends PassThroughAnswer>(
    kind: string,
    answer: T,
    served: PassThroughServed<A>,
  ): T;
  /** Attribution for the evidence block. */
  evidence?: {
    /** Property name of the evidence block on the answer; default "passthrough". */
    key?: string;
    source: string;
    termsUrl: string;
    limits?(kind: string): string;
  };
  /** stored level only: the plugin's tables. Omit to use the core's generic tables. */
  storage?: PassThroughStorage<Q, A>;
  /**
   * The source's own names for the core's reason codes. `null` leaves the answer's reason as
   * it was (for read-only scopes).
   */
  reasons?: Partial<Record<PassThroughReason, string | null>>;
  /**
   * Builds the served answer itself, evidence block included, instead of the core's evidence
   * block and `fold`. It must keep an unconfirmed negative `unknown`.
   */
  serve?<T extends PassThroughAnswer>(
    kind: string,
    answer: T,
    result: PassThroughResult<A>,
  ): T;
  /** Counts for `/v1/data-availability`; null when the source has nothing to report. */
  availability?(db: SqlSession): Promise<unknown>;
}
/**
 * One inbound request. Without `writer` (read-only scopes such as MCP tools) no call is made:
 * stored rows and `memory` entries are served, nothing else.
 */
export interface PassThroughScope {
  reader: SqlSession;
  writer?: SqlSession;
  /** The inbound client as the rate limiter names it; held in memory only. */
  client?: string;
}
export interface PassThroughApi {
  /**
   * Fills `unknown` answers from registered pass-through sources. With no source registered for
   * `kind`, or without a scope, it returns `answers` itself.
   */
  apply<T extends PassThroughAnswer>(
    kind: string,
    answers: T[],
    scope?: PassThroughScope,
  ): Promise<T[]>;
  /** The registered source's `availability`, or null when it is not registered. */
  availability(id: string, db: SqlSession): Promise<unknown>;
}
export interface SourceRegistry {
  add(source: FeedSource): void;
  add<Q extends Question, A>(source: PassThroughSource<Q, A>): void;
  readonly passThrough: PassThroughApi;
}
