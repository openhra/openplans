import { createHash } from "node:crypto";
import type { Event, EventInput, EventType } from "@openplans/plugin-sdk";
import type { Database, SqlSession } from "../db/database.js";
import { createEventBus, EventRefusedError } from "../plugins/events.js";
import type { Subscription } from "../plugins/events.js";
import { CORE_KEY_PREFIX } from "../plugins/state.js";
import type { WorkerOutput } from "./commands.js";
import { databaseErrorDiagnostic } from "./database-error.js";

/** Design 5.9: a durable subscriber registered in this worker. */
export interface DurableSubscriber {
  readonly plugin: string;
  readonly type: EventType;
  readonly subscriber: string;
  readonly handler: (event: Event) => Promise<void>;
}

export const MAX_ATTEMPTS = 20;
export const MAX_BACKOFF_SECONDS = 3_600;
export const RETENTION_DAYS = 30;
export const HANDLER_LIMIT_MS = 30_000;
/** Deliveries per run, so one run fits inside its schedule's minute. */
export const DELIVERIES_PER_RUN = 1_000;
/** The deliverer's database opens with this query timeout. */
export const DELIVERY_QUERY_TIMEOUT_MS = 60_000;

export type DeliveryErrorCode =
  "handler_failed" | "handler_timeout" | "gave_up";

export interface DeliveryOptions {
  now?: () => Date;
  /** A number in [0, 1); scales the jitter. */
  random?: () => number;
  handlerTimeoutMs?: number;
  limit?: number;
  signal?: AbortSignal;
  log?: (entry: Record<string, string | number | boolean | null>) => void;
}

export interface DeliveryReport {
  fanned_out: number;
  delivered: number;
  retried: number;
  gave_up: number;
  deleted: number;
}

/**
 * Seconds `min(2^attempts, 3600)` plus up to a tenth of that again as jitter, in milliseconds.
 * `attempts` counts the failed attempt just made.
 */
export function backoffMs(attempts: number, random: () => number): number {
  const base = Math.min(2 ** attempts, MAX_BACKOFF_SECONDS) * 1_000;
  const share = Math.min(Math.max(random(), 0), 1);
  return base + Math.floor(base * 0.1 * share);
}

/** The `plugin_state` key that records when this worker first saw a subscription. */
export function installKey(subscriber: DurableSubscriber): string {
  return `${CORE_KEY_PREFIX}subscriber:${subscriber.subscriber}:${subscriber.type}`;
}

interface DueRow extends Record<string, unknown> {
  event_id: string;
  subscriber: string;
  attempts: number;
  event_type: string;
  idempotency_key: string;
  emitted_by: string;
  emitted_at: Date | string;
  payload: unknown;
}

/** Rows another deliverer holds are skipped, not waited for and never selected twice. */
const LOCK_DUE = "FOR UPDATE OF d SKIP LOCKED";
/** One due delivery, locked for this transaction. */
const SELECT_DUE = `SELECT d.event_id, d.subscriber, d.attempts, o.event_type, o.idempotency_key,
       o.emitted_by, o.emitted_at, o.payload
  FROM plugin_event_delivery d
  JOIN plugin_event_outbox o ON o.event_id = d.event_id
 WHERE d.delivered_at IS NULL
   AND d.last_error_code IS DISTINCT FROM 'gave_up'
   AND d.next_attempt_at <= $1::timestamptz
   AND (o.event_type, d.subscriber) IN (
     SELECT * FROM unnest($2::text[], $3::text[]))
 ORDER BY d.next_attempt_at, d.event_id, d.subscriber
 LIMIT 1
 ${LOCK_DUE}`;

async function install(
  db: Database,
  subscribers: readonly DurableSubscriber[],
  now: Date,
): Promise<string[]> {
  const installedAt: string[] = [];
  for (const entry of subscribers) {
    const key = installKey(entry);
    await db.query(
      `INSERT INTO plugin_state (plugin, key, value)
       VALUES ($1, $2, jsonb_build_object('installedAt', $3::text))
       ON CONFLICT (plugin, key) DO NOTHING`,
      [entry.plugin, key, now.toISOString()],
    );
    const { rows } = await db.query<{ installed_at: string }>(
      "SELECT value->>'installedAt' AS installed_at FROM plugin_state WHERE plugin = $1 AND key = $2",
      [entry.plugin, key],
    );
    installedAt.push(rows[0]?.installed_at ?? now.toISOString());
  }
  return installedAt;
}

/**
 * Fan-out at delivery: an outbox row with no delivery rows gets one per matching subscriber that
 * was installed when the event was emitted. Rows that already have deliveries are left alone.
 */
async function fanOut(
  db: Database,
  subscribers: readonly DurableSubscriber[],
  installedAt: readonly string[],
  now: Date,
): Promise<number> {
  const { rows } = await db.query<{ fanned: number }>(
    `WITH inserted AS (
       INSERT INTO plugin_event_delivery (event_id, subscriber, next_attempt_at)
       SELECT o.event_id, s.subscriber, $4::timestamptz
         FROM plugin_event_outbox o
         JOIN unnest($1::text[], $2::text[], $3::timestamptz[])
              AS s(event_type, subscriber, installed_at)
           ON s.event_type = o.event_type AND o.emitted_at >= s.installed_at
        WHERE NOT EXISTS (
          SELECT 1 FROM plugin_event_delivery d WHERE d.event_id = o.event_id)
       ON CONFLICT DO NOTHING
       RETURNING 1)
     SELECT count(*)::int AS fanned FROM inserted`,
    [
      subscribers.map(({ type }) => type),
      subscribers.map(({ subscriber }) => subscriber),
      [...installedAt],
      now.toISOString(),
    ],
  );
  return rows[0]?.fanned ?? 0;
}

type Outcome =
  { ok: true } | { ok: false; code: DeliveryErrorCode; errorClass: string };

function errorClass(error: unknown): string {
  const name = error instanceof Error ? error.constructor.name : "";
  return /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name) ? name : "Error";
}

async function call(
  handler: DurableSubscriber["handler"],
  event: Event,
  limitMs: number,
): Promise<Outcome> {
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<Outcome>((resolve) => {
    timer = setTimeout(
      () =>
        resolve({ ok: false, code: "handler_timeout", errorClass: "Timeout" }),
      limitMs,
    );
    timer.unref?.();
  });
  try {
    return await Promise.race([
      Promise.resolve()
        .then(() => handler(structuredClone(event)))
        .then(
          (): Outcome => ({ ok: true }),
          (error: unknown): Outcome => ({
            ok: false,
            code: "handler_failed",
            errorClass: errorClass(error),
          }),
        ),
      limit,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function record(
  session: SqlSession,
  row: DueRow,
  outcome: Outcome,
  now: Date,
  random: () => number,
): Promise<"delivered" | "retried" | "gave_up"> {
  const attempts = row.attempts + 1;
  if (outcome.ok) {
    await session.query(
      `UPDATE plugin_event_delivery
          SET delivered_at = $3::timestamptz, attempts = $4, last_error_code = NULL
        WHERE event_id = $1 AND subscriber = $2`,
      [row.event_id, row.subscriber, now.toISOString(), attempts],
    );
    return "delivered";
  }
  const gaveUp = attempts >= MAX_ATTEMPTS;
  const next = new Date(now.getTime() + backoffMs(attempts, random));
  await session.query(
    `UPDATE plugin_event_delivery
        SET attempts = $3, next_attempt_at = $4::timestamptz, last_error_code = $5
      WHERE event_id = $1 AND subscriber = $2`,
    [
      row.event_id,
      row.subscriber,
      attempts,
      next.toISOString(),
      gaveUp ? "gave_up" : outcome.code,
    ],
  );
  return gaveUp ? "gave_up" : "retried";
}

/**
 * `worker deliver-events`, design 5.9. Records installs, fans out, then delivers one locked row
 * per transaction until nothing is due, the per-run limit is reached or the signal aborts. Last,
 * it deletes outbox rows older than 30 days whose deliveries all succeeded. Payloads are never
 * logged.
 */
export async function deliverEvents(
  db: Database,
  subscribers: readonly DurableSubscriber[],
  options: DeliveryOptions = {},
): Promise<DeliveryReport> {
  const clock = options.now ?? (() => new Date());
  const random = options.random ?? Math.random;
  const limitMs = options.handlerTimeoutMs ?? HANDLER_LIMIT_MS;
  const limit = options.limit ?? DELIVERIES_PER_RUN;
  const log = options.log ?? (() => {});
  const report: DeliveryReport = {
    fanned_out: 0,
    delivered: 0,
    retried: 0,
    gave_up: 0,
    deleted: 0,
  };
  if (subscribers.length > 0) {
    const installedAt = await install(db, subscribers, clock());
    report.fanned_out = await fanOut(db, subscribers, installedAt, clock());
  }
  const types = subscribers.map(({ type }) => type);
  const names = subscribers.map(({ subscriber }) => subscriber);
  for (let count = 0; subscribers.length > 0 && count < limit; count += 1) {
    if (options.signal?.aborted) break;
    const result = await db.transaction(async (session) => {
      const now = clock();
      const { rows } = await session.query<DueRow>(SELECT_DUE, [
        now.toISOString(),
        types,
        names,
      ]);
      const row = rows[0];
      if (!row) return undefined;
      const entry = subscribers.find(
        (candidate) =>
          candidate.type === row.event_type &&
          candidate.subscriber === row.subscriber,
      )!;
      const emittedAt =
        row.emitted_at instanceof Date
          ? row.emitted_at.toISOString()
          : new Date(row.emitted_at).toISOString();
      const event = {
        id: row.event_id,
        type: row.event_type,
        emittedAt,
        emittedBy: row.emitted_by,
        idempotencyKey: row.idempotency_key,
        payload: row.payload,
      } as Event;
      const outcome = await call(entry.handler, event, limitMs);
      const state = await record(session, row, outcome, clock(), random);
      if (!outcome.ok)
        log({
          event: state === "gave_up" ? "delivery_gave_up" : "delivery_failed",
          event_type: row.event_type,
          subscriber: row.subscriber,
          attempts: row.attempts + 1,
          error_code: outcome.code,
          error_class: outcome.errorClass,
        });
      return state;
    });
    if (result === undefined) break;
    report[result] += 1;
  }
  const { rows } = await db.query<{ deleted: number }>(
    `WITH removed AS (
       DELETE FROM plugin_event_outbox o
        WHERE o.emitted_at < $1::timestamptz - make_interval(days => $2)
          AND NOT EXISTS (
            SELECT 1 FROM plugin_event_delivery d
             WHERE d.event_id = o.event_id AND d.delivered_at IS NULL)
       RETURNING 1)
     SELECT count(*)::int AS deleted FROM removed`,
    [clock().toISOString(), RETENTION_DAYS],
  );
  report.deleted = rows[0]?.deleted ?? 0;
  return report;
}

/** The core command: no arguments, one JSON line of counts on success. */
export async function runDeliverEvents(
  args: string[],
  open: () => Database,
  output: WorkerOutput,
  subscribers: readonly DurableSubscriber[],
  signal?: AbortSignal,
): Promise<number> {
  if (args.length !== 0) {
    output.error("Usage: worker deliver-events");
    return 1;
  }
  let db: Database | undefined;
  let code = 0;
  try {
    db = open();
    const report = await deliverEvents(db, subscribers, {
      signal,
      log: (entry) => output.error(JSON.stringify(entry)),
    });
    output.out(JSON.stringify(report));
  } catch (error) {
    output.error(
      `worker deliver-events failed${databaseErrorDiagnostic(error)}; run worker migrate first and check the database`,
    );
    code = 1;
  } finally {
    try {
      await db?.close();
    } catch {
      output.error("worker database shutdown failed");
      code = 1;
    }
  }
  return code;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [
          key,
          canonical((value as Record<string, unknown>)[key]),
        ]),
    );
  return value;
}

/** Without `--idempotency-key`, the same type and payload always give the same key. */
export function defaultIdempotencyKey(type: string, payload: unknown): string {
  return `${type}:${createHash("sha256")
    .update(JSON.stringify(canonical(payload)))
    .digest("hex")}`;
}

const EMIT_USAGE =
  "Usage: worker emit TYPE --payload JSON [--idempotency-key KEY]";

/**
 * `worker emit <type> --payload <json>`: validate against the catalog and write one outbox row as
 * `emittedBy: "worker"`. A repeated key keeps the first row. Payload values are never printed.
 */
export async function runEmit(
  args: string[],
  open: () => Database,
  output: WorkerOutput,
  subscriptions: readonly Subscription[] = [],
): Promise<number> {
  const [type, ...rest] = args;
  let payloadText: string | undefined;
  let key: string | undefined;
  let bad = false;
  for (let i = 0; i < rest.length; i += 2) {
    const value = rest[i + 1];
    if (
      rest[i] === "--payload" &&
      payloadText === undefined &&
      value !== undefined
    )
      payloadText = value;
    else if (
      rest[i] === "--idempotency-key" &&
      key === undefined &&
      value !== undefined &&
      value !== ""
    )
      key = value;
    else bad = true;
  }
  if (bad || !type || type.startsWith("-") || payloadText === undefined) {
    output.error(EMIT_USAGE);
    return 1;
  }
  let payload: unknown;
  try {
    payload = JSON.parse(payloadText);
  } catch {
    output.error("worker emit: --payload is not JSON");
    return 1;
  }
  let db: Database | undefined;
  let code = 0;
  let failed = false;
  try {
    db = open();
    const bus = createEventBus({
      db,
      subscriptions,
      log: (entry) => {
        if (entry.event === "outbox_insert_failed") failed = true;
        output.error(JSON.stringify(entry));
      },
    });
    const idempotencyKey = key ?? defaultIdempotencyKey(type, payload);
    await bus
      .registry({ kind: "core", name: "worker" })
      .emit({ type, idempotencyKey, payload } as EventInput);
    if (failed) code = 1;
    else output.out(JSON.stringify({ type, idempotency_key: idempotencyKey }));
  } catch (error) {
    if (error instanceof EventRefusedError)
      output.error(`worker emit refused: ${error.message}`);
    else
      output.error(
        `worker emit failed${databaseErrorDiagnostic(error)}; run worker migrate first and check the database`,
      );
    code = 1;
  } finally {
    try {
      await db?.close();
    } catch {
      output.error("worker database shutdown failed");
      code = 1;
    }
  }
  return code;
}
