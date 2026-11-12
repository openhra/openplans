import type { Database, SqlSession } from "@openplans/plugin-sdk";
import { createEventBus, HANDLER_TIMEOUT_MS } from "../events.js";
import type { EventBus, EventBusOptions, EventLog } from "../events.js";

export { checkEventPayloads } from "./checks.js";

export interface OutboxRow extends Record<string, unknown> {
  event_id: string;
  event_type: string;
  idempotency_key: string;
  emitted_by: string;
  payload: unknown;
}

/** A real bus over a migrated test database, with its log lines kept for assertions. */
export function testEventBus(
  db: Database,
  options: Omit<EventBusOptions, "db" | "log"> = {},
): {
  bus: EventBus;
  logs: Parameters<EventLog>[0][];
  timeoutMs: number;
} {
  const logs: Parameters<EventLog>[0][] = [];
  const timeoutMs = options.timeoutMs ?? HANDLER_TIMEOUT_MS;
  const bus = createEventBus({
    ...options,
    db,
    timeoutMs,
    log: (entry) => {
      logs.push(entry);
    },
  });
  return { bus, logs, timeoutMs };
}

/** Outbox rows in emit order, without the timestamp column. */
export async function readOutbox(db: SqlSession): Promise<OutboxRow[]> {
  const { rows } = await db.query<OutboxRow>(
    `SELECT event_id, event_type, idempotency_key, emitted_by, payload
       FROM plugin_event_outbox ORDER BY emitted_at, idempotency_key`,
  );
  return rows;
}
