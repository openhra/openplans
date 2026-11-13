import { z } from "zod";
import type { SqlSession } from "./contracts.js";

const count = z.number().int().nonnegative();
const health = z.enum(["ok", "degraded", "down"]);

export const eventPayloadSchemas = {
  "release.deployed": z.strictObject({
    version: z.string(),
    imageId: z.string(),
    previousVersion: z.string().nullable(),
  }),
  // An operator's hard-release rollback: the version and image the pin went back to, and the
  // version it left.
  "release.rolled_back": z.strictObject({
    version: z.string(),
    imageId: z.string(),
    fromVersion: z.string(),
  }),
  "snapshot.activated": z.strictObject({
    sourceId: z.string(),
    snapshotId: z.string(),
    // null: the row count is unknown. An unknown count is never reported as 0.
    rows: count.nullable(),
  }),
  "snapshot.quarantined": z.strictObject({
    sourceId: z.string(),
    snapshotId: z.string(),
    reasonCode: z.string(),
  }),
  "ingest.started": z.strictObject({
    sourceId: z.string(),
    command: z.array(z.string()),
    scope: z.strictObject({
      state: z.string().optional(),
      year: z.number().int().optional(),
    }),
  }),
  "ingest.completed": z.strictObject({
    sourceId: z.string(),
    command: z.array(z.string()),
    durationMs: count,
    snapshotIds: z.array(z.string()),
  }),
  "ingest.failed": z.strictObject({
    sourceId: z.string(),
    command: z.array(z.string()),
    reasonCode: z.string(),
  }),
  "readiness.failed": z.strictObject({
    check: z.string(),
    reasonCode: z.string(),
  }),
  "audit.failed": z.strictObject({ step: z.string(), reasonCode: z.string() }),
  "passthrough.budget_exhausted": z.strictObject({
    sourceId: z.string(),
    dailyMax: count,
  }),
  "passthrough.breaker_open": z.strictObject({
    sourceId: z.string(),
    untilAt: z.iso.datetime({ offset: true }),
  }),
  "cache.flushed": z.strictObject({
    reason: z.enum(["generation", "operator"]),
  }),
  "health.changed": z.strictObject({
    component: z.enum(["api", "db", "cache", "worker"]),
    from: health,
    to: health,
  }),
  "record_policy.changed": z.strictObject({
    policy: z.string(),
    ttl: z.string().nullable(),
    staleWindow: z.string(),
  }),
  "plugin.loaded": z.strictObject({
    plugins: z.array(z.strictObject({ name: z.string(), version: z.string() })),
  }),
} as const;

export type EventPayloads = {
  [T in keyof typeof eventPayloadSchemas]: z.infer<
    (typeof eventPayloadSchemas)[T]
  >;
};
export type EventType = keyof EventPayloads;

/** A union keeps each event type paired with its payload. */
export type Event<T extends EventType = EventType> = {
  [K in T]: {
    id: string;
    type: K;
    emittedAt: string;
    emittedBy: string;
    idempotencyKey: string;
    payload: EventPayloads[K];
  };
}[T];
export type EventInput<T extends EventType = EventType> = {
  [K in T]: Omit<Event<K>, "id" | "emittedAt" | "emittedBy">;
}[T];

export interface EmitOptions {
  /** The caller's open transaction. The outbox row commits or rolls back with it. */
  session?: SqlSession;
}

export interface EventRegistry {
  on<T extends EventType>(
    type: T,
    handler: (event: Event<T>) => Promise<void>,
    options: { durable: boolean; subscriber: string },
  ): void;
  /** Plugins need `capabilities.writes` to include "events". */
  emit<T extends EventType>(
    event: EventInput<T>,
    options?: EmitOptions,
  ): Promise<void>;
}
