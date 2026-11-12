import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { eventPayloadSchemas } from "@openplans/plugin-sdk";
import type {
  Database,
  EmitOptions,
  Event,
  EventInput,
  EventRegistry,
  EventType,
  PluginManifest,
  SqlSession,
} from "@openplans/plugin-sdk";

/** No in-process handler may hold an emitter longer than this. */
export const HANDLER_TIMEOUT_MS = 2_000;

export type EventLog = (
  entry: Record<string, string | number | boolean | null>,
) => void;

export type EventRefusal =
  | "invalid_envelope"
  | "unknown_event_type"
  | "invalid_payload"
  | "missing_capability"
  | "invalid_subscription";

/** A refused emit or subscription. The message names the reason, never payload values. */
export class EventRefusedError extends Error {
  constructor(
    readonly code: EventRefusal,
    detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = "EventRefusedError";
  }
}

/** Who emits: the API or worker process, or a named plugin. */
export type Emitter =
  | { kind: "core"; name: "api" | "worker" }
  | { kind: "plugin"; manifest: Pick<PluginManifest, "name" | "capabilities"> };

export interface Subscription {
  type: EventType;
  subscriber: string;
  durable: boolean;
  handler: (event: Event) => Promise<void>;
}

export interface EventBusOptions {
  db: Database;
  log?: EventLog;
  timeoutMs?: number;
  now?: () => Date;
  newId?: () => string;
  /** Subscriptions staged while plugins loaded, in configuration order. */
  subscriptions?: readonly Subscription[];
}

export interface EventBus {
  /** The registry handed to one emitter; plugins get theirs with their manifest. */
  registry(emitter: Emitter): EventRegistry;
  /** Run `db.transaction`; every emit inside it writes its outbox row in that transaction. */
  transaction<T>(run: (session: SqlSession) => Promise<T>): Promise<T>;
  /** Durable subscribers for delivery. The bus never calls them itself. */
  durableSubscribers(): readonly Subscription[];
}

const sessions = new AsyncLocalStorage<SqlSession>();

/** Carry an open transaction so emits made inside `run` write their outbox row in it. */
export function withEventSession<T>(
  session: SqlSession,
  run: () => Promise<T>,
): Promise<T> {
  return sessions.run(session, run);
}

const subscriberName = /^[@a-z0-9][a-z0-9/._:-]{0,127}$/;
const idempotencyKeyLimit = 512;

function defaultLog(
  entry: Record<string, string | number | boolean | null>,
): void {
  console.error(JSON.stringify(entry));
}

function errorClass(error: unknown): string {
  const name = error instanceof Error ? error.constructor.name : "";
  return /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name) ? name : "Error";
}

function emitterName(emitter: Emitter): string {
  return emitter.kind === "core" ? emitter.name : emitter.manifest.name;
}

/** Validate the envelope and the payload, refusing unknown keys at either level. */
function validate(input: unknown): EventInput {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new EventRefusedError("invalid_envelope", "event must be an object");
  const envelope = input as Record<string, unknown>;
  const extra = Object.keys(envelope).filter(
    (key) => !["type", "idempotencyKey", "payload"].includes(key),
  );
  if (extra.length > 0)
    throw new EventRefusedError(
      "invalid_envelope",
      `unknown keys ${extra.sort().join(", ")}`,
    );
  const { type, idempotencyKey } = envelope;
  if (
    typeof idempotencyKey !== "string" ||
    idempotencyKey.trim() === "" ||
    idempotencyKey.length > idempotencyKeyLimit
  )
    throw new EventRefusedError(
      "invalid_envelope",
      "idempotencyKey must be a non-empty string",
    );
  if (typeof type !== "string" || !Object.hasOwn(eventPayloadSchemas, type))
    throw new EventRefusedError("unknown_event_type", "type is not in catalog");
  const schema = eventPayloadSchemas[type as EventType];
  const parsed = schema.safeParse(envelope.payload);
  if (!parsed.success)
    throw new EventRefusedError(
      "invalid_payload",
      `${type} ${parsed.error.issues
        .map((issue) =>
          [
            issue.code,
            issue.path.join("."),
            ...("keys" in issue ? issue.keys : []),
          ]
            .filter(Boolean)
            .join(" "),
        )
        .join("; ")}`,
    );
  return { type, idempotencyKey, payload: parsed.data } as EventInput;
}

async function insertOutbox(session: SqlSession, event: Event): Promise<void> {
  // Idempotent: a repeated key keeps the first row, as the snapshot trigger does.
  await session.query(
    `INSERT INTO plugin_event_outbox
       (event_id, event_type, idempotency_key, emitted_by, emitted_at, payload)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)
     ON CONFLICT (idempotency_key) DO NOTHING`,
    [
      event.id,
      event.type,
      event.idempotencyKey,
      event.emittedBy,
      event.emittedAt,
      JSON.stringify(event.payload),
    ],
  );
}

/** A savepoint keeps a failed insert from aborting the caller's transaction. */
async function insertInTransaction(
  session: SqlSession,
  event: Event,
): Promise<void> {
  await session.exec("SAVEPOINT plugin_event_emit");
  try {
    await insertOutbox(session, event);
  } catch (error) {
    await session.exec("ROLLBACK TO SAVEPOINT plugin_event_emit");
    await session.exec("RELEASE SAVEPOINT plugin_event_emit");
    throw error;
  }
  await session.exec("RELEASE SAVEPOINT plugin_event_emit");
}

type Outcome = "ok" | "timeout";

/** Resolve after the handler settles or the bound passes, whichever comes first. */
function bounded(
  entry: Subscription,
  event: Event,
  timeoutMs: number,
): Promise<Outcome> {
  return new Promise<Outcome>((resolve, reject) => {
    const timer = setTimeout(() => resolve("timeout"), timeoutMs);
    timer.unref?.();
    // Each handler gets its own copy, so one cannot change what another sees.
    // Handlers run outside the emitter's transaction, so a late one cannot write into it.
    sessions
      .exit(() =>
        Promise.resolve().then(() => entry.handler(structuredClone(event))),
      )
      .then(
        () => {
          clearTimeout(timer);
          resolve("ok");
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error instanceof Error ? error : new Error("handler failed"));
        },
      );
  });
}

export function createEventBus(options: EventBusOptions): EventBus {
  const log = options.log ?? defaultLog;
  const timeoutMs = options.timeoutMs ?? HANDLER_TIMEOUT_MS;
  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? randomUUID;
  const subscriptions: Subscription[] = [];

  async function fanOut(event: Event): Promise<void> {
    const handlers = subscriptions.filter(
      (entry) => !entry.durable && entry.type === event.type,
    );
    if (handlers.length === 0) return;
    const outcomes = await Promise.allSettled(
      handlers.map((entry) => bounded(entry, event, timeoutMs)),
    );
    outcomes.forEach((outcome, index) => {
      const subscriber = handlers[index]!.subscriber;
      if (outcome.status === "rejected")
        log({
          event: "handler_failed",
          event_type: event.type,
          subscriber,
          error_class: errorClass(outcome.reason),
        });
      else if (outcome.value === "timeout")
        log({
          event: "handler_timeout",
          event_type: event.type,
          subscriber,
          timeout_ms: timeoutMs,
        });
    });
  }

  async function writeOutbox(
    event: Event,
    session: SqlSession | undefined,
  ): Promise<void> {
    try {
      if (session) await insertInTransaction(session, event);
      else await options.db.transaction((own) => insertOutbox(own, event));
    } catch (error) {
      log({
        event: "outbox_insert_failed",
        event_type: event.type,
        in_transaction: session !== undefined,
        error_class: errorClass(error),
      });
    }
  }

  async function emit(
    emitter: Emitter,
    input: unknown,
    emitOptions: EmitOptions = {},
  ): Promise<Event> {
    if (
      emitter.kind === "plugin" &&
      !emitter.manifest.capabilities?.writes?.includes("events")
    )
      throw new EventRefusedError(
        "missing_capability",
        `${emitter.manifest.name} needs capabilities.writes ["events"]`,
      );
    const valid = validate(input);
    const event = {
      ...valid,
      id: newId(),
      emittedAt: now().toISOString(),
      emittedBy: emitterName(emitter),
    } as Event;
    await fanOut(event);
    await writeOutbox(event, emitOptions.session ?? sessions.getStore());
    return event;
  }

  function on(
    type: unknown,
    handler: unknown,
    subscription: { durable: boolean; subscriber: string },
  ): void {
    if (typeof type !== "string" || !Object.hasOwn(eventPayloadSchemas, type))
      throw new EventRefusedError(
        "unknown_event_type",
        "type is not in catalog",
      );
    if (typeof handler !== "function")
      throw new EventRefusedError(
        "invalid_subscription",
        "handler is required",
      );
    const { durable, subscriber } = subscription;
    if (typeof durable !== "boolean" || !subscriberName.test(subscriber))
      throw new EventRefusedError(
        "invalid_subscription",
        "durable and subscriber are required",
      );
    if (
      subscriptions.some(
        (entry) => entry.type === type && entry.subscriber === subscriber,
      )
    )
      throw new EventRefusedError(
        "invalid_subscription",
        `${subscriber} already subscribes to ${type}`,
      );
    subscriptions.push({
      type: type as EventType,
      subscriber,
      durable,
      handler: handler as Subscription["handler"],
    });
  }

  for (const entry of options.subscriptions ?? [])
    on(entry.type, entry.handler, entry);

  return {
    registry: (emitter) => ({
      on: (type, handler, subscription) => on(type, handler, subscription),
      emit: async (event, emitOptions) => {
        await emit(emitter, event, emitOptions);
      },
    }),
    transaction: (run) =>
      options.db.transaction((session) =>
        withEventSession(session, () => run(session)),
      ),
    durableSubscribers: () =>
      subscriptions
        .filter((entry) => entry.durable)
        .map((entry) => ({ ...entry })),
  };
}
