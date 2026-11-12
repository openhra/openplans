import { z } from "zod";
import { eventPayloadSchemas } from "@openplans/plugin-sdk";
import type { PassthroughRow, StatusData } from "./read.js";

/** Age buckets for the public view. `unknown` means there is no record to measure. */
export const AGE_BUCKETS = ["<1d", "<7d", "<30d", "older", "unknown"] as const;
export type AgeBucket = (typeof AGE_BUCKETS)[number];

const DAY_MS = 86_400_000;

export function ageBucket(at: Date | null, now: Date): AgeBucket {
  if (!at) return "unknown";
  const age = now.getTime() - at.getTime();
  if (age < DAY_MS) return "<1d";
  if (age < 7 * DAY_MS) return "<7d";
  if (age < 30 * DAY_MS) return "<30d";
  return "older";
}

export const AVAILABILITY_STATUSES = [
  "not_yet_verified",
  "available",
  "partial",
  "unknown",
  "unavailable",
  "unsupported",
  "stale",
  "conflicted",
] as const;
export const AVAILABILITY_KINDS = [
  "catalog",
  "premium",
  "provider",
  "formulary",
] as const;

const count = z.number().int().nonnegative();
const bucket = z.enum(AGE_BUCKETS);
const upDown = z.enum(["ok", "down"]);
const health = z.enum(["ok", "degraded", "down"]);
const availabilityStatus = z.enum(AVAILABILITY_STATUSES);
const time = z.iso.datetime({ offset: true });
const statusCounts = z.strictObject(
  Object.fromEntries(
    AVAILABILITY_KINDS.map((kind) => [
      kind,
      z.strictObject(
        Object.fromEntries(
          AVAILABILITY_STATUSES.map((status) => [status, count]),
        ) as Record<(typeof AVAILABILITY_STATUSES)[number], typeof count>,
      ),
    ]),
  ) as Record<
    (typeof AVAILABILITY_KINDS)[number],
    z.ZodObject<
      Record<(typeof AVAILABILITY_STATUSES)[number], typeof count>,
      z.core.$strict
    >
  >,
);
const cacheLevel = z.enum(["none", "request", "memory", "stored", "unknown"]);

const publicData = z.strictObject({
  states: count.nullable(),
  years: z.array(z.number().int()).nullable(),
  status_counts: statusCounts.nullable(),
});
const publicSource = z.strictObject({ id: z.string(), freshness: bucket });
const publicIngest = z.strictObject({
  source: z.string(),
  last_success: bucket,
});
const publicPassthrough = z.strictObject({
  id: z.string(),
  enabled: z.boolean().nullable(),
  budget: z.enum(["ok", "exhausted", "unknown"]),
  level: cacheLevel,
});

/** Design 5.11, public column. Everything here is safe for anyone to read. */
export const publicStatusSchema = z.strictObject({
  version: z.string(),
  api: upDown,
  db: upDown,
  data: publicData,
  sources: z.array(publicSource).nullable(),
  worker: z.strictObject({ last_ingest: z.array(publicIngest).nullable() }),
  cache: z.strictObject({ enabled: z.boolean() }),
  passthrough: z.array(publicPassthrough).nullable(),
  plugins: count,
  health_transitions: z.strictObject({ last_change: bucket }),
});
export type PublicStatus = z.infer<typeof publicStatusSchema>;

// Event payloads keep their catalog shape, so the payload scanner can inspect them.
const eventPayload = z.union(
  Object.values(eventPayloadSchemas) as unknown as [z.ZodType, z.ZodType],
);

/** Design 5.11, operator column. Served only behind the operator token. */
export const operatorStatusSchema = z.strictObject({
  version: z.string(),
  api: upDown,
  db: upDown,
  pool: z.strictObject({ waiting: count.nullable() }),
  data: publicData.extend({
    issuers: z
      .array(
        z.strictObject({
          state: z.string(),
          year: z.number().int(),
          market: z.string().nullable(),
          issuer_id: z.string().nullable(),
          catalog: availabilityStatus,
          premium: availabilityStatus,
          provider: availabilityStatus,
          formulary: availabilityStatus,
          snapshot_id: z.string().nullable(),
        }),
      )
      .nullable(),
  }),
  sources: z
    .array(
      publicSource.extend({
        retrieved_at: time.nullable(),
        snapshot_id: z.string(),
      }),
    )
    .nullable(),
  worker: z.strictObject({
    last_ingest: z
      .array(
        publicIngest.extend({
          last_success_at: time.nullable(),
          reason_codes: z.array(z.string()),
          durations_ms: z.array(count),
        }),
      )
      .nullable(),
  }),
  cache: z.strictObject({
    enabled: z.boolean(),
    backend: z.string(),
    hits: count.nullable(),
    misses: count.nullable(),
    bypasses: count.nullable(),
    bytes: count.nullable(),
  }),
  passthrough: z
    .array(
      publicPassthrough.extend({
        daily_requests: count,
        max_daily_requests: count,
        blocked_until: time.nullable(),
        hit_rate: z.number().min(0).max(1).nullable(),
      }),
    )
    .nullable(),
  plugins: z.array(
    z.strictObject({
      name: z.string(),
      version: z.string().nullable(),
      apiVersion: z.string().nullable(),
      sha256: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .nullable(),
      enabled: z.boolean(),
    }),
  ),
  events: z.strictObject({
    recent: z
      .array(
        z.strictObject({
          type: z.string(),
          time,
          payload: eventPayload.nullable(),
        }),
      )
      .nullable(),
  }),
  health_transitions: z.strictObject({
    last_change: bucket,
    history: z
      .array(
        z.strictObject({
          component: z.enum(["api", "db", "cache", "worker"]),
          from: health,
          to: health,
          at: time,
        }),
      )
      .nullable(),
  }),
});
export type OperatorStatus = z.infer<typeof operatorStatusSchema>;

const iso = (at: Date | null) => (at ? at.toISOString() : null);

function data(status: StatusData) {
  const rows = status.availability;
  if (!rows) return { states: null, years: null, status_counts: null };
  const counts = Object.fromEntries(
    AVAILABILITY_KINDS.map((kind) => [
      kind,
      Object.fromEntries(AVAILABILITY_STATUSES.map((s) => [s, 0])),
    ]),
  ) as PublicStatus["data"]["status_counts"] & object;
  for (const row of rows)
    for (const kind of AVAILABILITY_KINDS) counts[kind][row[kind]] += 1;
  return {
    states: new Set(rows.map((row) => row.state)).size,
    years: [...new Set(rows.map((row) => row.year))].sort((a, b) => a - b),
    status_counts: counts,
  };
}

function budget(row: PassthroughRow) {
  if (row.exhausted === null) return "unknown" as const;
  return row.exhausted ? ("exhausted" as const) : ("ok" as const);
}

/** The public serialiser. It names each field it copies; nothing else reaches the output. */
export function publicView(status: StatusData): PublicStatus {
  return {
    version: status.version ?? "unknown",
    api: "ok",
    db: status.db,
    data: data(status),
    sources:
      status.sources?.map((source) => ({
        id: source.id,
        freshness: ageBucket(source.retrieved, status.now),
      })) ?? null,
    worker: {
      last_ingest:
        status.ingests?.map((ingest) => ({
          source: ingest.source,
          last_success: ageBucket(ingest.lastSuccess, status.now),
        })) ?? null,
    },
    cache: { enabled: status.cache.enabled },
    passthrough:
      status.passthrough?.map((row) => ({
        id: row.id,
        enabled: row.enabled,
        budget: budget(row),
        level: row.level,
      })) ?? null,
    plugins: status.plugins.length,
    health_transitions: {
      last_change: ageBucket(status.health?.lastChange ?? null, status.now),
    },
  };
}

/** The operator serialiser: the public fields plus the detail in design 5.11. */
export function operatorView(status: StatusData): OperatorStatus {
  const summary = publicView(status);
  return {
    version: summary.version,
    api: summary.api,
    db: summary.db,
    pool: { waiting: status.poolWaiting },
    data: {
      ...summary.data,
      issuers:
        status.availability?.map((row) => ({
          state: row.state,
          year: row.year,
          market: row.market,
          issuer_id: row.issuer_id,
          catalog: row.catalog,
          premium: row.premium,
          provider: row.provider,
          formulary: row.formulary,
          snapshot_id: row.snapshot_id,
        })) ?? null,
    },
    sources:
      status.sources?.map((source) => ({
        id: source.id,
        freshness: ageBucket(source.retrieved, status.now),
        retrieved_at: iso(source.retrieved),
        snapshot_id: source.snapshotId,
      })) ?? null,
    worker: {
      last_ingest:
        status.ingests?.map((ingest) => ({
          source: ingest.source,
          last_success: ageBucket(ingest.lastSuccess, status.now),
          last_success_at: iso(ingest.lastSuccess),
          reason_codes: ingest.reasonCodes,
          durations_ms: ingest.durationsMs,
        })) ?? null,
    },
    cache: {
      enabled: status.cache.enabled,
      backend: status.cache.backend,
      hits: status.cache.stats?.hits ?? null,
      misses: status.cache.stats?.misses ?? null,
      bypasses: status.cache.stats?.bypasses ?? null,
      bytes: status.cache.stats?.bytes ?? null,
    },
    passthrough:
      status.passthrough?.map((row) => ({
        id: row.id,
        enabled: row.enabled,
        budget: budget(row),
        level: row.level,
        daily_requests: row.dailyRequests,
        max_daily_requests: row.maxDailyRequests,
        blocked_until: iso(row.blockedUntil),
        hit_rate: row.hitRate,
      })) ?? null,
    plugins: status.plugins.map((plugin) => ({
      name: plugin.name,
      version: plugin.version,
      apiVersion: plugin.apiVersion,
      sha256: plugin.sha256,
      enabled: plugin.enabled,
    })),
    events: {
      recent:
        status.events?.map((event) => ({
          type: event.type,
          time: event.time.toISOString(),
          payload: event.payload,
        })) ?? null,
    },
    health_transitions: {
      last_change: summary.health_transitions.last_change,
      history:
        status.health?.history.map((entry) => ({
          component: entry.component,
          from: entry.from,
          to: entry.to,
          at: entry.at,
        })) ?? null,
    },
  };
}
