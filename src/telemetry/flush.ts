import { randomUUID } from "node:crypto";
import type { Database, SqlSession } from "../db/database.js";
import type { Aggregate, CurrentTelemetry } from "./aggregate.js";
import { BUCKET_MS } from "./aggregate.js";
import {
  PENDING_BUCKET_CAP,
  STORAGE_CAP_BYTES,
  SEVEN_DAYS,
} from "./retention.js";
import { trimStorage, writeSnapshot } from "./storage.js";

export function createFlusher(
  db: Database,
  aggregate: Aggregate,
  options: {
    now?: () => number;
    bootId?: string;
    capBytes?: number;
  } = {},
) {
  const now = options.now ?? Date.now;
  const bootId = options.bootId ?? randomUUID();
  const pending = new Map<string, CurrentTelemetry>();
  let running: Promise<void> | undefined;
  let lastFlush: string | null = null;
  let failed = false;
  let droppedBuckets = 0;
  const enqueue = (snapshot: CurrentTelemetry) => {
    if (!snapshot.series.length || !snapshot.since) return;
    pending.set(snapshot.since, snapshot);
    while (pending.size > PENDING_BUCKET_CAP) {
      pending.delete(pending.keys().next().value!);
      droppedBuckets++;
    }
  };
  aggregate.onRollover = enqueue;
  return {
    bootId,
    health: () => ({
      lastFlush,
      failed,
      droppedBuckets,
      pendingBuckets: pending.size,
    }),
    detach() {
      aggregate.onRollover = undefined;
    },
    flush(): Promise<void> {
      enqueue(aggregate.snapshot());
      if (running) return running;
      const time = now();
      for (const key of pending.keys()) {
        if (time - Date.parse(key) > SEVEN_DAYS) {
          pending.delete(key);
          droppedBuckets++;
        }
      }
      const batch = [...pending.entries()];
      const gap =
        failed ||
        droppedBuckets > 0 ||
        (lastFlush !== null && time - Date.parse(lastFlush) > 2 * BUCKET_MS);
      const write = async (tx: SqlSession) => {
        await tx.exec(
          "SET LOCAL statement_timeout = '4s'; SET LOCAL lock_timeout = '250ms'",
        );
        const lock = await tx.query<{ locked: boolean }>(
          "SELECT pg_try_advisory_xact_lock(17012026,12) AS locked",
        );
        if (!lock.rows[0]?.locked) throw new Error("Telemetry writer busy");
        for (const [, snapshot] of batch)
          await writeSnapshot(tx, bootId, snapshot, time, gap);
        return trimStorage(tx, time, options.capBytes ?? STORAGE_CAP_BYTES);
      };
      running = (async () => {
        try {
          const reset = db.withRequest
            ? await db.withRequest(AbortSignal.timeout(5000), write, {
                readOnly: false,
              })
            : await db.transaction(write);
          if (reset) droppedBuckets += batch.length;
          for (const [key, snapshot] of batch)
            if (pending.get(key) === snapshot) pending.delete(key);
          lastFlush = new Date(time).toISOString();
          failed = false;
        } catch (error) {
          failed = true;
          throw error;
        } finally {
          running = undefined;
        }
      })();
      return running;
    },
  };
}
export type TelemetryFlusher = ReturnType<typeof createFlusher>;
