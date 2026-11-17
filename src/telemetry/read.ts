import type { OperatorHost } from "@openplans/plugin-sdk";
import type { Aggregate } from "./aggregate.js";
import type { TelemetryFlusher } from "./flush.js";
import { readStored } from "./storage.js";

export function currentReader(
  aggregate: Aggregate,
  flusher?: TelemetryFlusher,
  now: () => number = Date.now,
): NonNullable<OperatorHost["telemetry"]> {
  return {
    async read(input, scope) {
      const time = now();
      const observedAt = new Date(time).toISOString();
      if (scope.signal.aborted)
        return { state: "unavailable", reason: "deadline", observedAt };
      if (input.window === "current_process")
        return {
          state: "available",
          value: { ...aggregate.snapshot(), ...flusher?.health() },
          observedAt,
        };
      if (!flusher)
        return { state: "unavailable", reason: "not_collected", observedAt };
      try {
        const { rows, meta } = await readStored(scope.db, time, input.window);
        scope.signal.throwIfAborted();
        if (!rows.length)
          return { state: "unavailable", reason: "not_collected", observedAt };
        const health = flusher.health();
        for (const row of rows) {
          if (
            [Number(row.count), ...row.buckets.map(Number)].some(
              (value) => !Number.isSafeInteger(value) || value < 0,
            )
          )
            throw new Error("Telemetry count overflow");
        }
        return {
          state: "available",
          observedAt,
          value: {
            collection: "partial",
            since: new Date(meta.since).toISOString(),
            until: observedAt,
            drops: Number(meta.drops),
            series: rows.slice(0, 128).map((row) => ({
              transport: row.transport,
              operation: row.operation,
              owner: row.owner,
              outcome: row.outcome,
              statusClass: row.status_class,
              count: Number(row.count),
              durationBuckets: row.buckets.map(Number),
            })),
            ...health,
            lastFlush: new Date(meta.last_flush).toISOString(),
            granularity: input.window === "90d" ? "1h" : "5m",
            truncated: rows.length > 128,
            instanceCoverage: "unknown",
            observedInstances: Number(meta.instances),
            crashLoss: "unflushed samples may be lost",
            gaps:
              meta.gap ||
              time - new Date(meta.last_flush).getTime() > 10 * 60_000 ||
              health.failed ||
              health.droppedBuckets > 0,
          },
        };
      } catch {
        return {
          state: "unavailable",
          reason: scope.signal.aborted ? "deadline" : "read_failed",
          observedAt,
        };
      }
    },
  };
}
